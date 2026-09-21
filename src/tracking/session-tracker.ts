import type { FastifyBaseLogger } from 'fastify';
import type { DevinClient, SessionResponse } from '../devin/client.js';
import type { GitHubClient } from '../github/client.js';
import { derivePrState, GitHubApiError } from '../github/client.js';
import { getDb } from '../db/client.js';
import type { Attempt, Task } from '../db/schema.js';
import {
  completeAttempt,
  findCompletedAttemptsWithTrackedPullRequests,
  findTrackableAttempts,
  getAttempt,
  markRunning,
  markVerifying,
  recordPullRequest,
  recordSessionSnapshot,
  type Db,
} from '../db/task-state.js';
import { collectStructuredOutput } from '../outcome/collect-structured-output.js';
import { verifyAgentPullRequest } from '../outcome/verify-pull-request.js';
import {
  verifyRemediationOnce,
  type VerifyRemediationOptions,
} from '../verification/verify-remediation.js';
import { projectTaskState } from './normalized-task-state.js';

export type TrackingDecision =
  | 'snapshot_only'
  | 'marked_running'
  | 'output_collected'
  | 'escalated'
  | 'completed_no_action'
  | 'verifying'
  | 'pr_refreshed'
  | 'pr_lookup_deferred'
  | 'verification_passed'
  | 'verification_failed'
  | 'verification_unverified'
  | 'verification_error'
  | 'verification_skipped'
  | 'failed';

export interface TrackingResult {
  trackable: number;
  trackedPullRequests: number;
  snapshots: number;
  markedRunning: number;
  outputCollected: number;
  escalated: number;
  completedNoAction: number;
  verifying: number;
  prRefreshed: number;
  prLookupDeferred: number;
  verificationPassed: number;
  verificationFailed: number;
  verificationUnverified: number;
  verificationError: number;
  failed: number;
}

export interface SessionTrackerOptions {
  devin: Pick<DevinClient, 'getSession'>;
  github: Pick<GitHubClient, 'getPullRequest'> &
    Partial<Pick<GitHubClient, 'getIssue' | 'listCheckRuns' | 'getCombinedStatus'>>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
  staleWarnMs: number;
  verification?: Omit<VerifyRemediationOptions, 'logger' | 'db' | 'github'>;
}

export function toEpochMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function logContext(attempt: Attempt) {
  return {
    attempt_id: attempt.id,
    correlation_id: attempt.correlationId,
    devin_session_id: attempt.devinSessionId,
  };
}

function isLookupDeferred(error: unknown): boolean {
  return (
    error instanceof GitHubApiError &&
    (error.status === 429 || error.rateLimited || error.status >= 500)
  );
}

function logNormalizedState(
  attemptId: number,
  decision: TrackingDecision,
  opts: SessionTrackerOptions,
  db: Db
): void {
  const current = getAttempt(attemptId, db);
  if (!current) return;
  const projection = projectTaskState(current, db);
  opts.logger.info(
    {
      ...logContext(current),
      decision,
      normalized_state: projection.state,
      normalized_reason: projection.reason,
      raw_devin_status: current.devinSessionStatus,
      pr_state: current.prState,
    },
    'Normalized task state'
  );
}

async function refreshPullRequest(
  attempt: Attempt,
  task: Task,
  opts: SessionTrackerOptions,
  db: Db
): Promise<'pr_refreshed' | 'pr_lookup_deferred' | undefined> {
  if (attempt.prNumber === null || attempt.prUrl === null) return undefined;
  try {
    const pr = await opts.github.getPullRequest(task.repoOwner, task.repoName, attempt.prNumber);
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
    return 'pr_refreshed';
  } catch (error: unknown) {
    opts.logger.warn(
      { ...logContext(attempt), err: error, pr_number: attempt.prNumber },
      isLookupDeferred(error)
        ? 'Pull request lookup failed transiently; deferring refresh'
        : 'Pull request lookup failed; continuing'
    );
    return 'pr_lookup_deferred';
  }
}

async function maybeVerifyRemediation(
  attempt: Attempt,
  task: Task,
  opts: SessionTrackerOptions,
  db: Db
): Promise<TrackingDecision | undefined> {
  if (attempt.state !== 'verifying' || opts.verification === undefined) return undefined;
  const decision = await verifyRemediationOnce(attempt, task, {
    ...opts.verification,
    github: opts.github as Pick<
      GitHubClient,
      'getIssue' | 'getPullRequest' | 'listCheckRuns' | 'getCombinedStatus'
    >,
    logger: opts.logger,
    db,
  });
  return decision === 'verification_skipped' ? undefined : decision;
}

