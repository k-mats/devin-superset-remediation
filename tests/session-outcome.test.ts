import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks } from '../src/db/schema.js';
import type { SessionResponse } from '../src/devin/client.js';
import {
  InvalidTransitionError,
  completeAttempt,
  createAttempt,
  getAttempt,
  markDispatching,
  markSessionCreated,
  upsertTask,
} from '../src/db/task-state.js';
import { collectSessionOutcome } from '../src/outcome/session-outcome.js';

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

describe('collectSessionOutcome', () => {
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

  it('returns session_not_finished and persists nothing while the turn is incomplete', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() =>
      Promise.resolve(session({ status: 'running', status_detail: 'working' }))
    );

    const result = await collectSessionOutcome(attempt, {
      devin: { getSession },
      logger: logger(),
    });

    expect(result.decision).toBe('session_not_finished');
    expect(getSession).toHaveBeenCalledWith('sess-1');
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'session_created',
      structuredOutputRaw: null,
      agentOutcome: null,
    });
  });

  it('records a valid structured outcome without touching outcome or prUrl', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() => Promise.resolve(session({ structured_output: validOutput })));

    const result = await collectSessionOutcome(attempt, {
      devin: { getSession },
      logger: logger(),
    });

    expect(result.decision).toBe('recorded');
    expect(result.outcome?.outcome).toBe('remediated');
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
    expect(JSON.parse(stored?.structuredOutputRaw as string)).toEqual(validOutput);
  });

  it('escalates with structured_output_missing when the session returned none', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() => Promise.resolve(session({ structured_output: null })));

    const result = await collectSessionOutcome(attempt, {
      devin: { getSession },
      logger: logger(),
    });

    expect(result.decision).toBe('escalated_missing');
    const stored = getAttempt(attempt.id);
    expect(stored).toMatchObject({
      state: 'completed',
      outcome: 'escalated',
      structuredOutputRaw: null,
      agentOutcome: null,
    });
    expect(stored?.outcomeReason).toMatch(/^structured_output_missing/);
  });

  it('escalates with structured_output_invalid and keeps the raw payload', async () => {
    const attempt = activeAttempt();
    const raw = { outcome: 'bogus' };
    const getSession = vi.fn(() => Promise.resolve(session({ structured_output: raw })));

    const result = await collectSessionOutcome(attempt, {
      devin: { getSession },
      logger: logger(),
    });

    expect(result.decision).toBe('escalated_invalid');
    const stored = getAttempt(attempt.id);
    expect(stored).toMatchObject({
      state: 'completed',
      outcome: 'escalated',
      agentOutcome: null,
      agentPrUrl: null,
      agentDiagnosis: null,
    });
    expect(stored?.outcomeReason).toMatch(/^structured_output_invalid/);
    expect(JSON.parse(stored?.structuredOutputRaw as string)).toEqual(raw);
  });

  it('rolls back the raw write when another writer completes the attempt mid-collection', async () => {
    const attempt = activeAttempt();
    const getSession = vi.fn(() => {
      // Another writer completes the attempt between fetch and persistence.
      completeAttempt(attempt.id, 'cancelled');
      return Promise.resolve(session({ structured_output: { outcome: 'bogus' } }));
    });

    await expect(
      collectSessionOutcome(attempt, { devin: { getSession }, logger: logger() })
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'completed',
      outcome: 'cancelled',
      structuredOutputRaw: null,
      agentOutcome: null,
    });
  });

  it('returns already_completed without calling getSession', async () => {
    const attempt = activeAttempt();
    const completed = completeAttempt(attempt.id, 'cancelled');
    const getSession = vi.fn();

    const result = await collectSessionOutcome(completed, {
      devin: { getSession },
      logger: logger(),
    });

    expect(result.decision).toBe('already_completed');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('returns no_session when the attempt has no Devin session id', async () => {
    const task = upsertTask({ ...identity, issueNumber: 7 });
    const attempt = createAttempt(task.id);
    const getSession = vi.fn();

    const result = await collectSessionOutcome(attempt, {
      devin: { getSession },
      logger: logger(),
    });

    expect(result.decision).toBe('no_session');
    expect(getSession).not.toHaveBeenCalled();
  });
});
