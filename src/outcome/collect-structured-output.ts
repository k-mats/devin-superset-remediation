import type { FastifyBaseLogger } from 'fastify';
import type { DevinClient, SessionResponse } from '../devin/client.js';
import { isSessionTurnComplete } from '../devin/client.js';
import type { StructuredOutput } from '../devin/structured-output.js';
import { parseStructuredOutput } from '../devin/structured-output.js';
import { getDb } from '../db/client.js';
import type { Attempt } from '../db/schema.js';
import { completeAttempt, recordStructuredOutput, type Db } from '../db/task-state.js';

export type OutcomeCollectionDecision =
  | 'session_not_finished'
  | 'recorded'
  | 'escalated_missing'
  | 'escalated_invalid'
  | 'already_completed'
  | 'no_session';

export interface CollectStructuredOutputOptions {
  devin: Pick<DevinClient, 'getSession'>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
}

export interface CollectStructuredOutputResult {
  decision: OutcomeCollectionDecision;
  session?: SessionResponse;
  outcome?: StructuredOutput;
}

export async function collectStructuredOutput(
  attempt: Attempt,
  opts: CollectStructuredOutputOptions
): Promise<CollectStructuredOutputResult> {
  const db = opts.db ?? getDb();
  const logContext = {
    attempt_id: attempt.id,
    correlation_id: attempt.correlationId,
    devin_session_id: attempt.devinSessionId,
  };

  if (!attempt.devinSessionId) {
    opts.logger.info(logContext, 'Attempt has no Devin session id; nothing to collect');
    return { decision: 'no_session' };
  }
  if (attempt.state === 'completed') {
    opts.logger.info(logContext, 'Attempt already completed; skipping outcome collection');
    return { decision: 'already_completed' };
  }

  const session = await opts.devin.getSession(attempt.devinSessionId);
  if (!isSessionTurnComplete(session)) {
    opts.logger.info(
      { ...logContext, status: session.status, status_detail: session.status_detail },
      'Devin session turn is not complete; leaving outcome uncollected'
    );
    return { decision: 'session_not_finished', session };
  }

  const parsed = parseStructuredOutput(session.structured_output);
  if (parsed.ok) {
    recordStructuredOutput(
      attempt.id,
      { raw: session.structured_output, parsed: parsed.value },
      db
    );
    opts.logger.info(
      { ...logContext, agent_outcome: parsed.value.outcome, pr_url: parsed.value.pr_url },
      'Recorded structured output from Devin session'
    );
    return { decision: 'recorded', session, outcome: parsed.value };
  }

  db.transaction((tx) => {
    recordStructuredOutput(attempt.id, { raw: session.structured_output, parsed: undefined }, tx);
    completeAttempt(attempt.id, 'escalated', { reason: `${parsed.reason}: ${parsed.message}` }, tx);
  });
  opts.logger.warn(
    { ...logContext, reason: parsed.reason },
    'Devin session finished without valid structured output; escalated attempt'
  );
  return {
    decision:
      parsed.reason === 'structured_output_missing' ? 'escalated_missing' : 'escalated_invalid',
    session,
  };
}
