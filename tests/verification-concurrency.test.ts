import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import {
  approveVerificationSpec,
  createAttempt,
  getAttempt,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import type { GitHubClient } from '../src/github/client.js';
import { createWorkspaceLock } from '../src/verification/workspace-lock.js';
import {
  verifyRemediationOnce,
  type VerifyRemediationOptions,
} from '../src/verification/verify-remediation.js';
import { hashVerificationSpec } from '../src/verification/spec.js';
import type { CommandRunResult } from '../src/verification/runner.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createVerifyingAttempt(headSha: string, issueNumber: number) {
  const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber });
  const created = createAttempt(task.id);
  markDispatching(created.id);
  markSessionCreated(created.id, { devinSessionId: `session-${String(created.id)}` });
  markRunning(created.id);
  recordPullRequest(created.id, {
    prUrl: 'https://github.com/owner/repo/pull/1',
    prNumber: 1,
    prState: 'open',
    prHeadSha: headSha,
  });
  const attempt = markVerifying(created.id);
  const script = 'echo ok';
  const sha256 = hashVerificationSpec('sh', script);
  setVerificationCandidate(attempt.id, { shell: 'sh', script }, 'operator');
  approveVerificationSpec(attempt.id, sha256, 'operator');
  return { task, attempt: getAttempt(attempt.id) ?? attempt, sha256 };
}

function github() {
  return {
    getIssue: vi.fn().mockResolvedValue({
      number: 64,
      title: 'Verification',
      state: 'open',
      html_url: 'https://github.com/owner/repo/issues/64',
      labels: [],
      body: 'No issue verification section',
    }),
    getPullRequest: vi.fn().mockResolvedValue({
      number: 1,
      html_url: 'https://github.com/owner/repo/pull/1',
      title: 'Pull request',
      state: 'open' as const,
      merged_at: null,
      body: null,
      head: { sha: 'unused' },
      base: { repo: { full_name: 'owner/repo' } },
    }),
    listCheckRuns: vi.fn().mockResolvedValue({ total_count: 0, check_runs: [] }),
    getCombinedStatus: vi.fn().mockResolvedValue({
      state: 'pending',
      total_count: 0,
      statuses: [],
    }),
  } as unknown as Pick<
    GitHubClient,
    'getIssue' | 'getPullRequest' | 'listCheckRuns' | 'getCombinedStatus'
  >;
}

function baseOptions(
  githubClient: VerifyRemediationOptions['github'],
  overrides: Partial<VerifyRemediationOptions> = {}
): VerifyRemediationOptions {
  return {
    github: githubClient,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db: getDb(),
    workspaceRoot: '/tmp/verification-concurrency',
    commandTimeoutMs: 5_000,
    setupTimeoutMs: 5_000,
    checkoutTimeoutMs: 5_000,
    maxOutputBytes: 4096,
    checkout: vi.fn().mockResolvedValue(undefined),
    resolveAdapter: vi.fn().mockReturnValue({
      name: 'noop',
      setup: vi.fn().mockResolvedValue({}),
    }),
    runCommand: vi.fn().mockResolvedValue({
      status: 'passed',
      exitCode: 0,
      output: 'ok',
      startedAt: 1,
      finishedAt: 2,
    } satisfies CommandRunResult),
    ...overrides,
  };
}