export async function trackAttemptOnce(
  attempt: Attempt,
  task: Task,
  opts: SessionTrackerOptions
): Promise<TrackingDecision> {
  const db = opts.db ?? getDb();
  const context = logContext(attempt);
  if (!attempt.devinSessionId) return 'failed';

  let session: SessionResponse | undefined;
  try {
    session = await opts.devin.getSession(attempt.devinSessionId);
    recordSessionSnapshot(
      attempt.id,
      {
        status: session.status,
        statusDetail: session.status_detail,
        acusConsumed: session.acus_consumed,
        sessionUpdatedAt: toEpochMs(session.updated_at),
      },
      db
    );
  } catch (error: unknown) {
    if (attempt.state !== 'verifying') throw error;
    opts.logger.warn(
      { ...context, err: error },
      'Devin session lookup failed for verifying attempt; refreshing pull request'
    );
    let current = getAttempt(attempt.id, db);
    if (!current || current.state !== 'verifying') return 'failed';
    const refreshed = await refreshPullRequest(current, task, opts, db);
    if (refreshed !== 'pr_refreshed') return refreshed ?? 'failed';
    current = getAttempt(current.id, db);
    if (!current) return refreshed;
    const catchDecision = (await maybeVerifyRemediation(current, task, opts, db)) ?? refreshed;
    logNormalizedState(attempt.id, catchDecision, opts, db);
    return catchDecision;
  }
  let current = getAttempt(attempt.id, db);
  if (!current) throw new Error(`Attempt ${String(attempt.id)} not found after snapshot`);

  let decision: TrackingDecision = 'snapshot_only';
  let enteredVerifying = false;
  if (session.status === 'running' && current.state === 'session_created') {
    current = markRunning(current.id, db);
    decision = 'marked_running';
  }

  if (
    opts.staleWarnMs > 0 &&
    ['session_created', 'running'].includes(current.state) &&
    Date.now() - Math.max(sessionUpdatedAt(session), current.sessionCreatedAt ?? 0) >
      opts.staleWarnMs
  ) {
    opts.logger.warn(
      { ...context, session_updated_at: toEpochMs(session.updated_at) },
      'Devin session has not updated for longer than the stale threshold'
    );
  }

  if (current.state !== 'verifying' && current.structuredOutputAcceptedAt === null) {
    const collected = await collectStructuredOutput(current, {
      devin: opts.devin,
      logger: opts.logger,
      db,
      session,
    });
    if (collected.decision === 'recorded') decision = 'output_collected';
    else if (collected.decision.startsWith('escalated')) decision = 'escalated';
    current = getAttempt(current.id, db);
    if (!current) throw new Error(`Attempt ${String(attempt.id)} not found after collection`);
  }

  if (current.agentOutcome && current.state !== 'completed' && current.state !== 'verifying') {
    if (current.agentOutcome === 'no_action') {
      completeAttempt(current.id, 'no_action', { reason: 'agent_reported_no_action' }, db);
      decision = 'completed_no_action';
    } else if (current.agentOutcome === 'needs_human') {
      completeAttempt(
        current.id,
        'escalated',
        { reason: `needs_human: ${current.needsHumanReason ?? 'unspecified'}` },
        db
      );
      decision = 'escalated';
    } else if (!current.agentPrUrl) {
      completeAttempt(current.id, 'escalated', { reason: 'remediated_without_pr' }, db);
      decision = 'escalated';
    } else {
      const verification = await verifyAgentPullRequest(task, current.agentPrUrl, opts.github);
      if (verification.ok) {
        const currentAttemptId = current.id;
        db.transaction((tx) => {
          recordPullRequest(
            currentAttemptId,
            {
              prUrl: verification.pr.url,
              prNumber: verification.pr.number,
              prState: verification.pr.state,
              prHeadSha: verification.pr.headSha,
            },
            tx
          );
          const updated = getAttempt(currentAttemptId, tx);
          if (updated?.state !== 'verifying') markVerifying(currentAttemptId, tx);
        });
        enteredVerifying = true;
        decision = 'verifying';
      } else if (verification.reason === 'lookup_failed') {
        opts.logger.warn(
          { ...context, reason: verification.reason, pr_url: current.agentPrUrl },
          'Pull request verification lookup failed; retrying on the next poll'
        );
        decision = 'pr_lookup_deferred';
      } else {
        completeAttempt(
          current.id,
          'escalated',
          { reason: `pr_${verification.reason}: ${current.agentPrUrl}` },
          db
        );
        decision = 'escalated';
      }
    }
  }

  current = getAttempt(current.id, db);
  let deferred = false;
  if (!enteredVerifying && current?.state === 'verifying' && current.prUrl !== null) {
    const refreshed = await refreshPullRequest(current, task, opts, db);
    if (refreshed) decision = refreshed;
    deferred = refreshed === 'pr_lookup_deferred';
  }

  current = current ? getAttempt(current.id, db) : undefined;
  if (current && !deferred) {
    const verificationDecision = await maybeVerifyRemediation(current, task, opts, db);
    if (verificationDecision !== undefined) {
      decision = verificationDecision;
    }
  }
  logNormalizedState(attempt.id, decision, opts, db);
  return decision;
}

