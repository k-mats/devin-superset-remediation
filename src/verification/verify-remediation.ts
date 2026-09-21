import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { derivePrState, type GitHubClient } from '../github/client.js';
import type { Attempt, Task, Verification } from '../db/schema.js';
import { getDb } from '../db/client.js';
import {
  clearVerificationCandidate,
  completeVerifiedAttempt,
  findLatestVerification,
  getAttempt,
  recordPullRequest,
  recordVerification,
  setVerificationCandidate,
  type Db,
} from '../db/task-state.js';
import { approvedSpec, approvalStatus } from './approval.js';
import { checkoutExactSha } from './git-workspace.js';
import { evaluateGitHubChecks, pullRequestChecksUrl } from './github-checks.js';
import { resolveSetupAdapter, SetupError } from './repo-setup.js';
import { baseEnv, runVerificationCommand, type VerificationWorkspace } from './runner.js';
import { hashVerificationSpec, parseVerificationSpec, type VerificationSpec } from './spec.js';

export type RemediationVerificationDecision =
  | 'verification_passed'
  | 'verification_failed'
  | 'verification_unverified'
  | 'verification_error'
  | 'verification_skipped';

export interface VerifyRemediationOptions {
  github: Pick<GitHubClient, 'getIssue' | 'getPullRequest' | 'listCheckRuns' | 'getCombinedStatus'>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
  workspaceRoot: string;
  commandTimeoutMs: number;
  setupTimeoutMs: number;
  checkoutTimeoutMs: number;
  maxOutputBytes: number;
  /** Re-execute the approved spec even if a passed/failed row already exists for this head. */
  rerun?: boolean;
  runCommand?: typeof runVerificationCommand;
  checkout?: typeof checkoutExactSha;
  resolveAdapter?: typeof resolveSetupAdapter;
}

function logRow(logger: VerifyRemediationOptions['logger'], row: Verification): void {
  logger.info(
    {
      attempt_id: row.attemptId,
      head_sha: row.headSha,
      kind: row.kind,
      status: row.status,
      reason: row.reason,
      verification_id: row.id,
    },
    'Recorded remediation verification'
  );
}

function decisionFor(status: Verification['status']): RemediationVerificationDecision {
  switch (status) {
    case 'passed':
      return 'verification_passed';
    case 'failed':
      return 'verification_failed';
    case 'unverified':
      return 'verification_unverified';
    case 'error':
      return 'verification_error';
  }
}

