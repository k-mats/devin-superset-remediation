import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import type { Attempt, Task } from '../src/db/schema.js';
import {
  DevinApiError,
  type CreateSessionRequest,
  type ListSessionsParams,
  type PaginatedSessionsResponse,
  type SessionResponse,
} from '../src/devin/client.js';
import {
  createAttempt,
  getAttempt,
  listAttempts,
  markDispatching,
  upsertTask,
  type Db,
} from '../src/db/task-state.js';
import { buildSessionTags } from '../src/dispatch/devin-dispatcher.js';
import {
  reconcileAttempt,
  reconcileUncertainDispatchOnce,
  type ReconcileUncertainDispatchOptions,
} from '../src/dispatch/reconcile-uncertain-dispatch.js';
import { runTrackingOnce } from '../src/tracking/session-tracker.js';

const GRACE_MS = 300_000;

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

type ListSessions = (params: ListSessionsParams) => Promise<PaginatedSessionsResponse>;

function page(items: SessionResponse[]): PaginatedSessionsResponse {
  return { items, end_cursor: null, has_next_page: false, total: items.length };
}

function fakeDevin(items: SessionResponse[] = []) {
  return {
    createSession: vi.fn<(req: CreateSessionRequest) => Promise<SessionResponse>>(),
    listSessions: vi.fn<ListSessions>(() => Promise.resolve(page(items))),
  };
}

function matchingSession(
  task: Task,
  attempt: Attempt,
  overrides: Partial<SessionResponse> = {}
): SessionResponse {
  return {
    session_id: `sess-${String(attempt.id)}`,
    url: `https://app.devin.ai/sessions/sess-${String(attempt.id)}`,
    status: 'running',
    status_detail: 'working',
    tags: buildSessionTags(task, attempt),
    org_id: 'org',
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function dispatchingAttempt(issueNumber = 7): { task: Task; attempt: Attempt } {
  const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber });
  const attempt = createAttempt(task.id);
  return { task, attempt: markDispatching(attempt.id) };
}

function reconcileOptions(
  overrides: Partial<ReconcileUncertainDispatchOptions> = {}
): ReconcileUncertainDispatchOptions {
  return {
    devin: fakeDevin(),
    graceMs: GRACE_MS,
    logger: logger(),
    db: getDb(),
    ...overrides,
  };
}

function staleNow(attempt: Attempt): () => number {
  const dispatchedAt = attempt.dispatchedAt;
  if (dispatchedAt === null) throw new Error('Expected dispatchedAt to be set');
  return () => dispatchedAt + GRACE_MS + 1;
}

