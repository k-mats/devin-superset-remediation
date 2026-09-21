import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import {
  approveVerificationSpec,
  createAttempt,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import { rerunApprovedVerification } from '../src/verification/rerun.js';
import { hashVerificationSpec } from '../src/verification/spec.js';
import type { GitHubClient } from '../src/github/client.js';
import type { verifyRemediationOnce } from '../src/verification/verify-remediation.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('rerunApprovedVerification', () => {
  beforeEach(() => {
    runMigrations();
    getDb().delete(verifications).run();
    getDb().delete(attempts).run();
    getDb().delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  it('refreshes the PR before invoking the verifier with the new head', async () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 64 });
    const created = createAttempt(task.id);
    markDispatching(created.id);
    markSessionCreated(created.id, { devinSessionId: 'session' });
    markRunning(created.id);
    recordPullRequest(created.id, {
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 1,
      prState: 'open',
      prHeadSha: 'old',
    });
    const attempt = markVerifying(created.id);
    const script = 'echo ok';
    const spec = { shell: 'sh' as const, script, sha256: hashVerificationSpec('sh', script) };
    setVerificationCandidate(attempt.id, spec, 'operator');
    approveVerificationSpec(attempt.id, spec.sha256, 'operator');
    const order: string[] = [];
    const verifyMock = vi.fn((refreshed: Parameters<typeof verifyRemediationOnce>[0]) => {
      order.push(`verify:${String(refreshed.prHeadSha)}`);
      return Promise.resolve('verification_failed' as const);
    });
    const github = {
      getIssue: vi.fn(),
      listCheckRuns: vi.fn(),
      getCombinedStatus: vi.fn(),
      getPullRequest: vi.fn(() => {
        order.push('github');
        return Promise.resolve({
          number: 1,
          html_url: 'https://github.com/owner/repo/pull/1',
          state: 'open' as const,
          merged_at: null,
          head: { sha: 'new' },
        });
      }),
    } as unknown as Pick<
      GitHubClient,
      'getIssue' | 'getPullRequest' | 'listCheckRuns' | 'getCombinedStatus'
    >;
    const result = await rerunApprovedVerification(attempt.id, {
      github,
      logger,
      db: getDb(),
      workspaceRoot: './data/test-verification',
      commandTimeoutMs: 100,
      setupTimeoutMs: 100,
      checkoutTimeoutMs: 100,
      maxOutputBytes: 1000,
      verify: verifyMock,
    });
    expect(result).toMatchObject({ ok: true, decision: 'verification_failed' });
    expect(order).toEqual(['github', 'verify:new']);
    expect(verifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ prHeadSha: 'new' }),
      expect.objectContaining({ id: task.id }),
      expect.objectContaining({ rerun: true })
    );
  });

  it('returns a refresh failure without invoking verification', async () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 64 });
    const created = createAttempt(task.id);
    markDispatching(created.id);
    markSessionCreated(created.id, { devinSessionId: 'session' });
    markRunning(created.id);
    recordPullRequest(created.id, {
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 1,
      prState: 'open',
      prHeadSha: 'old',
    });
    const attempt = markVerifying(created.id);
    const script = 'echo ok';
    const spec = { shell: 'sh' as const, script, sha256: hashVerificationSpec('sh', script) };
    setVerificationCandidate(attempt.id, spec, 'operator');
    approveVerificationSpec(attempt.id, spec.sha256, 'operator');
    const refreshError = new Error('GitHub unavailable');
    const verify = vi.fn();
    const github = {
      getIssue: vi.fn(),
      listCheckRuns: vi.fn(),
      getCombinedStatus: vi.fn(),
      getPullRequest: vi.fn().mockRejectedValue(refreshError),
    } as unknown as Pick<
      GitHubClient,
      'getIssue' | 'getPullRequest' | 'listCheckRuns' | 'getCombinedStatus'
    >;
    const result = await rerunApprovedVerification(attempt.id, {
      github,
      logger,
      db: getDb(),
      workspaceRoot: './data/test-verification',
      commandTimeoutMs: 100,
      setupTimeoutMs: 100,
      checkoutTimeoutMs: 100,
      maxOutputBytes: 1000,
      verify,
    });
    expect(result).toEqual({ ok: false, reason: 'pull_request_refresh_failed' });
    expect(verify).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { attemptId: attempt.id, err: refreshError },
      'pull request refresh failed'
    );
  });

  it('propagates errors recording a successfully refreshed PR', async () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 64 });
    const created = createAttempt(task.id);
    markDispatching(created.id);
    markSessionCreated(created.id, { devinSessionId: 'session' });
    markRunning(created.id);
    recordPullRequest(created.id, {
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 1,
      prState: 'open',
      prHeadSha: 'old',
    });
    const attempt = markVerifying(created.id);
    const script = 'echo ok';
    const spec = { shell: 'sh' as const, script, sha256: hashVerificationSpec('sh', script) };
    setVerificationCandidate(attempt.id, spec, 'operator');
    approveVerificationSpec(attempt.id, spec.sha256, 'operator');
    const github = {
      getIssue: vi.fn(),
      listCheckRuns: vi.fn(),
      getCombinedStatus: vi.fn(),
      getPullRequest: vi.fn().mockResolvedValue({
        number: 2,
        html_url: 'https://github.com/owner/repo/pull/2',
        state: 'open' as const,
        merged_at: null,
        head: { sha: 'new' },
      }),
    } as unknown as Pick<
      GitHubClient,
      'getIssue' | 'getPullRequest' | 'listCheckRuns' | 'getCombinedStatus'
    >;
    await expect(
      rerunApprovedVerification(attempt.id, {
        github,
        logger,
        db: getDb(),
        workspaceRoot: './data/test-verification',
        commandTimeoutMs: 100,
        setupTimeoutMs: 100,
        checkoutTimeoutMs: 100,
        maxOutputBytes: 1000,
      })
    ).rejects.toThrow();
  });

  it.each([['missing', 999999, 'attempt_not_found']] as const)(
    'returns %s precondition result',
    async (_name, attemptId, reason) => {
      const result = await rerunApprovedVerification(attemptId, {
        github: {
          getIssue: vi.fn(),
          listCheckRuns: vi.fn(),
          getCombinedStatus: vi.fn(),
          getPullRequest: vi.fn(),
        },
        logger,
        db: getDb(),
        workspaceRoot: './data/test-verification',
        commandTimeoutMs: 100,
        setupTimeoutMs: 100,
        checkoutTimeoutMs: 100,
        maxOutputBytes: 1000,
      });
      expect(result).toEqual({ ok: false, reason });
    }
  );
});