describe('verification workspace concurrency', () => {
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

  it('serializes checkout and command execution per repository workspace', async () => {
    const first = createVerifyingAttempt('head-a', 64);
    const second = createVerifyingAttempt('head-b', 65);
    const lock = createWorkspaceLock();
    const commandRelease = deferred<string>();
    const events: string[] = [];
    let currentHead = '';
    const checkout = vi.fn(({ headSha }: { headSha: string }) => {
      events.push(`checkout:${headSha}`);
      currentHead = headSha;
      return Promise.resolve();
    });
    const runCommand = vi.fn(async (approved: { sha256: string }) => {
      events.push(`run:${approved.sha256}@${currentHead}`);
      await commandRelease.promise;
      return {
        status: 'passed',
        exitCode: 0,
        output: 'ok',
        startedAt: 1,
        finishedAt: 2,
      } satisfies CommandRunResult;
    });

    const firstPromise = verifyRemediationOnce(
      first.attempt,
      first.task,
      baseOptions(github(), { workspaceLock: lock, checkout, runCommand })
    );
    const secondPromise = verifyRemediationOnce(
      second.attempt,
      second.task,
      baseOptions(github(), { workspaceLock: lock, checkout, runCommand })
    );

    while (events.length < 2) await Promise.resolve();
    expect(events).toEqual([`checkout:head-a`, `run:${first.sha256}@head-a`]);
    commandRelease.resolve('released');
    await Promise.all([firstPromise, secondPromise]);
    expect(events).toEqual([
      `checkout:head-a`,
      `run:${first.sha256}@head-a`,
      `checkout:head-b`,
      `run:${second.sha256}@head-b`,
    ]);
  });

  it('shows the interleaving prevented by the workspace lock with a no-op lock', async () => {
    const first = createVerifyingAttempt('head-a', 64);
    const second = createVerifyingAttempt('head-b', 65);
    const commandRelease = deferred<string>();
    const setupRelease = deferred<string>();
    const events: string[] = [];
    let currentHead = '';
    const checkout = vi.fn(({ headSha }: { headSha: string }) => {
      events.push(`checkout:${headSha}`);
      currentHead = headSha;
      return Promise.resolve();
    });
    const runCommand = vi.fn(async () => {
      events.push(`run@${currentHead}`);
      await commandRelease.promise;
      return {
        status: 'passed',
        exitCode: 0,
        output: 'ok',
        startedAt: 1,
        finishedAt: 2,
      } satisfies CommandRunResult;
    });
    const resolveAdapter = vi.fn().mockReturnValue({
      name: 'noop',
      setup: vi.fn(async () => {
        await setupRelease.promise;
        return {};
      }),
    });
    const noOpLock = { run: <T>(_key: string, fn: () => Promise<T>) => fn() };

    const firstPromise = verifyRemediationOnce(
      first.attempt,
      first.task,
      baseOptions(github(), { workspaceLock: noOpLock, checkout, runCommand, resolveAdapter })
    );
    const secondPromise = verifyRemediationOnce(
      second.attempt,
      second.task,
      baseOptions(github(), { workspaceLock: noOpLock, checkout, runCommand, resolveAdapter })
    );

    while (events.length < 2) await Promise.resolve();
    setupRelease.resolve('released');
    while (events.length < 4) await Promise.resolve();
    expect(events).toEqual(['checkout:head-a', 'checkout:head-b', 'run@head-b', 'run@head-b']);
    commandRelease.resolve('released');
    await Promise.all([firstPromise, secondPromise]);
  });

  it('skips a waiter whose attempt head changed while it waited', async () => {
    const first = createVerifyingAttempt('head-a', 64);
    const second = createVerifyingAttempt('head-b', 65);
    const lock = createWorkspaceLock();
    const commandRelease = deferred<string>();
    const events: string[] = [];
    const checkout = vi.fn(({ headSha }: { headSha: string }) => {
      events.push(`checkout:${headSha}`);
      return Promise.resolve();
    });
    const runCommand = vi.fn(async () => {
      events.push('run:first');
      await commandRelease.promise;
      return {
        status: 'passed',
        exitCode: 0,
        output: 'ok',
        startedAt: 1,
        finishedAt: 2,
      } satisfies CommandRunResult;
    });

    const firstPromise = verifyRemediationOnce(
      first.attempt,
      first.task,
      baseOptions(github(), { workspaceLock: lock, checkout, runCommand })
    );
    const secondPromise = verifyRemediationOnce(
      second.attempt,
      second.task,
      baseOptions(github(), { workspaceLock: lock, checkout, runCommand })
    );
    while (events.length < 2) await Promise.resolve();
    recordPullRequest(second.attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 1,
      prState: 'open',
      prHeadSha: 'head-b-new',
    });
    commandRelease.resolve('released');

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult).toBe('verification_passed');
    expect(secondResult).toBe('verification_skipped');
    expect(events).toEqual(['checkout:head-a', 'run:first']);
    expect(checkout).toHaveBeenCalledTimes(1);
  });
});