describe('uncertain dispatch reconciliation', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  it('skips dispatching attempts still inside the grace period without calling the provider', async () => {
    const { attempt } = dispatchingAttempt();
    const devin = fakeDevin();
    const dispatchedAt = attempt.dispatchedAt;
    if (dispatchedAt === null) throw new Error('Expected dispatchedAt to be set');

    const result = await reconcileUncertainDispatchOnce(
      reconcileOptions({ devin, now: () => dispatchedAt })
    );

    expect(result).toMatchObject({ candidates: 0, adopted: 0 });
    expect(devin.listSessions).not.toHaveBeenCalled();
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(getAttempt(attempt.id)?.state).toBe('dispatching');
  });

  it('leaves a stale attempt dispatching when no session matches the correlation tag', async () => {
    const { attempt } = dispatchingAttempt();
    const devin = fakeDevin();

    const result = await reconcileUncertainDispatchOnce(
      reconcileOptions({ devin, now: staleNow(attempt) })
    );

    expect(result).toMatchObject({ candidates: 1, noMatch: 1, adopted: 0 });
    expect(devin.listSessions).toHaveBeenCalledTimes(1);
    expect(devin.listSessions).toHaveBeenCalledWith({
      tags: [`correlation:${attempt.correlationId}`],
      first: 200,
    });
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'dispatching',
      devinSessionId: null,
    });
  });

  it('adopts exactly one fully matching archived session and hands off to the tracker', async () => {
    const { task, attempt } = dispatchingAttempt();
    const devin = fakeDevin([matchingSession(task, attempt, { is_archived: true })]);

    const result = await reconcileUncertainDispatchOnce(
      reconcileOptions({ devin, now: staleNow(attempt) })
    );

    expect(result).toMatchObject({ candidates: 1, adopted: 1 });
    expect(devin.listSessions).toHaveBeenCalledTimes(1);
    expect(devin.createSession).not.toHaveBeenCalled();
    const adopted = getAttempt(attempt.id);
    expect(adopted).toMatchObject({
      state: 'session_created',
      devinSessionId: `sess-${String(attempt.id)}`,
      devinSessionUrl: `https://app.devin.ai/sessions/sess-${String(attempt.id)}`,
    });

    // The existing tracking poller picks the adopted session up on its next pass.
    const getSession = vi
      .fn()
      .mockResolvedValue(matchingSession(task, attempt, { status: 'running' }));
    const tracking = await runTrackingOnce({
      devin: { getSession },
      github: { getPullRequest: vi.fn() },
      logger: logger(),
      staleWarnMs: 0,
    });
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession).toHaveBeenCalledWith(`sess-${String(attempt.id)}`);
    expect(tracking.trackable).toBe(1);
    expect(tracking.markedRunning).toBe(1);
    expect(getAttempt(attempt.id)?.state).toBe('running');
  });

  it('leaves a stale attempt dispatching when multiple sessions match the correlation tag', async () => {
    const { task, attempt } = dispatchingAttempt();
    const devin = fakeDevin([
      matchingSession(task, attempt, { session_id: 'sess-a' }),
      matchingSession(task, attempt, { session_id: 'sess-b' }),
    ]);

    const result = await reconcileUncertainDispatchOnce(
      reconcileOptions({ devin, now: staleNow(attempt) })
    );

    expect(result).toMatchObject({ candidates: 1, ambiguous: 1, adopted: 0 });
    expect(devin.listSessions).toHaveBeenCalledTimes(1);
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'dispatching',
      devinSessionId: null,
    });
  });

  it('leaves a stale attempt dispatching when the matched session is missing expected tags', async () => {
    const { task, attempt } = dispatchingAttempt();
    const wrongTags = buildSessionTags(task, attempt).filter(
      (tag) => tag !== `attempt:${String(attempt.id)}`
    );
    const devin = fakeDevin([matchingSession(task, attempt, { tags: wrongTags })]);

    const result = await reconcileUncertainDispatchOnce(
      reconcileOptions({ devin, now: staleNow(attempt) })
    );

    expect(result).toMatchObject({ candidates: 1, identityMismatch: 1, adopted: 0 });
    expect(devin.listSessions).toHaveBeenCalledTimes(1);
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'dispatching',
      devinSessionId: null,
    });
  });

  it.each<[string, Error]>([
    ['503 response', new DevinApiError(503, 'GET', '/sessions', 'Service Unavailable')],
    ['network error', new Error('ECONNRESET')],
  ])(
    'leaves a stale attempt dispatching when the session lookup fails (%s)',
    async (_label, error) => {
      const { attempt } = dispatchingAttempt();
      const devin = fakeDevin();
      devin.listSessions.mockRejectedValue(error);

      const result = await reconcileUncertainDispatchOnce(
        reconcileOptions({ devin, now: staleNow(attempt) })
      );

      expect(result).toMatchObject({ candidates: 1, lookupUnavailable: 1, adopted: 0 });
      expect(devin.listSessions).toHaveBeenCalledTimes(1);
      expect(devin.createSession).not.toHaveBeenCalled();
      expect(getAttempt(attempt.id)).toMatchObject({
        state: 'dispatching',
        devinSessionId: null,
      });
    }
  );

  it('is idempotent: a second pass has no candidates after adoption', async () => {
    const { task, attempt } = dispatchingAttempt();
    const devin = fakeDevin([matchingSession(task, attempt)]);
    const opts = reconcileOptions({ devin, now: staleNow(attempt) });

    const first = await reconcileUncertainDispatchOnce(opts);
    const second = await reconcileUncertainDispatchOnce(opts);

    expect(first).toMatchObject({ candidates: 1, adopted: 1 });
    expect(second).toMatchObject({ candidates: 0, adopted: 0 });
    expect(devin.listSessions).toHaveBeenCalledTimes(1);
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(listAttempts(task.id)).toHaveLength(1);
  });

  it('counts an unexpected persistence failure under failed, not lookup_unavailable', async () => {
    const { task, attempt } = dispatchingAttempt();
    const devin = fakeDevin([matchingSession(task, attempt)]);
    // Fail inside markSessionCreated's read (the second select call, after
    // the candidate join query) with a non-InvalidTransitionError.
    const realDb = getDb();
    const flakyDb = Object.create(realDb) as Db;
    const realSelect = realDb.select.bind(realDb);
    let selects = 0;
    flakyDb.select = ((...args: Parameters<typeof realSelect>) => {
      selects += 1;
      if (selects > 1) throw new Error('db down');
      return realSelect(...args);
    }) as typeof realDb.select;

    const result = await reconcileUncertainDispatchOnce(
      reconcileOptions({ devin, db: flakyDb, now: staleNow(attempt) })
    );

    expect(result).toMatchObject({ candidates: 1, failed: 1, lookupUnavailable: 0, adopted: 0 });
    expect(devin.listSessions).toHaveBeenCalledTimes(1);
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'dispatching',
      devinSessionId: null,
    });
  });

  it('treats a concurrently adopted session as already_adopted instead of throwing', async () => {
    const { task, attempt } = dispatchingAttempt();
    const session = matchingSession(task, attempt);
    const devin = fakeDevin([session]);
    const opts = reconcileOptions({ devin, now: staleNow(attempt) });

    const first = await reconcileAttempt(attempt, task, opts);
    // Reconcile the same stale row again: adoption hits the
    // InvalidTransitionError guard and recognizes the same session id.
    const second = await reconcileAttempt(attempt, task, opts);

    expect(first).toBe('session_adopted');
    expect(second).toBe('already_adopted');
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(listAttempts(task.id)).toHaveLength(1);
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'session_created',
      devinSessionId: session.session_id,
    });
  });
});