function boundSummary(summary: string, maxBytes: number): string {
  const bytes = Buffer.from(summary, 'utf8');
  if (bytes.length <= maxBytes) return summary;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes.readUInt8(start) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

export async function verifyRemediationOnce(
  attempt: Attempt,
  task: Task,
  opts: VerifyRemediationOptions
): Promise<RemediationVerificationDecision> {
  const db = opts.db ?? getDb();
  const runCommand = opts.runCommand ?? runVerificationCommand;
  const checkout = opts.checkout ?? checkoutExactSha;
  const resolveAdapter = opts.resolveAdapter ?? resolveSetupAdapter;

  if (attempt.state !== 'verifying' || attempt.prHeadSha === null || attempt.prNumber === null) {
    return 'verification_skipped';
  }
  const headSha = attempt.prHeadSha;
  const prNumber = attempt.prNumber;

  try {
    const checkRuns = await opts.github.listCheckRuns(task.repoOwner, task.repoName, headSha);
    const combined = await opts.github.getCombinedStatus(task.repoOwner, task.repoName, headSha);
    const evaluation = evaluateGitHubChecks(checkRuns, combined);
    const latest = findLatestVerification(attempt.id, headSha, 'github_checks', db);
    if (
      !latest ||
      latest.status !== evaluation.status ||
      (latest.reason ?? null) !== (evaluation.reason ?? null)
    ) {
      logRow(
        opts.logger,
        recordVerification(
          {
            attemptId: attempt.id,
            headSha,
            kind: 'github_checks',
            status: evaluation.status,
            reason: evaluation.reason ?? null,
            evidenceUrl: pullRequestChecksUrl(task.repoOwner, task.repoName, attempt.prNumber),
            evidenceSummary: boundSummary(evaluation.summary, opts.maxOutputBytes),
          },
          db
        )
      );
    }
  } catch (error: unknown) {
    opts.logger.warn(
      { err: error, attempt_id: attempt.id, head_sha: headSha },
      'GitHub checks lookup failed; recording an error row'
    );
    const latest = findLatestVerification(attempt.id, headSha, 'github_checks', db);
    if (latest?.status !== 'error' || latest.reason !== 'checks_lookup_failed') {
      logRow(
        opts.logger,
        recordVerification(
          {
            attemptId: attempt.id,
            headSha,
            kind: 'github_checks',
            status: 'error',
            reason: 'checks_lookup_failed',
            evidenceUrl: pullRequestChecksUrl(task.repoOwner, task.repoName, prNumber),
            evidenceSummary: boundSummary(
              error instanceof Error ? error.message : String(error),
              opts.maxOutputBytes
            ),
          },
          db
        )
      );
    }
  }

  const latestCommand = findLatestVerification(attempt.id, headSha, 'command', db);

  let issueBody: string | null | undefined;
  try {
    const issue = await opts.github.getIssue(task.repoOwner, task.repoName, task.issueNumber);
    issueBody = issue.body;
  } catch (error: unknown) {
    opts.logger.warn(
      { err: error, attempt_id: attempt.id, issue_number: task.issueNumber },
      'Issue lookup failed; deferring verification until the next poll'
    );
    return 'verification_skipped';
  }

  const issueSpec = parseVerificationSpec(issueBody);
  attempt = db.transaction((tx) => {
    let fresh = getAttempt(attempt.id, tx) ?? attempt;
    if (issueSpec.ok) {
      if (
        fresh.verificationCandidateSource !== 'operator' &&
        fresh.verificationCandidateSha256 !== issueSpec.spec.sha256
      ) {
        fresh = setVerificationCandidate(
          attempt.id,
          issueSpec.spec,
          'issue_verification_section',
          tx
        );
      }
      return fresh;
    }
    fresh = clearVerificationCandidate(
      attempt.id,
      { onlySource: 'issue_verification_section' },
      tx
    );
    if (fresh.verificationCandidateSha256 === null) {
      const commands = (fresh.agentTestsRun ?? [])
        .map((entry) => entry.command)
        .filter((command) => command.trim() !== '');
      if (commands.length > 0) {
        const script = commands.join('\n');
        const spec: VerificationSpec = {
          shell: 'sh',
          script,
          sha256: hashVerificationSpec('sh', script),
        };
        fresh = setVerificationCandidate(attempt.id, spec, 'agent_tests_run', tx);
      }
    }
    return fresh;
  });

  const status = approvalStatus(attempt);
  if (status === 'no_candidate') {
    if (
      latestCommand?.status === 'unverified' &&
      latestCommand.reason === 'no_approved_verification_spec'
    ) {
      return 'verification_unverified';
    }
    logRow(
      opts.logger,
      recordVerification(
        {
          attemptId: attempt.id,
          headSha,
          kind: 'command',
          status: 'unverified',
          reason: 'no_approved_verification_spec',
        },
        db
      )
    );
    return 'verification_unverified';
  }

  if (status === 'pending_approval') {
    const summary = `candidate_sha256=${attempt.verificationCandidateSha256 ?? ''} source=${attempt.verificationCandidateSource ?? ''}`;
    if (
      latestCommand?.status === 'unverified' &&
      latestCommand.reason === 'verification_spec_pending_approval' &&
      latestCommand.evidenceSummary === summary
    ) {
      return 'verification_unverified';
    }
    logRow(
      opts.logger,
      recordVerification(
        {
          attemptId: attempt.id,
          headSha,
          kind: 'command',
          status: 'unverified',
          reason: 'verification_spec_pending_approval',
          evidenceSummary: summary,
        },
        db
      )
    );
    return 'verification_unverified';
  }

  const approved = approvedSpec(attempt);
  if (!approved) {
    return 'verification_skipped';
  }
  if (
    !opts.rerun &&
    latestCommand &&
    (latestCommand.status === 'passed' || latestCommand.status === 'failed') &&
    latestCommand.specSha256 === approved.sha256
  ) {
    if (latestCommand.status === 'passed') {
      const specSha = latestCommand.specSha256;
      db.transaction((tx) => {
        const fresh = getAttempt(attempt.id, tx);
        if (
          fresh?.state === 'verifying' &&
          fresh.prHeadSha === headSha &&
          fresh.verificationCandidateSha256 === specSha &&
          fresh.verificationApprovedSha256 === specSha
        ) {
          completeVerifiedAttempt(attempt.id, { headSha, specSha256: specSha }, tx);
        }
      });
    }
    return decisionFor(latestCommand.status);
  }

  const workspaceDir = path.resolve(
    opts.workspaceRoot,
    `${task.repoOwner.toLowerCase()}__${task.repoName.toLowerCase()}`
  );
  const cloneUrl = `https://github.com/${task.repoOwner}/${task.repoName}.git`;

  try {
    await checkout({
      cloneUrl,
      headSha,
      workspaceDir,
      timeoutMs: opts.checkoutTimeoutMs,
      logger: opts.logger,
    });
  } catch (error: unknown) {
    logRow(
      opts.logger,
      recordVerification(
        {
          attemptId: attempt.id,
          headSha,
          kind: 'command',
          status: 'error',
          reason: 'checkout_failed',
          evidenceSummary: boundSummary(
            error instanceof Error ? error.message : String(error),
            opts.maxOutputBytes
          ),
        },
        db
      )
    );
    return 'verification_error';
  }

  const adapter = resolveAdapter(task);
  const env = { ...baseEnv() };
  const setupStartedAt = Date.now();
  try {
    Object.assign(
      env,
      await adapter.setup(
        { cwd: workspaceDir },
        { timeoutMs: opts.setupTimeoutMs, logger: opts.logger }
      )
    );
  } catch (error: unknown) {
    logRow(
      opts.logger,
      recordVerification(
        {
          attemptId: attempt.id,
          headSha,
          kind: 'command',
          status: 'error',
          reason: error instanceof SetupError ? error.reason : 'setup_failed',
          evidenceSummary: boundSummary(
            `adapter=${adapter.name}\n${error instanceof Error ? error.message : String(error)}`,
            opts.maxOutputBytes
          ),
        },
        db
      )
    );
    return 'verification_error';
  }
  const setupDurationMs = Date.now() - setupStartedAt;

  const workspace: VerificationWorkspace = { cwd: workspaceDir, env };
  const result = await runCommand(approved, workspace, {
    timeoutMs: opts.commandTimeoutMs,
    maxOutputBytes: opts.maxOutputBytes,
  });

  let headStillCurrent = result.status === 'passed';
  if (result.status === 'passed') {
    try {
      const pr = await opts.github.getPullRequest(task.repoOwner, task.repoName, prNumber);
      if (pr.head.sha !== headSha) {
        headStillCurrent = false;
        recordPullRequest(
          attempt.id,
          {
            prUrl: pr.html_url,
            prNumber: pr.number,
            prState: derivePrState(pr),
            prHeadSha: pr.head.sha,
          },
          db
        );
        opts.logger.warn(
          { attempt_id: attempt.id, verified_head_sha: headSha, current_head_sha: pr.head.sha },
          'Pull request head changed during verification; deferring completion to the next poll'
        );
      }
    } catch (error: unknown) {
      headStillCurrent = false;
      opts.logger.warn(
        { err: error, attempt_id: attempt.id, head_sha: headSha },
        'Pull request re-check failed after a passing verification; deferring completion to the next poll'
      );
    }
  }

  const summary = boundSummary(
    `$ ${approved.script}\nadapter=${adapter.name} setup_ms=${String(setupDurationMs)}\nexit_code=${String(result.exitCode)}\n${result.output}`,
    opts.maxOutputBytes
  );
  const completeHead = headStillCurrent;
  const row = db.transaction((tx) => {
    const recorded = recordVerification(
      {
        attemptId: attempt.id,
        headSha,
        kind: 'command',
        status: result.status,
        reason: result.reason ?? null,
        specShell: approved.shell,
        specScript: approved.script,
        specSha256: approved.sha256,
        exitCode: result.exitCode,
        evidenceSummary: summary,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      },
      tx
    );
    const fresh = getAttempt(attempt.id, tx);
    if (
      result.status === 'passed' &&
      completeHead &&
      fresh?.state === 'verifying' &&
      fresh.prHeadSha === headSha &&
      fresh.verificationCandidateSha256 === approved.sha256 &&
      fresh.verificationApprovedSha256 === approved.sha256
    ) {
      completeVerifiedAttempt(attempt.id, { headSha, specSha256: approved.sha256 }, tx);
    } else if (result.status === 'passed' && completeHead) {
      opts.logger.warn(
        { attempt_id: attempt.id, head_sha: headSha, spec_sha256: approved.sha256 },
        'Verification spec superseded during run; not completing'
      );
    }
    return recorded;
  });
  logRow(opts.logger, row);

  return decisionFor(result.status);
}
