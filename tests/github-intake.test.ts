import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import type { GitHubIssue } from '../src/github/client.js';
import {
  intakeIssue,
  isEligibleIssue,
  runIntakeOnce,
  startIntakePoller,
  type GitHubIntakeOptions,
} from '../src/intake/github-intake.js';
import type { Db } from '../src/db/task-state.js';
import { ActiveAttemptExistsError } from '../src/db/task-state.js';
import {
  completeAttempt,
  createAttempt,
  getTaskByIdentity,
  listAttempts,
  markDispatching,
  markRunning,
  markSessionCreated,
  upsertTask,
} from '../src/db/task-state.js';

const identity = { repoOwner: 'owner', repoName: 'repo' };

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 7,
    title: 'Fix the thing',
    state: 'open',
    html_url: 'https://github.com/owner/repo/issues/7',
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

function options(
  client: Pick<GitHubIntakeOptions['client'], 'listOpenIssuesByLabel'>,
  overrides: Partial<GitHubIntakeOptions> = {}
): GitHubIntakeOptions {
  return {
    client: client as GitHubIntakeOptions['client'],
    ...identity,
    label: 'devin-ready',
    logger: logger(),
    db: getDb(),
    ...overrides,
  };
}

describe('GitHub intake', () => {
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

  it('creates a task and pending attempt for an eligible issue', async () => {
    const result = await runIntakeOnce(
      options({ listOpenIssuesByLabel: vi.fn().mockResolvedValue([issue()]) })
    );

    expect(result).toMatchObject({ fetched: 1, created: 1, skipped: 0, ineligible: 0 });
    const task = getTaskByIdentity({ ...identity, issueNumber: 7 });
    expect(task).toBeDefined();
    expect(task && listAttempts(task.id)).toHaveLength(1);
    expect(task && listAttempts(task.id)[0]?.state).toBe('pending');
  });

  it('does not create a second attempt when polling the same issue repeatedly', async () => {
    const client = { listOpenIssuesByLabel: vi.fn().mockResolvedValue([issue()]) };
    for (let count = 0; count < 5; count += 1) {
      await runIntakeOnce(options(client));
    }

    const task = getTaskByIdentity({ ...identity, issueNumber: 7 });
    expect(task && listAttempts(task.id)).toHaveLength(1);
    expect(getDb().select().from(tasks).all()).toHaveLength(1);
  });

  it.each(['succeeded', 'failed', 'cancelled', 'escalated'] as const)(
    'does not create an attempt for a completed %s attempt',
    async (outcome) => {
      const task = upsertTask({ ...identity, issueNumber: 7 });
      const attempt = createAttempt(task.id);
      markDispatching(attempt.id);
      if (outcome === 'succeeded') {
        markSessionCreated(attempt.id, { devinSessionId: `session-${outcome}` });
        markRunning(attempt.id);
      }
      completeAttempt(attempt.id, outcome);

      const result = await runIntakeOnce(
        options({ listOpenIssuesByLabel: vi.fn().mockResolvedValue([issue()]) })
      );

      expect(result.skipped).toBe(1);
      expect(listAttempts(task.id)).toHaveLength(1);
    }
  );

  it('does not create an attempt for an active attempt', async () => {
    const task = upsertTask({ ...identity, issueNumber: 7 });
    const running = createAttempt(task.id);
    markDispatching(running.id);
    markSessionCreated(running.id, { devinSessionId: 'running-session' });
    markRunning(running.id);

    const result = await runIntakeOnce(
      options({ listOpenIssuesByLabel: vi.fn().mockResolvedValue([issue()]) })
    );

    expect(result.skipped).toBe(1);
    expect(listAttempts(task.id)).toHaveLength(1);
  });

  it('reports a concurrent active-attempt conflict as a skip, not an error', async () => {
    const task = upsertTask({ ...identity, issueNumber: 7 });
    const conflictingDb = {
      transaction: () => {
        throw new ActiveAttemptExistsError(task.id);
      },
    } as unknown as Db;

    const decision = intakeIssue(issue(), identity, conflictingDb);
    expect(decision).toBe('skipped_active_attempt_conflict');
    expect(listAttempts(task.id)).toHaveLength(0);

    const intakeLogger = logger();
    const result = await runIntakeOnce(
      options(
        { listOpenIssuesByLabel: vi.fn().mockResolvedValue([issue()]) },
        { db: conflictingDb, logger: intakeLogger }
      )
    );

    expect(result).toMatchObject({ fetched: 1, created: 0, skipped: 1, ineligible: 0 });
    expect(intakeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, reason: 'active_attempt_conflict' }),
      'Skipped GitHub issue with existing attempt history'
    );
    expect(intakeLogger.error).not.toHaveBeenCalled();
  });

  it('creates the first attempt for an existing task with no history', async () => {
    const task = upsertTask({ ...identity, issueNumber: 7 });
    const result = await runIntakeOnce(
      options({ listOpenIssuesByLabel: vi.fn().mockResolvedValue([issue()]) })
    );

    expect(result.created).toBe(1);
    expect(listAttempts(task.id)).toHaveLength(1);
  });

  it.each([issue({ pull_request: {} }), issue({ state: 'closed' }), issue({ labels: [] })])(
    'ignores an ineligible issue',
    async (ineligible) => {
      const result = await runIntakeOnce(
        options({ listOpenIssuesByLabel: vi.fn().mockResolvedValue([ineligible]) })
      );

      expect(result).toMatchObject({ fetched: 1, created: 0, skipped: 0, ineligible: 1 });
      expect(getDb().select().from(tasks).all()).toHaveLength(0);
      expect(isEligibleIssue(ineligible, 'devin-ready')).toBe(false);
    }
  );

  it('uses the open state query while defensively ignoring closed responses', async () => {
    const client = {
      listOpenIssuesByLabel: vi.fn().mockResolvedValue([issue({ state: 'closed' })]),
    };
    const result = await runIntakeOnce(options(client));

    expect(result.ineligible).toBe(1);
    expect(client.listOpenIssuesByLabel).toHaveBeenCalledWith('owner', 'repo', 'devin-ready');
  });

  it('returns API and network errors without changing existing rows', async () => {
    const task = upsertTask({ ...identity, issueNumber: 7, title: 'Original' });
    const attempt = createAttempt(task.id);
    const before = {
      tasks: getDb().select().from(tasks).all(),
      attempts: getDb().select().from(attempts).all(),
    };
    for (const error of [new Error('GitHub API 500'), new Error('network failed')]) {
      const result = await runIntakeOnce(
        options({
          listOpenIssuesByLabel: vi.fn().mockRejectedValue(error),
        })
      );
      expect(result.error).toBe(error.message);
      expect(getDb().select().from(tasks).all()).toEqual(before.tasks);
      expect(getDb().select().from(attempts).all()).toEqual(before.attempts);
    }
    expect(attempt.id).toBe(before.attempts[0]?.id);
  });

  it('rolls back a brand-new task if creating its attempt fails', () => {
    const sqlite = getDb();
    expect(() => {
      sqlite.transaction((tx) => {
        const task = upsertTask({ ...identity, issueNumber: 7, title: 'Atomic' }, tx);
        createAttempt(task.id, tx);
        tx.insert(attempts)
          .values({
            taskId: task.id,
            attemptNumber: 1,
            correlationId: randomUUID(),
            state: 'pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
      });
    }).toThrow();
    expect(getTaskByIdentity({ ...identity, issueNumber: 7 })).toBeUndefined();
  });

  it('runs immediately and on intervals, and stop prevents later runs', async () => {
    vi.useFakeTimers();
    try {
      const client = { listOpenIssuesByLabel: vi.fn().mockResolvedValue([]) };
      const poller = startIntakePoller({ ...options(client), intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.listOpenIssuesByLabel).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.listOpenIssuesByLabel).toHaveBeenCalledTimes(2);
      await poller.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(client.listOpenIssuesByLabel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips an overlapping poll run', async () => {
    vi.useFakeTimers();
    try {
      let resolve: (() => void) | undefined;
      const client = {
        listOpenIssuesByLabel: vi.fn(
          () =>
            new Promise<GitHubIssue[]>((complete) => {
              resolve = () => {
                complete([]);
              };
            })
        ),
      };
      const poller = startIntakePoller({ ...options(client), intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.listOpenIssuesByLabel).toHaveBeenCalledTimes(1);
      resolve?.();
      await vi.advanceTimersByTimeAsync(0);
      await poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for an in-flight run before stop resolves', async () => {
    vi.useFakeTimers();
    try {
      let resolveIssues: ((issues: GitHubIssue[]) => void) | undefined;
      const client = {
        listOpenIssuesByLabel: vi.fn(
          () =>
            new Promise<GitHubIssue[]>((resolve) => {
              resolveIssues = resolve;
            })
        ),
      };
      const intakeLogger = logger();
      const poller = startIntakePoller({
        ...options(client, { logger: intakeLogger }),
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(0);

      const stop = poller.stop();
      let stopResolved = false;
      void stop.then(() => {
        stopResolved = true;
      });
      await Promise.resolve();
      expect(stopResolved).toBe(false);

      resolveIssues?.([]);
      await stop;
      expect(stopResolved).toBe(true);
      expect(intakeLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ fetched: 0, created: 0, skipped: 0, ineligible: 0 }),
        'GitHub intake completed'
      );

      await vi.advanceTimersByTimeAsync(3000);
      expect(client.listOpenIssuesByLabel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
