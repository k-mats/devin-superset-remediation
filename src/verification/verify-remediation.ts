import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { GitHubClient } from '../github/client.js';
import type { Attempt, Task, Verification } from '../db/schema.js';
import { getDb } from '../db/client.js';
import {
  approveVerificationSpec,
  completeAttempt,
  findLatestVerification,
  getAttempt,
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
  github: Pick<GitHubClient, 'getIssue' | 'listCheckRuns' | 'getCombinedStatus'>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
  workspaceRoot: string;
  commandTimeoutMs: number;
  setupTimeoutMs: number;
  checkoutTimeoutMs: number;
  maxOutputBytes: number;
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
  return summary.length > maxBytes ? summary.slice(-maxBytes) : summary;
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
      'GitHub checks lookup failed; skipping check evaluation'
    );
  }

  const latestCommand = findLatestVerification(attempt.id, headSha, 'command', db);
  if (latestCommand && (latestCommand.status === 'passed' || latestCommand.status === 'failed')) {
    return decisionFor(latestCommand.status);
  }

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
  if (issueSpec.ok) {
    setVerificationCandidate(attempt.id, issueSpec.spec, 'issue_verification_section', db);
    let current = getAttempt(attempt.id, db);
    if (current && current.verificationApprovedSha256 === null) {
      approveVerificationSpec(attempt.id, issueSpec.spec.sha256, 'issue_verification_section', db);
      current = getAttempt(attempt.id, db);
    }
    attempt = current ?? attempt;
  } else {
    attempt = getAttempt(attempt.id, db) ?? attempt;
    if (attempt.verificationCandidateSha256 === null) {
      const commands = (attempt.agentTestsRun ?? [])
        .map((entry) => entry.command)
        .filter((command) => command.trim() !== '');
      if (commands.length > 0) {
        const script = commands.join('\n');
        const spec: VerificationSpec = {
          shell: 'sh',
          script,
          sha256: hashVerificationSpec('sh', script),
        };
        attempt = setVerificationCandidate(attempt.id, spec, 'agent_tests_run', db);
      }
    }
  }

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

  const workspaceDir = path.join(
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

  const summary = boundSummary(
    `$ ${approved.script}\nadapter=${adapter.name} setup_ms=${String(setupDurationMs)}\nexit_code=${String(result.exitCode)}\n${result.output}`,
    opts.maxOutputBytes
  );
  const row = recordVerification(
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
    db
  );
  logRow(opts.logger, row);

  if (result.status === 'passed') {
    completeAttempt(
      attempt.id,
      'succeeded',
      { reason: `independent_verification_passed: ${headSha}` },
      db
    );
  }
  return decisionFor(result.status);
}
