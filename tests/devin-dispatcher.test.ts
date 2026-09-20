import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'node:path';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { config } from '../src/config.js';
import { attempts, tasks, type Attempt, type Task } from '../src/db/schema.js';
import { GitHubApiError, type GitHubIssue } from '../src/github/client.js';
import type { CreateSessionRequest, SessionResponse } from '../src/devin/client.js';

type CreateSession = (req: CreateSessionRequest) => Promise<SessionResponse>;
import {
  claimAttemptForDispatch,
  completeAttempt,
  createAttempt,
  getAttempt,
  getTaskByIdentity,
  listAttempts,
  markDispatching,
  markRunning,
  markSessionCreated,
  upsertTask,
  type Db,
} from '../src/db/task-state.js';
import { runIntakeOnce } from '../src/intake/github-intake.js';
import {
  buildSessionPrompt,
  buildSessionTags,
  dispatchAttempt,
  runDispatchOnce,
  startDispatchPoller,
  type DevinDispatcherOptions,
} from '../src/dispatch/devin-dispatcher.js';

const identity = { repoOwner: 'owner', repoName: 'repo' };

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 7,
    title: 'Fix the thing',
    state: 'open',
    html_url: 'https://github.com/owner/repo/issues/7',
    body: 'Something is broken',
    labels: [{ name: 'devin-ready' }],
    ...overrides,
  };
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function fakeDevin() {
  return {
    createSession: vi.fn<CreateSession>(() =>
      Promise.resolve({
        session_id: 'sess-1',
        url: 'https://app.devin.ai/sessions/sess-1',
        status: 'new',
        tags: [],
        org_id: 'org',
        created_at: 0,
        updated_at: 0,
      })
    ),
  };
}

function dispatchOptions(
  overrides: Partial<DevinDispatcherOptions> = {},
  db: Db = getDb()
): DevinDispatcherOptions {
  return {
    github: { getIssue: vi.fn(() => Promise.resolve(issue())) },
    devin: fakeDevin(),
    label: 'devin-ready',
    maxAcuPerSession: 5,
    logger: logger(),
    db,
    ...overrides,
  };
}

async function intakeIssueOnce(number = 7): Promise<void> {
  await runIntakeOnce({
    client: {
      listOpenIssuesByLabel: vi.fn(() => Promise.resolve([issue({ number })])),
    } as never,
    ...identity,
    label: 'devin-ready',
    logger: logger(),
    db: getDb(),
  });
}

function pendingAttempt(): { attempt: Attempt; task: Task } {
  const task = getTaskByIdentity({ ...identity, issueNumber: 7 });
  if (!task) {
    throw new Error('Expected task to exist');
  }
  const attempt = listAttempts(task.id).at(-1);
  if (!attempt) {
    throw new Error('Expected attempt to exist');
  }
  return { attempt, task };
}

