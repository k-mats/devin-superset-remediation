import type { FastifyBaseLogger } from 'fastify';
import type { DevinClient, SessionResponse } from '../devin/client.js';
import { GitHubApiError } from '../github/client.js';
import type { GitHubClient, GitHubIssue } from '../github/client.js';
import { getDb } from '../db/client.js';
import type { Attempt, Task } from '../db/schema.js';
import {
  approveVerificationSpec,
  claimAttemptForDispatch,
  completeAttempt,
  findPendingAttempts,
  markSessionCreated,
  releaseDispatchClaim,
  setVerificationCandidate,
  type Db,
} from '../db/task-state.js';
import { isEligibleIssue } from '../intake/github-intake.js';
import { structuredOutputJsonSchema } from '../devin/structured-output.js';
import { parseVerificationSpec } from '../verification/spec.js';

export type DispatchDecision =
  | 'dispatched'
  | 'claim_lost'
  | 'cancelled_ineligible'
  | 'failed_eligibility_check'
  | 'eligibility_check_deferred'
  | 'session_create_failed'
  | 'session_persist_failed';

export interface DispatchResult {
  pending: number;
  dispatched: number;
  claimLost: number;
  cancelled: number;
  deferred: number;
  failed: number;
}

export interface DevinDispatcherOptions {
  github: Pick<GitHubClient, 'getIssue'>;
  devin: Pick<DevinClient, 'createSession'>;
  label: string;
  maxAcuPerSession: number;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
}

const MAX_TITLE_LENGTH = 120;

// GitHub 4xx are terminal except 429 and 403 rate limits (signalled via
// X-RateLimit-Remaining: 0 or Retry-After).
function isTerminalEligibilityError(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !error.rateLimited
  );
}

export function buildSessionTags(task: Task, attempt: Attempt): string[] {
  return [
    'devin-superset-remediation',
    `task:${String(task.id)}`,
    `attempt:${String(attempt.id)}`,
    `correlation:${attempt.correlationId}`,
    `issue:${task.repoOwner}/${task.repoName}#${String(task.issueNumber)}`,
  ];
}

export function buildSessionPrompt(task: Task, issue: GitHubIssue, attempt: Attempt): string {
  return `You are remediating a GitHub issue in the Apache Superset fork \`${task.repoOwner}/${task.repoName}\` (https://github.com/${task.repoOwner}/${task.repoName}).

Issue: ${issue.html_url}
Title: ${issue.title}

Issue description:
${issue.body || '(no description)'}

Objective: diagnose the root cause described in the issue and implement a minimal, well-tested fix in this fork. Follow the repository's contribution conventions, run the relevant tests, and open a pull request against the fork's default branch that references the issue (e.g. "Fixes #${String(task.issueNumber)}"). Do not merge the pull request. If the issue cannot or should not be fixed as described, do not make speculative changes; explain why and stop.

Task correlation id: ${attempt.correlationId}

Structured output: you MUST finish this session by providing structured output matching the provided schema (schema_version: 1). Use outcome "remediated" only when you opened a pull request (set pr_url to the PR URL); use outcome "needs_human" with a non-empty needs_human_reason when a human decision is required; use outcome "no_action" (pr_url null) when the issue should not be acted on. Set tests_run to only the tests you actually executed in this session (empty array if none), diagnosis to a root-cause summary, and risks to any known risks or follow-ups (empty array if none).`;
}

