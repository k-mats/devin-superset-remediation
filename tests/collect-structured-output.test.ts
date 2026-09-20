import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks } from '../src/db/schema.js';
import type { DevinClient, SessionResponse } from '../src/devin/client.js';
import {
  InvalidTransitionError,
  completeAttempt,
  createAttempt,
  getAttempt,
  markDispatching,
  markSessionCreated,
  upsertTask,
} from '../src/db/task-state.js';
import { collectStructuredOutput } from '../src/outcome/collect-structured-output.js';

const identity = { repoOwner: 'owner', repoName: 'repo' };

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function session(overrides: Partial<SessionResponse> = {}): SessionResponse {
  return {
    session_id: 'sess-1',
    url: 'https://app.devin.ai/sessions/sess-1',
    status: 'exit',
    status_detail: 'finished',
    tags: [],
    org_id: 'org',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

const validOutput = {
  schema_version: 1,
  outcome: 'remediated',
  pr_url: 'https://github.com/owner/repo/pull/9',
  diagnosis: 'Fixed the bug',
  tests_run: [{ command: 'pnpm test', result: 'passed' }],
  risks: [],
  needs_human_reason: null,
};

function activeAttempt(sessionId = 'sess-1') {
  const task = upsertTask({ ...identity, issueNumber: 7 });
  const attempt = createAttempt(task.id);
  markDispatching(attempt.id);
  return markSessionCreated(attempt.id, { devinSessionId: sessionId });
}

function collect(attemptId: number, getSession: DevinClient['getSession']) {
  const attempt = getAttempt(attemptId);
  if (!attempt) throw new Error('attempt missing');
  return collectStructuredOutput(attempt, { devin: { getSession }, logger: logger() });
}

describe('collectStructuredOutput', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  it('returns session_not_finished and persists nothing while the turn is in progress', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() =>
      Promise.resolve(session({ status: 'running', status_detail: 'working' }))
    );

    const result = await collect(attempt.id, getSession);

    expect(result.decision).toBe('session_not_finished');
    expect(result.phase).toBe('in_progress');
    expect(getSession).toHaveBeenCalledWith('sess-1');
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'session_created',
      structuredOutputRaw: null,
      agentOutcome: null,
      structuredOutputAcceptedAt: null,
    });
  });

  it.each(['waiting_for_user', 'suspended'] as const)(
    'returns a non-escalating decision when phase is %s without output',
    async (phase) => {
      const attempt = activeAttempt();
      const getSession = vi.fn(() =>
        Promise.resolve(
          session(
            phase === 'waiting_for_user'
              ? { status: 'running', status_detail: 'waiting_for_user' }
              : { status: 'suspended', status_detail: 'inactivity' }
          )
        )
      );

      const result = await collect(attempt.id, getSession);

      expect(result.decision).toBe(
        phase === 'waiting_for_user'
          ? 'awaiting_user_without_output'
          : 'session_suspended_without_output'
      );
      expect(result.phase).toBe(phase);
      expect(getAttempt(attempt.id)).toMatchObject({
        state: 'session_created',
        outcome: null,
        structuredOutputRaw: null,
        agentOutcome: null,
      });
    }
  );

  it('escalates with session_error when the session ended in error', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() =>
      Promise.resolve(
        session({
          status: 'error',
          status_detail: 'usage_limit_exceeded',
          structured_output: null,
        })
      )
    );

    const result = await collect(attempt.id, getSession);

    expect(result.decision).toBe('escalated_session_error');
    expect(result.phase).toBe('error');
    const stored = getAttempt(attempt.id);
    expect(stored).toMatchObject({
      state: 'completed',
      outcome: 'escalated',
      agentOutcome: null,
    });
    expect(stored?.outcomeReason).toBe('session_error: usage_limit_exceeded');
  });

  it('records a valid structured output without touching outcome or prUrl', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() => Promise.resolve(session({ structured_output: validOutput })));

    const result = await collect(attempt.id, getSession);

    expect(result.decision).toBe('recorded');
    expect(result.output?.outcome).toBe('remediated');
    const stored = getAttempt(attempt.id);
    expect(stored).toMatchObject({
      state: 'session_created',
      outcome: null,
      prUrl: null,
      agentOutcome: 'remediated',
      agentPrUrl: 'https://github.com/owner/repo/pull/9',
      agentDiagnosis: 'Fixed the bug',
      agentTestsRun: [{ command: 'pnpm test', result: 'passed' }],
      agentRisks: [],
      needsHumanReason: null,
    });
    expect(stored?.structuredOutputAcceptedAt).toEqual(expect.any(Number));
    expect(JSON.parse(stored?.structuredOutputRaw as string)).toEqual(validOutput);
  });

  it('records valid output from a waiting_for_user session', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() =>
      Promise.resolve(
        session({
          status: 'running',
          status_detail: 'waiting_for_user',
          structured_output: validOutput,
        })
      )
    );

    const result = await collect(attempt.id, getSession);

    expect(result.decision).toBe('recorded');
    expect(result.phase).toBe('waiting_for_user');
    expect(getAttempt(attempt.id)?.agentOutcome).toBe('remediated');
  });

  it('escalates with structured_output_missing when a finished session returned none', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() => Promise.resolve(session({ structured_output: null })));

    const result = await collect(attempt.id, getSession);

    expect(result.decision).toBe('escalated_missing');
    const stored = getAttempt(attempt.id);
    expect(stored).toMatchObject({
      state: 'completed',
      outcome: 'escalated',
      structuredOutputRaw: null,
      agentOutcome: null,
      structuredOutputAcceptedAt: null,
    });
    expect(stored?.outcomeReason).toMatch(/^structured_output_missing/);
  });

  it('escalates with structured_output_invalid and keeps the raw payload', async () => {
    const attempt = activeAttempt();
    const raw = { outcome: 'bogus' };
    const getSession = vi.fn(() => Promise.resolve(session({ structured_output: raw })));

    const result = await collect(attempt.id, getSession);

    expect(result.decision).toBe('escalated_invalid');
    const stored = getAttempt(attempt.id);
    expect(stored).toMatchObject({
      state: 'completed',
      outcome: 'escalated',
      agentOutcome: null,
      agentPrUrl: null,
      agentDiagnosis: null,
      structuredOutputAcceptedAt: null,
    });
    expect(stored?.outcomeReason).toMatch(/^structured_output_invalid/);
    expect(JSON.parse(stored?.structuredOutputRaw as string)).toEqual(raw);
  });

  it('returns already_recorded without calling getSession once output was accepted', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() => Promise.resolve(session({ structured_output: validOutput })));

    const first = await collect(attempt.id, getSession);
    expect(first.decision).toBe('recorded');

    getSession.mockClear();
    const second = await collect(attempt.id, getSession);

    expect(second.decision).toBe('already_recorded');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('rolls back the raw write when another writer completes the attempt mid-collection', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() => {
      // Another writer completes the attempt between fetch and persistence.
      completeAttempt(attempt.id, 'cancelled');
      return Promise.resolve(session({ structured_output: { outcome: 'bogus' } }));
    });

    await expect(collect(attempt.id, getSession)).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'completed',
      outcome: 'cancelled',
      structuredOutputRaw: null,
      agentOutcome: null,
    });
  });

  it('returns already_completed without calling getSession', async () => {
    const attempt = activeAttempt();
    completeAttempt(attempt.id, 'cancelled');
    const getSession = vi.fn();

    const result = await collect(attempt.id, getSession);

    expect(result.decision).toBe('already_completed');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('returns no_session when the attempt has no Devin session id', async () => {
    const task = upsertTask({ ...identity, issueNumber: 7 });
    const attempt = createAttempt(task.id);
    const getSession = vi.fn();

    const result = await collectStructuredOutput(attempt, {
      devin: { getSession },
      logger: logger(),
    });

    expect(result.decision).toBe('no_session');
    expect(getSession).not.toHaveBeenCalled();
  });
});
