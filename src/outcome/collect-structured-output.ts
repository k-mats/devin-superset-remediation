import type { FastifyBaseLogger } from 'fastify';
import type { DevinClient, SessionPhase, SessionResponse } from '../devin/client.js';
import { classifySessionPhase } from '../devin/client.js';
import type { StructuredOutput } from '../devin/structured-output.js';
import { parseStructuredOutput } from '../devin/structured-output.js';
import { getDb } from '../db/client.js';
import type { Attempt } from '../db/schema.js';
import { completeAttempt, recordStructuredOutput, type Db } from '../db/task-state.js';

export type OutcomeCollectionDecision =
  | 'no_session'
  | 'already_completed'
  | 'already_recorded'
  | 'session_not_finished'
  | 'awaiting_user_without_output'
  | 'session_suspended_without_output'
  | 'recorded'
  | 'escalated_missing'
  | 'escalated_invalid'
  | 'escalated_session_error';

export interface CollectStructuredOutputOptions {
  devin: Pick<DevinClient, 'getSession'>;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
}

export interface CollectStructuredOutputResult {
  decision: OutcomeCollectionDecision;
  phase?: SessionPhase;
  session?: SessionResponse;
  output?: StructuredOutput;
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
  if (attempt.structuredOutputAcceptedAt !== null) {
    opts.logger.info(
      logContext,
      'Structured output already accepted for attempt; skipping collection'
    );
    return { decision: 'already_recorded' };
  }

  const session = await opts.devin.getSession(attempt.devinSessionId);
  const phase = classifySessionPhase(session);
  const hasOutput = session.structured_output !== null && session.structured_output !== undefined;
  const phaseContext = { ...logContext, status: session.status, phase };

  if (phase === 'in_progress') {
    opts.logger.info(
      phaseContext,
      'Devin session turn is not complete; leaving output uncollected'
    );
    return { decision: 'session_not_finished', phase, session };
  }
  if (phase === 'waiting_for_user' && !hasOutput) {
    opts.logger.info(
      phaseContext,
      'Devin session is waiting for user input without structured output; leaving uncollected'
    );
    return { decision: 'awaiting_user_without_output', phase, session };
  }
  if (phase === 'suspended' && !hasOutput) {
    opts.logger.info(
      phaseContext,
      'Devin session suspended without structured output; resumable, leaving uncollected'
    );
    return { decision: 'session_suspended_without_output', phase, session };
  }
  if (phase === 'error') {
    const parsed = parseStructuredOutput(session.structured_output);
    db.transaction((tx) => {
      recordStructuredOutput(
        attempt.id,
        { raw: session.structured_output, parsed: parsed.ok ? parsed.value : undefined },
        tx
      );
      completeAttempt(
        attempt.id,
        'escalated',
        { reason: `session_error: ${session.status_detail ?? 'unknown'}` },
        tx
      );
    });
    opts.logger.warn(
      { ...phaseContext, status_detail: session.status_detail },
      'Devin session ended in error; escalated attempt'
    );
    return { decision: 'escalated_session_error', phase, session };
  }

  const parsed = parseStructuredOutput(session.structured_output);
  if (parsed.ok) {
    recordStructuredOutput(
      attempt.id,
      { raw: session.structured_output, parsed: parsed.value },
      db
    );
    opts.logger.info(
      { ...phaseContext, agent_outcome: parsed.value.outcome, pr_url: parsed.value.pr_url },
      'Recorded structured output from Devin session'
    );
    return { decision: 'recorded', phase, session, output: parsed.value };
  }

  db.transaction((tx) => {
    recordStructuredOutput(attempt.id, { raw: session.structured_output, parsed: undefined }, tx);
    completeAttempt(attempt.id, 'escalated', { reason: `${parsed.reason}: ${parsed.message}` }, tx);
  });
  opts.logger.warn(
    { ...phaseContext, reason: parsed.reason },
    'Devin session finished without valid structured output; escalated attempt'
  );
  return {
    decision:
      parsed.reason === 'structured_output_missing' ? 'escalated_missing' : 'escalated_invalid',
    phase,
    session,
  };
}
