import type { FastifyBaseLogger } from 'fastify';
import type { DevinClient } from '../devin/client.js';
import { getDb } from '../db/client.js';
import type { Attempt, Task } from '../db/schema.js';
import {
  findUncertainDispatchCandidates,
  getAttempt,
  InvalidTransitionError,
  markSessionCreated,
  type Db,
} from '../db/task-state.js';
import { buildSessionTags } from './devin-dispatcher.js';

export type ReconciliationDecision =
  | 'session_adopted'
  | 'already_adopted'
  | 'no_match'
  | 'ambiguous_match'
  | 'identity_mismatch'
  | 'lookup_unavailable';

export interface ReconciliationResult {
  candidates: number;
  adopted: number;
  alreadyAdopted: number;
  noMatch: number;
  ambiguous: number;
  identityMismatch: number;
  lookupUnavailable: number;
  failed: number;
}

export interface ReconcileUncertainDispatchOptions {
  devin: Pick<DevinClient, 'listSessions'>;
  graceMs: number;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
  now?: () => number;
}

function logContext(attempt: Attempt) {
  return {
    attempt_id: attempt.id,
    correlation_id: attempt.correlationId,
    dispatched_at: attempt.dispatchedAt,
  };
}

function countDecision(result: ReconciliationResult, decision: ReconciliationDecision) {
  if (decision === 'session_adopted') result.adopted += 1;
  else if (decision === 'already_adopted') result.alreadyAdopted += 1;
  else if (decision === 'no_match') result.noMatch += 1;
  else if (decision === 'ambiguous_match') result.ambiguous += 1;
  else if (decision === 'identity_mismatch') result.identityMismatch += 1;
  else result.lookupUnavailable += 1;
}

export async function reconcileAttempt(
  attempt: Attempt,
  task: Task,
  opts: ReconcileUncertainDispatchOptions
): Promise<ReconciliationDecision> {
  const db = opts.db ?? getDb();
  const context = logContext(attempt);
  const correlationTag = `correlation:${attempt.correlationId}`;
  const expectedTags = buildSessionTags(task, attempt);

  let items;
  try {
    const response = await opts.devin.listSessions({ tags: [correlationTag], first: 200 });
    items = response.items;
  } catch (error: unknown) {
    opts.logger.warn(
      { ...context, err: error, reason: 'lookup_unavailable' },
      'Devin session lookup failed; attempt stays dispatching for a later pass'
    );
    return 'lookup_unavailable';
  }

  // The API ORs repeated tags= params and matches exactly, so verify the
  // correlation tag client-side before trusting a returned session.
  const matches = items.filter((session) => session.tags.includes(correlationTag));

  if (matches.length === 0) {
    opts.logger.info(
      { ...context, reason: 'no_match' },
      'No Devin session matches the correlation tag; attempt stays dispatching for a later pass'
    );
    return 'no_match';
  }

  if (matches.length > 1) {
    opts.logger.warn(
      {
        ...context,
        reason: 'ambiguous_match',
        session_ids: matches.map((session) => session.session_id),
      },
      'Multiple Devin sessions match the correlation tag; attempt stays dispatching'
    );
    return 'ambiguous_match';
  }

  const session = matches[0];
  if (session === undefined) {
    throw new Error('Unreachable: matches.length === 1 without an item');
  }
  if (!expectedTags.every((tag) => session.tags.includes(tag))) {
    opts.logger.warn(
      {
        ...context,
        reason: 'identity_mismatch',
        devin_session_id: session.session_id,
        expected_tags: expectedTags,
        actual_tags: session.tags,
      },
      'Matched Devin session is missing expected tags; attempt stays dispatching'
    );
    return 'identity_mismatch';
  }

  try {
    // markSessionCreated is a single UPDATE guarded by state = 'dispatching',
    // so concurrent reconciliation adopts the session exactly once.
    markSessionCreated(
      attempt.id,
      { devinSessionId: session.session_id, devinSessionUrl: session.url },
      db
    );
  } catch (error: unknown) {
    if (error instanceof InvalidTransitionError) {
      const current = getAttempt(attempt.id, db);
      if (current?.devinSessionId === session.session_id) {
        opts.logger.info(
          { ...context, reason: 'already_adopted', devin_session_id: session.session_id },
          'Devin session was already adopted for this attempt'
        );
        return 'already_adopted';
      }
    }
    throw error;
  }

  opts.logger.info(
    {
      ...context,
      reason: 'session_adopted',
      devin_session_id: session.session_id,
      url: session.url,
    },
    'Adopted existing Devin session for uncertain dispatch'
  );
  return 'session_adopted';
}

export async function reconcileUncertainDispatchOnce(
  opts: ReconcileUncertainDispatchOptions
): Promise<ReconciliationResult> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? Date.now;
  const cutoff = now() - opts.graceMs;
  const rows = findUncertainDispatchCandidates(cutoff, db);
  const result: ReconciliationResult = {
    candidates: rows.length,
    adopted: 0,
    alreadyAdopted: 0,
    noMatch: 0,
    ambiguous: 0,
    identityMismatch: 0,
    lookupUnavailable: 0,
    failed: 0,
  };

  if (rows.length === 0) {
    opts.logger.debug('No uncertain dispatch candidates; skipping provider lookup');
    return result;
  }

  for (const { attempt, task } of rows) {
    opts.logger.info(
      { ...logContext(attempt), reason: 'uncertain_dispatch_detected' },
      'Detected dispatching attempt with no Devin session after grace period'
    );
    try {
      countDecision(result, await reconcileAttempt(attempt, task, opts));
    } catch (error: unknown) {
      opts.logger.error(
        { err: error, ...logContext(attempt) },
        'Uncertain dispatch reconciliation failed for attempt'
      );
      result.failed += 1;
    }
  }

  opts.logger.info(result, 'Uncertain dispatch reconciliation completed');
  return result;
}

export function startReconciliationPoller(
  opts: ReconcileUncertainDispatchOptions & { intervalMs: number }
): { stop(): Promise<void> } {
  let inFlight = false;
  let stopped = false;
  let current: Promise<void> | undefined;

  const run = () => {
    if (stopped) return;
    if (inFlight) {
      opts.logger.debug('Skipping Devin reconciliation poll while previous run is in flight');
      return;
    }
    inFlight = true;
    current = reconcileUncertainDispatchOnce(opts)
      .then(() => undefined)
      .catch((error: unknown) => {
        opts.logger.error({ err: error }, 'Devin reconciliation run failed unexpectedly');
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