function countDecision(result: TrackingResult, decision: TrackingDecision) {
  if (decision === 'snapshot_only') result.snapshots += 1;
  else if (decision === 'marked_running') result.markedRunning += 1;
  else if (decision === 'output_collected') result.outputCollected += 1;
  else if (decision === 'escalated') result.escalated += 1;
  else if (decision === 'completed_no_action') result.completedNoAction += 1;
  else if (decision === 'verifying') result.verifying += 1;
  else if (decision === 'pr_refreshed') result.prRefreshed += 1;
  else if (decision === 'pr_lookup_deferred') result.prLookupDeferred += 1;
  else if (decision === 'verification_passed') result.verificationPassed += 1;
  else if (decision === 'verification_failed') result.verificationFailed += 1;
  else if (decision === 'verification_unverified') result.verificationUnverified += 1;
  else if (decision === 'verification_error') result.verificationError += 1;
  else result.failed += 1;
}

export async function runTrackingOnce(opts: SessionTrackerOptions): Promise<TrackingResult> {
  const db = opts.db ?? getDb();
  const rows = findTrackableAttempts(db);
  const trackedRows = findCompletedAttemptsWithTrackedPullRequests(db);
  const result: TrackingResult = {
    trackable: rows.length,
    trackedPullRequests: trackedRows.length,
    snapshots: 0,
    markedRunning: 0,
    outputCollected: 0,
    escalated: 0,
    completedNoAction: 0,
    verifying: 0,
    prRefreshed: 0,
    prLookupDeferred: 0,
    verificationPassed: 0,
    verificationFailed: 0,
    verificationUnverified: 0,
    verificationError: 0,
    failed: 0,
  };

  for (const { attempt, task } of rows) {
    let decision: TrackingDecision;
    try {
      decision = await trackAttemptOnce(attempt, task, opts);
    } catch (error: unknown) {
      opts.logger.error(
        { err: error, ...logContext(attempt) },
        'Session tracking failed for attempt'
      );
      decision = 'failed';
    }
    countDecision(result, decision);
  }

  for (const { attempt, task } of trackedRows) {
    try {
      const decision = await refreshPullRequest(attempt, task, opts, db);
      if (decision) {
        countDecision(result, decision);
        logNormalizedState(attempt.id, decision, opts, db);
      }
    } catch (error: unknown) {
      opts.logger.error(
        { err: error, ...logContext(attempt) },
        'Pull request refresh failed for attempt'
      );
      result.failed += 1;
    }
  }

  opts.logger.info(result, 'Devin session tracking completed');
  return result;
}

function sessionUpdatedAt(session: SessionResponse): number {
  return toEpochMs(session.updated_at);
}

export function startTrackingPoller(opts: SessionTrackerOptions & { intervalMs: number }): {
  stop(): Promise<void>;
} {
  let inFlight = false;
  let stopped = false;
  let current: Promise<void> | undefined;

  const run = () => {
    if (stopped) return;
    if (inFlight) {
      opts.logger.debug('Skipping Devin tracking poll while previous run is in flight');
      return;
    }
    inFlight = true;
    current = runTrackingOnce(opts)
      .then(() => undefined)
      .catch((error: unknown) => {
        opts.logger.error({ err: error }, 'Devin tracking run failed unexpectedly');
      })
      .finally(() => {
        inFlight = false;
        current = undefined;
      });
  };

  run();
  const interval = setInterval(run, opts.intervalMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await current;
    },
  };
}
