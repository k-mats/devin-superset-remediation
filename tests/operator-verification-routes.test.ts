import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import {
  createAttempt,
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

  it('returns 404 for an unknown attempt', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/operator/attempts/999999/verification',
    });
    expect(response.statusCode).toBe(404);
  });
});
