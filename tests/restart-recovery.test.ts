import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import type { SessionResponse } from '../src/devin/client.js';
import { DevinApiError } from '../src/devin/client.js';
import {
  createAttempt,
  getAttempt,
  listVerifications,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  recordVerification,
  upsertTask,
} from '../src/db/task-state.js';
import { runDispatchOnce } from '../src/dispatch/devin-dispatcher.js';
import { runTrackingOnce } from '../src/tracking/session-tracker.js';
import type { GitHubPullRequest } from '../src/github/client.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function session(overrides: Partial<SessionResponse> = {}): SessionResponse {
  return {
    session_id: 'sess-1',
    url: 'https://app.devin.ai/sessions/sess-1',
    status: 'running',
    status_detail: 'working',
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

function fakeGitHub(pr = pullRequest()) {
  return {
    getIssue: vi.fn(),
    getPullRequest: vi.fn().mockResolvedValue(pr),
  };
}

function fakeDevin() {
  return {
    createSession: vi.fn(),
    getSession: vi.fn().mockResolvedValue(session()),
    listSessions: vi.fn().mockResolvedValue({ items: [] }),
  };
}

function restart() {
  // Close and reopen the same file-backed database to simulate a process restart.
  closeDb();
  runMigrations();
  return getDb();
}

describe('restart recovery', () => {
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

  it.each(['session_created', 'running'] as const)(
    'resumes tracking a persisted %s attempt without creating a session or dispatching',
    async (state) => {
      const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 7 });
      const attempt = createAttempt(task.id);
      markDispatching(attempt.id);
      markSessionCreated(attempt.id, { devinSessionId: 'sess-7' });
      if (state === 'running') markRunning(attempt.id);

      restart();

      const devin = fakeDevin();
      const github = fakeGitHub();
      const result = await runTrackingOnce({
        devin,
        github,
        logger: logger(),
        staleWarnMs: 0,
      });

      expect(result.trackable).toBe(1);
      expect(result.failed).toBe(0);
      expect(devin.getSession).toHaveBeenCalledWith('sess-7');
      expect(devin.createSession).not.toHaveBeenCalled();
      // A running session snapshot moves session_created to running; an
      // already-running attempt stays running.
      expect(getAttempt(attempt.id)?.state).toBe('running');

      const dispatch = await runDispatchOnce({
        github,
        devin,
        label: 'devin-ready',
        maxAcuPerSession: 5,
        logger: logger(),
      });
      expect(dispatch).toMatchObject({ pending: 0, dispatched: 0 });
      expect(devin.createSession).not.toHaveBeenCalled();
      expect(github.getIssue).not.toHaveBeenCalled();
    }
  );

  it('resumes PR processing for a persisted verifying attempt even when the session lookup fails', async () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 8 });
    const attempt = createAttempt(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'sess-8' });
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'old-sha',
    });
    markVerifying(attempt.id);

    restart();

    const devin = fakeDevin();
    devin.getSession.mockRejectedValue(
      new DevinApiError(503, 'GET', '/sessions/sess-8', 'unavailable')
    );
    const github = fakeGitHub(pullRequest({ head: { sha: 'new-sha' } }));

    const result = await runTrackingOnce({
      devin,
      github,
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(result.prRefreshed).toBe(1);
    expect(github.getPullRequest).toHaveBeenCalledWith('owner', 'repo', 12);
    expect(devin.createSession).not.toHaveBeenCalled();
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'verifying',
      prState: 'open',
      prHeadSha: 'new-sha',
    });
  });

  it('keeps a completed attempt and its verification history unchanged after restart', async () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 9 });
    const attempt = createAttempt(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'sess-9' });
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'old-sha',
    });
    recordVerification({
      attemptId: attempt.id,
      headSha: 'old-sha',
      kind: 'command',
      status: 'passed',
      specShell: 'sh',
      specScript: 'echo ok',
      specSha256: 'sha256-1',
    });
    getDb()
      .update(attempts)
      .set({ outcome: 'succeeded', state: 'completed', completedAt: Date.now() })
      .run();

    const before = getAttempt(attempt.id);
    const beforeVerifications = listVerifications(attempt.id);

    restart();

    const devin = fakeDevin();
    const github = fakeGitHub(pullRequest({ head: { sha: 'new-sha' } }));
    const result = await runTrackingOnce({
      devin,
      github,
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(result.trackable).toBe(0);
    expect(result.prRefreshed).toBe(1);
    expect(github.getPullRequest).toHaveBeenCalledWith('owner', 'repo', 12);
    expect(devin.getSession).not.toHaveBeenCalled();
    expect(devin.createSession).not.toHaveBeenCalled();

    const after = getAttempt(attempt.id);
    expect(after).toMatchObject({
      state: 'completed',
      outcome: before?.outcome,
      outcomeReason: before?.outcomeReason ?? null,
      completedAt: before?.completedAt,
      devinSessionId: 'sess-9',
      prNumber: 12,
      prState: 'open',
    });
    expect(listVerifications(attempt.id)).toEqual(beforeVerifications);
  });
});