describe('Devin dispatcher', () => {
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

  it('dispatches a pending attempt exactly once across repeated intake and dispatch runs', async () => {
    const devin = fakeDevin();
    const opts = dispatchOptions({ devin });
    const intakeClient = {
      listOpenIssuesByLabel: vi.fn(() => Promise.resolve([issue()])),
    };

    for (let run = 0; run < 3; run += 1) {
      await runIntakeOnce({
        client: intakeClient as never,
        ...identity,
        label: 'devin-ready',
        logger: logger(),
        db: getDb(),
      });
      await runDispatchOnce(opts);
    }

    expect(devin.createSession).toHaveBeenCalledTimes(1);
    const { task } = pendingAttempt();
    const rows = listAttempts(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'session_created',
      devinSessionId: 'sess-1',
      devinSessionUrl: 'https://app.devin.ai/sessions/sess-1',
    });
  });

  it('grants the claim to exactly one of two concurrent dispatchers in the same process', async () => {
    await intakeIssueOnce();
    const { attempt, task } = pendingAttempt();
    const devin = fakeDevin();
    const opts = dispatchOptions({ devin });

    const decisions = await Promise.all([
      dispatchAttempt(attempt, task, opts),
      dispatchAttempt(attempt, task, dispatchOptions({ devin })),
    ]);

    expect(decisions.sort()).toEqual(['claim_lost', 'dispatched']);
    expect(devin.createSession).toHaveBeenCalledTimes(1);
  });

  it('grants the claim to exactly one of two separate database connections', async () => {
    await intakeIssueOnce();
    const { attempt, task } = pendingAttempt();
    const dbPath = path.resolve(config.databasePath);
    const secondSqlite = new Database(dbPath);
    secondSqlite.pragma('foreign_keys = ON');
    const secondDb = drizzle(secondSqlite);
    try {
      const claims = [
        claimAttemptForDispatch(attempt.id),
        claimAttemptForDispatch(attempt.id, secondDb),
      ];
      expect(claims.filter(Boolean)).toHaveLength(1);

      // Reset the claim so dispatchAttempt exercises its own claim path on each connection.
      getDb().update(attempts).set({ state: 'pending', dispatchedAt: null }).run();

      const devin = fakeDevin();
      const decisions = await Promise.all([
        dispatchAttempt(attempt, task, dispatchOptions({ devin })),
        dispatchAttempt(attempt, task, dispatchOptions({ devin }, secondDb)),
      ]);

      expect(decisions.sort()).toEqual(['claim_lost', 'dispatched']);
      expect(devin.createSession).toHaveBeenCalledTimes(1);
    } finally {
      secondSqlite.close();
    }
  });

  it.each<{ override: Partial<GitHubIssue>; reason: string }>([
    { override: { state: 'closed' }, reason: 'issue_closed' },
    { override: { labels: [] }, reason: 'label_missing' },
    { override: { pull_request: {} }, reason: 'is_pull_request' },
  ])(
    'cancels the attempt without creating a session when the issue is ineligible ($reason)',
    async ({ override, reason }) => {
      await intakeIssueOnce();
      const { attempt, task } = pendingAttempt();
      const devin = fakeDevin();
      const opts = dispatchOptions({
        devin,
        github: { getIssue: vi.fn(() => Promise.resolve(issue(override))) },
      });

      const decision = await dispatchAttempt(attempt, task, opts);

      expect(decision).toBe('cancelled_ineligible');
      expect(devin.createSession).not.toHaveBeenCalled();
      expect(getAttempt(attempt.id)).toMatchObject({
        state: 'completed',
        outcome: 'cancelled',
        outcomeReason: reason,
      });
    }
  );

  it('fails the attempt without calling Devin on a terminal eligibility error', async () => {
    await intakeIssueOnce();
    const { attempt, task } = pendingAttempt();
    const devin = fakeDevin();
    const opts = dispatchOptions({
      devin,
      github: {
        getIssue: vi.fn(() =>
          Promise.reject(new GitHubApiError(404, 'GET', '/repos/owner/repo/issues/7', 'Not Found'))
        ),
      },
    });

    const decision = await dispatchAttempt(attempt, task, opts);

    expect(decision).toBe('failed_eligibility_check');
    expect(devin.createSession).not.toHaveBeenCalled();
    const stored = getAttempt(attempt.id);
    expect(stored?.state).toBe('completed');
    expect(stored?.outcome).toBe('failed');
    expect(stored?.outcomeReason).toMatch(/^eligibility_check_failed: /);
  });

  it.each<[string, Error]>([
    ['500 response', new GitHubApiError(500, 'GET', '/x', 'oops')],
    ['403 response', new GitHubApiError(403, 'GET', '/x', 'rate limited')],
    ['429 response', new GitHubApiError(429, 'GET', '/x', 'rate limited')],
    ['network error', new Error('ECONNRESET')],
    ['parse error', new Error('unexpected response')],
  ])(
    'releases the claim back to pending on a transient eligibility failure (%s)',
    async (_label, error) => {
      await intakeIssueOnce();
      const { attempt, task } = pendingAttempt();
      const devin = fakeDevin();
      const dispatchLogger = logger();
      const opts = dispatchOptions({
        devin,
        logger: dispatchLogger,
        github: { getIssue: vi.fn(() => Promise.reject(error)) },
      });

      const decision = await dispatchAttempt(attempt, task, opts);

      expect(decision).toBe('eligibility_check_deferred');
      expect(devin.createSession).not.toHaveBeenCalled();
      expect(getAttempt(attempt.id)).toMatchObject({ state: 'pending', dispatchedAt: null });
      expect(dispatchLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ attempt_id: attempt.id, reason: 'eligibility_check_deferred' }),
        'Released dispatch claim; eligibility check failed transiently and will be retried on the next poll'
      );

      const result = await runDispatchOnce(dispatchOptions({ devin }));
      expect(result).toMatchObject({ pending: 1, dispatched: 1, deferred: 0 });
      expect(devin.createSession).toHaveBeenCalledTimes(1);
      expect(getAttempt(attempt.id)?.state).toBe('session_created');
    }
  );

  it('counts deferred attempts in the dispatch summary', async () => {
    await intakeIssueOnce();
    const devin = fakeDevin();
    const result = await runDispatchOnce(
      dispatchOptions({
        devin,
        github: { getIssue: vi.fn(() => Promise.reject(new Error('ECONNRESET'))) },
      })
    );

    expect(result).toMatchObject({ pending: 1, dispatched: 0, deferred: 1, failed: 0 });
  });

  it('leaves the attempt in dispatching when createSession fails', async () => {
    await intakeIssueOnce();
    const { attempt, task } = pendingAttempt();
    const devin = fakeDevin();
    devin.createSession.mockRejectedValue(new Error('devin down'));
    const dispatchLogger = logger();
    const opts = dispatchOptions({ devin, logger: dispatchLogger });

    const decision = await dispatchAttempt(attempt, task, opts);

    expect(decision).toBe('session_create_failed');
    expect(devin.createSession).toHaveBeenCalledTimes(1);
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'dispatching',
      devinSessionId: null,
    });
    expect(dispatchLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempt_id: attempt.id }),
      'Devin session creation failed; attempt left in dispatching state'
    );
  });

  it('does not dispatch a task whose attempt history is completed', async () => {
    const task = upsertTask({ ...identity, issueNumber: 7 });
    const old = createAttempt(task.id);
    markDispatching(old.id);
    markSessionCreated(old.id, { devinSessionId: 'old' });
    markRunning(old.id);
    completeAttempt(old.id, 'succeeded');
    const before = getAttempt(old.id);

    const devin = fakeDevin();
    await intakeIssueOnce();
    const result = await runDispatchOnce(dispatchOptions({ devin }));

    expect(result.pending).toBe(0);
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(getAttempt(old.id)).toEqual(before);
    expect(listAttempts(task.id)).toHaveLength(1);
  });

  it('passes prompt, title, tags, and the ACU limit to createSession', async () => {
    await intakeIssueOnce();
    const { attempt, task } = pendingAttempt();
    const devin = fakeDevin();
    const opts = dispatchOptions({ devin, maxAcuPerSession: 7 });

    await dispatchAttempt(attempt, task, opts);

    expect(devin.createSession).toHaveBeenCalledTimes(1);
    const request = devin.createSession.mock.calls[0]?.[0];
    expect(request?.prompt).toContain('https://github.com/owner/repo');
    expect(request?.prompt).toContain('https://github.com/owner/repo/issues/7');
    expect(request?.prompt).toContain(attempt.correlationId);
    expect(request?.prompt).toContain('Something is broken');
    expect(request?.title).toBe('Remediate owner/repo#7: Fix the thing');
    expect(request?.tags).toEqual([
      'devin-superset-remediation',
      `task:${String(task.id)}`,
      `attempt:${String(attempt.id)}`,
      `correlation:${attempt.correlationId}`,
      'issue:owner/repo#7',
    ]);
    expect(request?.max_acu_limit).toBe(7);
  });

  it('truncates the session title to 120 characters', async () => {
    const task = upsertTask({ ...identity, issueNumber: 7 });
    const attempt = createAttempt(task.id);
    const longTitle = 'x'.repeat(200);
    const devin = fakeDevin();
    const opts = dispatchOptions({
      devin,
      github: { getIssue: vi.fn(() => Promise.resolve(issue({ title: longTitle }))) },
    });

    await dispatchAttempt(attempt, task, opts);

    const request = devin.createSession.mock.calls[0]?.[0];
    expect(request?.title).toHaveLength(120);
  });

  it('counts an unexpected per-attempt error under failed and continues', async () => {
    await intakeIssueOnce();
    const { attempt } = pendingAttempt();
    const dispatchLogger = logger();
    const devin = fakeDevin();
    const opts = dispatchOptions({ devin, logger: dispatchLogger });
    devin.createSession.mockImplementation(() => {
      // Concurrently completing the attempt makes markSessionCreated throw,
      // exercising the catch-all error path in runDispatchOnce.
      getDb().update(attempts).set({ state: 'completed', outcome: 'failed' }).run();
      return Promise.resolve({
        session_id: 'sess-1',
        url: 'https://app.devin.ai/sessions/sess-1',
        status: 'new',
        tags: [],
        org_id: 'org',
        created_at: 0,
        updated_at: 0,
      });
    });

    const result = await runDispatchOnce(opts);

    expect(result).toMatchObject({ pending: 1, dispatched: 0, failed: 1 });
    expect(dispatchLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempt_id: attempt.id }),
      'Devin session creation failed; attempt left in dispatching state'
    );
  });

  it('runs immediately and on intervals, and stop prevents later runs', async () => {
    vi.useFakeTimers();
    try {
      const task = upsertTask({ ...identity, issueNumber: 7 });
      createAttempt(task.id);
      const devin = fakeDevin();
      const github = { getIssue: vi.fn(() => Promise.resolve(issue())) };
      const poller = startDispatchPoller({
        ...dispatchOptions({ devin, github }),
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(devin.createSession).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(github.getIssue).toHaveBeenCalledTimes(1);
      await poller.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(devin.createSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips an overlapping poll run and stop awaits the in-flight run', async () => {
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(0);
      // Seed a pending attempt so dispatch has work that stays in flight.
      const task = upsertTask({ ...identity, issueNumber: 7 });
      createAttempt(task.id);

      let resolveIssue: ((value: GitHubIssue) => void) | undefined;
      const github = {
        getIssue: vi.fn(
          () =>
            new Promise<GitHubIssue>((resolve) => {
              resolveIssue = resolve;
            })
        ),
      };
      const devin = fakeDevin();
      const poller = startDispatchPoller({
        ...dispatchOptions({ devin, github }),
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(github.getIssue).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(github.getIssue).toHaveBeenCalledTimes(1);

      const stop = poller.stop();
      let stopResolved = false;
      void stop.then(() => {
        stopResolved = true;
      });
      await Promise.resolve();
      expect(stopResolved).toBe(false);

      resolveIssue?.(issue());
      await stop;
      expect(stopResolved).toBe(true);
      expect(devin.createSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('prompt and tag builders', () => {
  it('includes identifiers and a body fallback', () => {
    const task = {
      id: 3,
      repoOwner: 'owner',
      repoName: 'repo',
      issueNumber: 7,
      title: null,
      createdAt: 0,
      updatedAt: 0,
    } satisfies Task;
    const attempt = {
      id: 4,
      taskId: 3,
      attemptNumber: 1,
      correlationId: 'corr-1',
      state: 'dispatching',
      outcome: null,
      outcomeReason: null,
      devinSessionId: null,
      devinSessionUrl: null,
      prUrl: null,
      createdAt: 0,
      updatedAt: 0,
      dispatchedAt: null,
      sessionCreatedAt: null,
      completedAt: null,
    } satisfies Attempt;

    const prompt = buildSessionPrompt(task, issue({ body: null }), attempt);
    expect(prompt).toContain('corr-1');
    expect(prompt).toContain('(no description)');
    expect(buildSessionTags(task, attempt)).toContain('correlation:corr-1');
  });
});
