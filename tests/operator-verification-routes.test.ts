import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import {
  completeAttempt,
  createAttempt,
  getAttempt,
  listVerifications,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  recordVerification,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import { operatorVerificationRoutes } from '../src/routes/operator-verification.js';
import type { GitHubClient } from '../src/github/client.js';
import { hashVerificationSpec } from '../src/verification/spec.js';
import {
  rerunApprovedVerification,
  type RerunVerificationOptions,
} from '../src/verification/rerun.js';
import type { Attempt } from '../src/db/schema.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe('operator verification routes', () => {
  const log = logger();
  let server: FastifyInstance;
  let github:
    | Pick<GitHubClient, 'getIssue' | 'getPullRequest' | 'listCheckRuns' | 'getCombinedStatus'>
    | undefined;

  beforeAll(async () => {
    runMigrations();
    server = Fastify();
    await server.register(operatorVerificationRoutes, {
      getGitHubClient: () => github,
      verification: {
        workspaceRoot: './data/test-verification',
        commandTimeoutMs: 100,
        setupTimeoutMs: 100,
        checkoutTimeoutMs: 100,
        maxOutputBytes: 1000,
      },
      logger: log,
    });
    await server.ready();
  });

  beforeEach(() => {
    getDb().delete(verifications).run();
    getDb().delete(attempts).run();
    getDb().delete(tasks).run();
    github = {
      getIssue: vi.fn().mockResolvedValue({ body: null }),
      getPullRequest: vi.fn().mockResolvedValue({
        number: 12,
        html_url: 'https://github.com/owner/repo/pull/12',
        state: 'open',
        merged_at: null,
        head: { sha: 'head-2' },
      }),
      listCheckRuns: vi.fn().mockResolvedValue({ total_count: 0, check_runs: [] }),
      getCombinedStatus: vi
        .fn()
        .mockResolvedValue({ state: 'pending', total_count: 0, statuses: [] }),
    };
  });

  afterAll(async () => {
    await server.close();
    closeDb();
  });

  function verifyingAttempt() {
    const task = upsertTask({
      repoOwner: 'owner',
      repoName: 'repo',
      issueNumber: 64,
      title: '<script>alert(1)</script>',
    });
    const created = createAttempt(task.id);
    markDispatching(created.id);
    markSessionCreated(created.id, { devinSessionId: 'session-1' });
    markRunning(created.id);
    recordPullRequest(created.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'head-1',
    });
    return { task, attempt: markVerifying(created.id) };
  }

  function postForm(path: string, values: Record<string, string>) {
    return server.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(values).toString(),
    });
  }

  function candidate(attemptId: number, script = 'echo browser', shell: 'sh' | 'bash' = 'sh') {
    setVerificationCandidate(attemptId, { shell, script }, 'operator');
    return hashVerificationSpec(shell, script);
  }

  it('renders review data with escaping and safe evidence links', async () => {
    const { attempt } = verifyingAttempt();
    setVerificationCandidate(attempt.id, { shell: 'sh', script: '<b>$(rm -rf /)</b>' }, 'operator');
    recordVerification({
      attemptId: attempt.id,
      headSha: 'old-head',
      kind: 'github_checks',
      status: 'failed',
      reason: 'bad checks',
      evidenceUrl: 'javascript:alert(1)',
      evidenceSummary: 'RAW_OUTPUT_SENTINEL',
    });
    const response = await server.inject({
      method: 'GET',
      url: `/operator/attempts/${String(attempt.id)}/verification`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.payload).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.payload).toContain('&lt;b&gt;$(rm -rf /)&lt;/b&gt;');
    expect(response.payload).not.toContain('RAW_OUTPUT_SENTINEL');
    expect(response.payload).not.toContain('href="javascript:');
    expect(response.payload).toContain('stale');
  });

  it('proposes and approves the exact candidate hash', async () => {
    const { attempt } = verifyingAttempt();
    const script = 'echo browser';
    const proposed = await server.inject({
      method: 'POST',
      url: `/operator/attempts/${String(attempt.id)}/verification/propose`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ shell: 'sh', script }).toString(),
    });
    expect(proposed.statusCode).toBe(303);
    expect(proposed.headers.location).toContain(
      `/operator/attempts/${String(attempt.id)}/verification`
    );
    expect(getDb().select().from(attempts).get()?.verificationCandidateSha256).toBe(
      hashVerificationSpec('sh', script)
    );
    const approved = await server.inject({
      method: 'POST',
      url: `/operator/attempts/${String(attempt.id)}/verification/approve`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        spec_sha256: hashVerificationSpec('sh', script),
      }).toString(),
    });
    expect(approved.statusCode).toBe(303);
    expect(getDb().select().from(attempts).get()?.verificationApprovedSha256).toBe(
      hashVerificationSpec('sh', script)
    );
  });

  it('normalizes CRLF and trailing whitespace before hashing browser proposals', async () => {
    const { attempt } = verifyingAttempt();
    const script = 'echo a\necho b';
    const proposed = await postForm(
      `/operator/attempts/${String(attempt.id)}/verification/propose`,
      {
        shell: 'sh',
        script: 'echo a\r\necho b\r\n',
      }
    );
    expect(proposed.statusCode).toBe(303);
    const updated = getAttempt(attempt.id);
    expect(updated?.verificationCandidateScript).toBe(script);
    expect(updated?.verificationCandidateSha256).toBe(hashVerificationSpec('sh', script));
  });

  it('renders no-candidate, pending, and approved review states', async () => {
    const { attempt } = verifyingAttempt();
    const empty = await server.inject({
      method: 'GET',
      url: `/operator/attempts/${String(attempt.id)}/verification`,
    });
    expect(empty.payload).toContain('no_candidate');
    expect(empty.payload).not.toContain('name="spec_sha256"');

    const script = 'echo pending';
    const sha256 = candidate(attempt.id, script);
    const pending = await server.inject({
      method: 'GET',
      url: `/operator/attempts/${String(attempt.id)}/verification`,
    });
    expect(pending.payload).toContain(`name="spec_sha256" value="${sha256}"`);
    expect(pending.payload).toContain(sha256);
    expect(pending.payload).toContain('pending_approval');

    await postForm(`/operator/attempts/${String(attempt.id)}/verification/approve`, {
      spec_sha256: sha256,
    });
    const approved = await server.inject({
      method: 'GET',
      url: `/operator/attempts/${String(attempt.id)}/verification`,
    });
    expect(approved.payload).toContain('approved by: operator');
    expect(approved.payload).toContain(`sha256: <code>${sha256}</code>`);
    expect(approved.payload).toContain('<pre>echo pending</pre>');
  });

  it('renders passed and failed command history plus current-head GitHub checks', async () => {
    const { attempt } = verifyingAttempt();
    const sha256 = candidate(attempt.id);
    recordVerification({
      attemptId: attempt.id,
      headSha: 'head-1',
      kind: 'command',
      status: 'passed',
      specShell: 'sh',
      specScript: 'echo browser',
      specSha256: sha256,
      reason: 'passed once',
    });
    recordVerification({
      attemptId: attempt.id,
      headSha: 'head-1',
      kind: 'command',
      status: 'failed',
      specShell: 'sh',
      specScript: 'echo browser',
      specSha256: sha256,
      reason: 'failed later',
    });
    recordVerification({
      attemptId: attempt.id,
      headSha: 'head-1',
      kind: 'github_checks',
      status: 'passed',
      reason: 'checks passed',
    });
    const response = await server.inject({
      method: 'GET',
      url: `/operator/attempts/${String(attempt.id)}/verification`,
    });
    expect(response.payload).toContain('passed once');
    expect(response.payload).toContain('failed later');
    expect(response.payload).toContain('command');
    expect(response.payload).toContain('github_checks');
    expect(response.payload).toContain('current-head');
  });

  it('supports bash proposals and leaves approval unchanged after a replacement', async () => {
    const { attempt } = verifyingAttempt();
    const approvedScript = 'echo approved';
    const approvedSha = candidate(attempt.id, approvedScript);
    await postForm(`/operator/attempts/${String(attempt.id)}/verification/approve`, {
      spec_sha256: approvedSha,
    });
    const replacement = await postForm(
      `/operator/attempts/${String(attempt.id)}/verification/propose`,
      {
        shell: 'bash',
        script: 'echo replacement',
      }
    );
    expect(replacement.statusCode).toBe(303);
    const updated = getAttempt(attempt.id);
    expect(updated?.verificationApprovedSha256).toBe(approvedSha);
    expect(updated?.verificationCandidateShell).toBe('bash');
    expect(updated?.verificationCandidateScript).toBe('echo replacement');
    const page = await server.inject({
      method: 'GET',
      url: `/operator/attempts/${String(attempt.id)}/verification`,
    });
    expect(page.payload).toContain('pending_approval');
  });

  it('rejects invalid proposals and stale approvals', async () => {
    const { attempt } = verifyingAttempt();
    const invalid = await server.inject({
      method: 'POST',
      url: `/operator/attempts/${String(attempt.id)}/verification/propose`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ shell: 'zsh', script: '' }).toString(),
    });
    expect(invalid.statusCode).toBe(400);
    const stale = await server.inject({
      method: 'POST',
      url: `/operator/attempts/${String(attempt.id)}/verification/approve`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ spec_sha256: 'a'.repeat(64) }).toString(),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.headers['cache-control']).toBe('no-store');
  });

  it('rejects approval without a candidate', async () => {
    const { attempt } = verifyingAttempt();
    const response = await postForm(
      `/operator/attempts/${String(attempt.id)}/verification/approve`,
      {
        spec_sha256: 'a'.repeat(64),
      }
    );
    expect(response.statusCode).toBe(409);
  });

  it('rejects proposal and approval changes after completion', async () => {
    const { attempt } = verifyingAttempt();
    const sha256 = candidate(attempt.id);
    completeAttempt(attempt.id, 'failed');
    const proposed = await postForm(
      `/operator/attempts/${String(attempt.id)}/verification/propose`,
      {
        shell: 'sh',
        script: 'echo replacement',
      }
    );
    expect(proposed.statusCode).toBe(409);
    const approved = await postForm(
      `/operator/attempts/${String(attempt.id)}/verification/approve`,
      {
        spec_sha256: sha256,
      }
    );
    expect(approved.statusCode).toBe(409);
  });

  it('returns explicit rerun availability errors without calling GitHub', async () => {
    const { attempt } = verifyingAttempt();
    github = undefined;
    const response = await server.inject({
      method: 'POST',
      url: `/operator/attempts/${String(attempt.id)}/verification/rerun`,
    });
    expect(response.statusCode).toBe(503);
    expect(response.payload).toContain('github_unavailable');
    expect(github).toBeUndefined();
  });

  it('returns verification_disabled when browser reruns are disabled', async () => {
    const { attempt } = verifyingAttempt();
    const disabledServer = Fastify();
    await disabledServer.register(operatorVerificationRoutes, {
      getGitHubClient: () => undefined,
      verification: undefined,
      logger: log,
    });
    await disabledServer.ready();
    try {
      const response = await disabledServer.inject({
        method: 'POST',
        url: `/operator/attempts/${String(attempt.id)}/verification/rerun`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.payload).toContain('verification_disabled');
    } finally {
      await disabledServer.close();
    }
  });

  it('rejects rerun when the approved spec is missing without refreshing GitHub', async () => {
    const { attempt } = verifyingAttempt();
    const getPullRequest = github?.getPullRequest;
    const response = await server.inject({
      method: 'POST',
      url: `/operator/attempts/${String(attempt.id)}/verification/rerun`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.payload).toContain('no_approved_spec');
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('rejects rerun when the attempt is not verifying', async () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 65 });
    const attempt = createAttempt(task.id);
    const getPullRequest = github?.getPullRequest;
    const response = await server.inject({
      method: 'POST',
      url: `/operator/attempts/${String(attempt.id)}/verification/rerun`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.payload).toContain('attempt_not_verifying');
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('reruns an approved spec on the refreshed head and appends history', async () => {
    const { attempt } = verifyingAttempt();
    const sha256 = candidate(attempt.id);
    await postForm(`/operator/attempts/${String(attempt.id)}/verification/approve`, {
      spec_sha256: sha256,
    });
    recordVerification({
      attemptId: attempt.id,
      headSha: 'head-1',
      kind: 'command',
      status: 'passed',
      specShell: 'sh',
      specScript: 'echo browser',
      specSha256: sha256,
      reason: 'previous pass',
    });
    const initialCount = listVerifications(attempt.id).length;
    const verify = vi.fn((passedAttempt: Attempt): Promise<'verification_failed'> => {
      expect(passedAttempt.prHeadSha).toBe('head-2');
      recordVerification({
        attemptId: passedAttempt.id,
        headSha: passedAttempt.prHeadSha ?? '',
        kind: 'command',
        status: 'failed',
        specShell: 'sh',
        specScript: 'echo browser',
        specSha256: passedAttempt.verificationApprovedSha256,
        reason: 'rerun failed',
      });
      return Promise.resolve('verification_failed');
    });
    const rerun: typeof rerunApprovedVerification = (
      attemptId: number,
      options: RerunVerificationOptions
    ) => rerunApprovedVerification(attemptId, { ...options, verify });
    const rerunServer = Fastify();
    await rerunServer.register(operatorVerificationRoutes, {
      getGitHubClient: () => github,
      verification: {
        workspaceRoot: './data/test-verification',
        commandTimeoutMs: 100,
        setupTimeoutMs: 100,
        checkoutTimeoutMs: 100,
        maxOutputBytes: 1000,
      },
      logger: log,
      rerun,
    });
    await rerunServer.ready();
    try {
      const response = await rerunServer.inject({
        method: 'POST',
        url: `/operator/attempts/${String(attempt.id)}/verification/rerun`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.payload).toContain('Rerun decision: verification_failed');
      expect(verify).toHaveBeenCalledOnce();
      expect(listVerifications(attempt.id)).toHaveLength(initialCount + 1);
      expect(listVerifications(attempt.id).map((row) => row.reason)).toEqual([
        'previous pass',
        'rerun failed',
      ]);
      expect(getAttempt(attempt.id)?.state).toBe('verifying');
    } finally {
      await rerunServer.close();
    }
  });

  it('returns 502 when GitHub PR refresh fails during rerun', async () => {
    const { attempt } = verifyingAttempt();
    const sha256 = candidate(attempt.id);
    await postForm(`/operator/attempts/${String(attempt.id)}/verification/approve`, {
      spec_sha256: sha256,
    });
    const refreshError = new Error('GitHub unavailable');
    if (github === undefined) throw new Error('GitHub fixture was not initialized');
    github.getPullRequest = vi.fn().mockRejectedValue(refreshError);
    const response = await server.inject({
      method: 'POST',
      url: `/operator/attempts/${String(attempt.id)}/verification/rerun`,
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.payload).toContain('pull_request_refresh_failed');
  });

  it('returns 404 for an unknown attempt', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/operator/attempts/999999/verification',
    });
    expect(response.statusCode).toBe(404);
  });
});