export async function dispatchAttempt(
  attempt: Attempt,
  task: Task,
  opts: DevinDispatcherOptions
): Promise<DispatchDecision> {
  const db = opts.db ?? getDb();
  const claimed = claimAttemptForDispatch(attempt.id, db);
  if (!claimed) {
    opts.logger.info(
      { attempt_id: attempt.id, correlation_id: attempt.correlationId, reason: 'claim_lost' },
      'Skipped dispatch; attempt already claimed'
    );
    return 'claim_lost';
  }

  let issue: GitHubIssue;
  try {
    issue = await opts.github.getIssue(task.repoOwner, task.repoName, task.issueNumber);
  } catch (error: unknown) {
    if (isTerminalEligibilityError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      opts.logger.error(
        { err: error, attempt_id: attempt.id, correlation_id: attempt.correlationId },
        'Failed to revalidate issue eligibility before dispatch'
      );
      completeAttempt(attempt.id, 'failed', { reason: `eligibility_check_failed: ${message}` }, db);
      return 'failed_eligibility_check';
    }
    releaseDispatchClaim(attempt.id, db);
    opts.logger.warn(
      {
        err: error,
        attempt_id: attempt.id,
        correlation_id: attempt.correlationId,
        reason: 'eligibility_check_deferred',
      },
      'Released dispatch claim; eligibility check failed transiently and will be retried on the next poll'
    );
    return 'eligibility_check_deferred';
  }

  if (!isEligibleIssue(issue, opts.label)) {
    const reason = issue.pull_request
      ? 'is_pull_request'
      : issue.state !== 'open'
        ? 'issue_closed'
        : 'label_missing';
    completeAttempt(attempt.id, 'cancelled', { reason }, db);
    opts.logger.info(
      { attempt_id: attempt.id, correlation_id: attempt.correlationId, reason },
      'Cancelled dispatch; issue is no longer eligible'
    );
    return 'cancelled_ineligible';
  }

  const title = `Remediate ${task.repoOwner}/${task.repoName}#${String(task.issueNumber)}: ${issue.title}`;
  let session: SessionResponse;
  try {
    session = await opts.devin.createSession({
      prompt: buildSessionPrompt(task, issue, claimed),
      title: title.slice(0, MAX_TITLE_LENGTH),
      tags: buildSessionTags(task, claimed),
      max_acu_limit: opts.maxAcuPerSession,
      structured_output_schema: structuredOutputJsonSchema,
      structured_output_required: true,
    });
  } catch (error: unknown) {
    // A session may have been created server-side; leave the attempt in
    // 'dispatching' for the Issue #20 reconciliation pass to recover.
    opts.logger.error(
      { err: error, attempt_id: attempt.id, correlation_id: attempt.correlationId },
      'Devin session creation failed; attempt left in dispatching state'
    );
    return 'session_create_failed';
  }

  const specResult = parseVerificationSpec(issue.body);
  try {
    db.transaction((tx) => {
      markSessionCreated(
        attempt.id,
        { devinSessionId: session.session_id, devinSessionUrl: session.url },
        tx
      );
      if (specResult.ok) {
        setVerificationCandidate(attempt.id, specResult.spec, 'issue_verification_section', tx);
        approveVerificationSpec(
          attempt.id,
          specResult.spec.sha256,
          'issue_verification_section',
          tx
        );
      }
    });
  } catch (error: unknown) {
    // The session exists server-side; keep the id in the log so the Issue #20
    // reconciliation pass can recover this dispatching attempt.
    opts.logger.error(
      {
        err: error,
        attempt_id: attempt.id,
        correlation_id: attempt.correlationId,
        devin_session_id: session.session_id,
        url: session.url,
        reason: 'session_persist_failed',
      },
      'Devin session created but could not be persisted; attempt left in dispatching for reconciliation'
    );
    return 'session_persist_failed';
  }

  opts.logger.info(
    {
      attempt_id: attempt.id,
      correlation_id: attempt.correlationId,
      devin_session_id: session.session_id,
      url: session.url,
    },
    'Created Devin session'
  );
  return 'dispatched';
}

export async function runDispatchOnce(opts: DevinDispatcherOptions): Promise<DispatchResult> {
  const db = opts.db ?? getDb();
  const rows = findPendingAttempts(db);
  const result: DispatchResult = {
    pending: rows.length,
    dispatched: 0,
    claimLost: 0,
    cancelled: 0,
    deferred: 0,
    failed: 0,
  };

  for (const { attempt, task } of rows) {
    let decision: DispatchDecision;
    try {
      decision = await dispatchAttempt(attempt, task, opts);
    } catch (error: unknown) {
      opts.logger.error(
        { err: error, attempt_id: attempt.id, correlation_id: attempt.correlationId },
        'Dispatch attempt failed unexpectedly'
      );
      result.failed += 1;
      continue;
    }
    if (decision === 'dispatched') result.dispatched += 1;
    else if (decision === 'claim_lost') result.claimLost += 1;
    else if (decision === 'cancelled_ineligible') result.cancelled += 1;
    else if (decision === 'eligibility_check_deferred') result.deferred += 1;
    else result.failed += 1;
  }

  opts.logger.info(
    {
      pending: result.pending,
      dispatched: result.dispatched,
      claimLost: result.claimLost,
      cancelled: result.cancelled,
      deferred: result.deferred,
      failed: result.failed,
    },
    'Devin dispatch completed'
  );
  return result;
}

export function startDispatchPoller(opts: DevinDispatcherOptions & { intervalMs: number }): {
  stop(): Promise<void>;
} {
  let inFlight = false;
  let stopped = false;
  let current: Promise<void> | undefined;

  const run = () => {
    if (stopped) return;
    if (inFlight) {
      opts.logger.debug('Skipping Devin dispatch poll while previous run is in flight');
      return;
    }
    inFlight = true;
    current = runDispatchOnce(opts)
      .then(() => undefined)
      .catch((error: unknown) => {
        opts.logger.error({ err: error }, 'Devin dispatch run failed unexpectedly');
      })
      .finally(() => {
        inFlight = false;
        current = undefined;
      });
  };

  run();
  const interval = setInterval(() => {
    run();
  }, opts.intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await current;
    },
  };
}
