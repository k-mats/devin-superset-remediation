import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, getRawDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import { DevinApiError, type SessionResponse } from '../src/devin/client.js';
import {
  createAttempt,
  getAttempt,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  listVerifications,
  upsertTask,
} from '../src/db/task-state.js';
import { GitHubApiError, type GitHubPullRequest } from '../src/github/client.js';
import { runTrackingOnce, toEpochMs } from '../src/tracking/session-tracker.js';

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
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001,
    ...overrides,
  };
}

function pullRequest(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 12,
    html_url: 'https://github.com/owner/repo/pull/12',
    title: 'Fixes #7',
    state: 'open',
    merged_at: null,
    body: null,
    head: { sha: 'sha-1' },
    base: { repo: { full_name: 'owner/repo' } },
    ...overrides,
  };
}

function activeAttempt(issueNumber = 7) {
  const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber });
  const attempt = createAttempt(task.id);
  markDispatching(attempt.id);
  return {
    task,
    attempt: markSessionCreated(attempt.id, {
      devinSessionId: `sess-${String(issueNumber)}`,
    }),
  };
}

describe('session tracker', () => {
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

  it('normalizes Devin seconds timestamps and records a running snapshot', async () => {
    expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    const { task, attempt } = activeAttempt();
    const log = logger();
    const result = await runTrackingOnce({
      devin: {
        getSession: vi
          .fn()
          .mockResolvedValue(session({ status: 'running', status_detail: 'working' })),
      },
      github: { getPullRequest: vi.fn() },
      logger: log,
      staleWarnMs: 0,
    });

    expect(result.markedRunning).toBe(1);
    expect(getAttempt(attempt.id)).toMatchObject({
      taskId: task.id,
      state: 'running',
      devinSessionStatus: 'running',
      sessionUpdatedAt: 1_700_000_001_000,
    });
  });

  it('completes a no-action structured outcome', async () => {
    const { attempt } = activeAttempt();
    await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(
          session({
            structured_output: {
              schema_version: 1,
              outcome: 'no_action',
              pr_url: null,
              diagnosis: 'Not applicable',
              tests_run: [],
              risks: [],
              needs_human_reason: null,
            },
          })
        ),
      },
      github: { getPullRequest: vi.fn() },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'completed',
      outcome: 'no_action',
      agentOutcome: 'no_action',
    });
  });

  it('records a verified pull request and enters verifying', async () => {
    const { attempt } = activeAttempt();
    const github = vi.fn().mockResolvedValue(pullRequest());
    await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(
          session({
            structured_output: {
              schema_version: 1,
              outcome: 'remediated',
              pr_url: 'https://github.com/owner/repo/pull/12',
              diagnosis: 'Fixed',
              tests_run: [],
              risks: [],
              needs_human_reason: null,
            },
          })
        ),
      },
      github: { getPullRequest: github },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'verifying',
      outcome: null,
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    expect(github).toHaveBeenCalledTimes(1);
  });

  it('isolates a failed attempt from the rest of the tracking pass', async () => {
    const first = activeAttempt(7);
    const second = activeAttempt(8);
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary Devin failure'))
      .mockResolvedValueOnce(session({ status: 'running', status_detail: 'working' }));
    const result = await runTrackingOnce({
      devin: { getSession },
      github: { getPullRequest: vi.fn() },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(result.failed).toBe(1);
    expect(result.markedRunning).toBe(1);
    expect(getAttempt(first.attempt.id)?.state).toBe('session_created');
    expect(getAttempt(second.attempt.id)?.state).toBe('running');
  });

  it('refreshes a verifying pull request when Devin session lookup fails', async () => {
    const { task, attempt } = activeAttempt(9);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'old-sha',
    });
    markVerifying(attempt.id);
    const github = vi.fn().mockResolvedValue(
      pullRequest({
        state: 'closed',
        merged_at: '2026-01-01T00:00:00Z',
        head: { sha: 'merged-sha' },
      })
    );

    const result = await runTrackingOnce({
      devin: {
        getSession: vi
          .fn()
          .mockRejectedValue(new DevinApiError(404, 'GET', '/sessions/sess-9', 'missing')),
      },
      github: { getPullRequest: github },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(result.prRefreshed).toBe(1);
    expect(github).toHaveBeenCalledWith('owner', 'repo', 12);
    expect(getAttempt(attempt.id)).toMatchObject({
      taskId: task.id,
      state: 'verifying',
      prState: 'merged',
      prHeadSha: 'merged-sha',
    });
  });

  it('escalates terminal PR lookup rejection but defers rate-limited lookup', async () => {
    const first = activeAttempt(10);
    const second = activeAttempt(11);
    const output = (issueNumber: number) => ({
      schema_version: 1 as const,
      outcome: 'remediated' as const,
      pr_url: `https://github.com/owner/repo/pull/${String(issueNumber)}`,
      diagnosis: 'Fixed',
      tests_run: [],
      risks: [],
      needs_human_reason: null,
    });
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(session({ structured_output: output(10) }))
      .mockResolvedValueOnce(session({ structured_output: output(11) }));
    const getPullRequest = vi
      .fn()
      .mockRejectedValueOnce(new GitHubApiError(403, 'GET', '/pulls/10', 'forbidden'))
      .mockRejectedValueOnce(new GitHubApiError(403, 'GET', '/pulls/11', 'rate limited', true));

    await runTrackingOnce({
      devin: { getSession },
      github: { getPullRequest },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(getAttempt(first.attempt.id)).toMatchObject({
      state: 'completed',
      outcome: 'escalated',
      outcomeReason: 'pr_lookup_rejected: https://github.com/owner/repo/pull/10',
    });
    expect(getAttempt(second.attempt.id)).toMatchObject({
      state: 'session_created',
      outcome: null,
      agentOutcome: 'remediated',
    });
  });

  it('warns about stale running sessions but not verifying attempts', async () => {
    const verifying = activeAttempt(12);
    markRunning(verifying.attempt.id);
    recordPullRequest(verifying.attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(verifying.attempt.id);
    const running = activeAttempt(13);
    markRunning(running.attempt.id);
    const log = logger();
    const oldUpdatedAt = Math.floor((Date.now() - 10_000) / 1000);
    const rawDb = getRawDb();
    if (!rawDb) throw new Error('Raw database was not initialized');
    rawDb
      .prepare('UPDATE attempts SET session_created_at = ? WHERE id IN (?, ?)')
      .run(Date.now() - 10_000, verifying.attempt.id, running.attempt.id);

    await runTrackingOnce({
      devin: {
        getSession: vi
          .fn()
          .mockResolvedValueOnce(session({ updated_at: oldUpdatedAt, status: 'exit' }))
          .mockResolvedValueOnce(session({ updated_at: oldUpdatedAt, status: 'running' })),
      },
      github: { getPullRequest: vi.fn().mockResolvedValue(pullRequest()) },
      logger: log,
      staleWarnMs: 1_000,
    });

    const staleWarnings = log.warn.mock.calls.filter(
      ([, message]) =>
        message === 'Devin session has not updated for longer than the stale threshold'
    );
    expect(staleWarnings).toHaveLength(1);
    expect(staleWarnings[0]?.[0]).toMatchObject({ attempt_id: running.attempt.id });
  });
});

describe('independent verification integration', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
    db.delete(verifications).run();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  const verificationOpts = (overrides: Record<string, unknown> = {}) => ({
    workspaceRoot: '/tmp/verify-tracker-test',
    commandTimeoutMs: 5_000,
    setupTimeoutMs: 5_000,
    checkoutTimeoutMs: 5_000,
    maxOutputBytes: 4096,
    runCommand: vi.fn().mockResolvedValue({
      status: 'passed',
      exitCode: 0,
      output: 'ok',
      startedAt: 1,
      finishedAt: 2,
    }),
    checkout: vi.fn().mockResolvedValue(undefined),
    resolveAdapter: vi.fn().mockReturnValue({ name: 'noop', setup: vi.fn().mockResolvedValue({}) }),
    ...overrides,
  });

  const githubWithVerification = () => ({
    getPullRequest: vi.fn().mockResolvedValue(pullRequest()),
    getIssue: vi.fn().mockResolvedValue({
      number: 7,
      title: 't',
      state: 'open',
      html_url: 'u',
      labels: [],
      body: '## Verification\n\n```bash\necho ok\n```\n',
    }),
    listCheckRuns: vi.fn().mockResolvedValue({ total_count: 0, check_runs: [] }),
    getCombinedStatus: vi
      .fn()
      .mockResolvedValue({ state: 'success', total_count: 0, statuses: [] }),
  });

  it('runs verification for a verifying attempt with a refreshed PR', async () => {
    const { attempt } = activeAttempt(20);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);

    const result = await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(session({ status: 'exit' })),
      },
      github: githubWithVerification(),
      logger: logger(),
      staleWarnMs: 0,
      verification: verificationOpts(),
    });

    expect(result.verificationPassed).toBe(1);
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'completed',
      outcome: 'succeeded',
    });
    expect(listVerifications(attempt.id).filter((row) => row.kind === 'command')).toHaveLength(1);
  });

  it('does not run verification when verification is disabled', async () => {
    const { attempt } = activeAttempt(21);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);

    const result = await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(session({ status: 'exit' })),
      },
      github: githubWithVerification(),
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(result.verificationPassed).toBe(0);
    expect(getAttempt(attempt.id)?.state).toBe('verifying');
    expect(listVerifications(attempt.id)).toHaveLength(0);
  });

  it('stays verifying when the verification command fails', async () => {
    const { attempt } = activeAttempt(22);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);

    const result = await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(session({ status: 'exit' })),
      },
      github: githubWithVerification(),
      logger: logger(),
      staleWarnMs: 0,
      verification: verificationOpts({
        runCommand: vi.fn().mockResolvedValue({
          status: 'failed',
          exitCode: 1,
          output: 'bad',
          startedAt: 1,
          finishedAt: 2,
        }),
      }),
    });

    expect(result.verificationFailed).toBe(1);
    expect(getAttempt(attempt.id)?.state).toBe('verifying');
  });
});
