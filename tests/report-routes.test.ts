import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/index.js';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import {
  createAttempt,
  recordVerification,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import { hashVerificationSpec } from '../src/verification/spec.js';

describe('report routes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  let attemptId: number;

  beforeAll(async () => {
    runMigrations();
    server = await buildServer();
    await server.ready();
  });

  beforeEach(() => {
    getDb().delete(verifications).run();
    getDb().delete(attempts).run();
    getDb().delete(tasks).run();
    const task = upsertTask({
      repoOwner: 'owner',
      repoName: 'repo',
      issueNumber: 15,
      title: '<script>alert(1)</script>',
    });
    const attempt = createAttempt(task.id);
    attemptId = attempt.id;
    getDb()
      .update(attempts)
      .set({ prUrl: 'javascript:alert(1)', prHeadSha: '123456789012abcdef' })
      .where(eq(attempts.taskId, task.id))
      .run();
    setVerificationCandidate(attempt.id, { shell: 'sh', script: 'SECRET_SCRIPT_BODY' }, 'operator');
    recordVerification({
      attemptId: attempt.id,
      headSha: '123456789012abcdef',
      kind: 'command',
      status: 'failed',
      specShell: 'sh',
      specScript: 'SECRET_SCRIPT_BODY',
      specSha256: hashVerificationSpec('sh', 'SECRET_SCRIPT_BODY'),
      evidenceSummary: 'RAW_OUTPUT_SENTINEL',
    });
  });

  afterAll(async () => {
    await server.close();
    closeDb();
  });

  it('returns a no-store report for the configured database', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/report' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.payload)).toMatchObject({
      summary: { totalTasks: 1 },
      context: { databasePath: resolve('./test-database.db') },
    });
    const reportPayload = JSON.parse(response.payload) as { ledger: unknown[] };
    expect(reportPayload.ledger).toHaveLength(1);
    expect(response.payload).not.toContain('SECRET_SCRIPT_BODY');
    expect(response.payload).not.toContain('RAW_OUTPUT_SENTINEL');
  });

  it('ignores the removed run-kind query parameter', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/report?run_kind=bogus' });
    expect(response.statusCode).toBe(200);
  });

  it('renders escaped task titles and normalized state labels', async () => {
    const response = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.payload).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.payload).not.toContain('<script>alert(1)</script>');
    expect(response.payload).toContain(resolve('./test-database.db'));
    expect(response.payload).toContain('QUEUED');
    expect(response.payload).toContain('attempt_pending');
    expect(response.payload).toContain('javascript:alert(1)');
    expect(response.payload).toContain('Remediation evidence ledger');
    expect(response.payload).toContain('123456789012');
    expect(response.payload).toContain('GitHub Checks');
    expect(response.payload).not.toContain('SECRET_SCRIPT_BODY');
    expect(response.payload).not.toContain('RAW_OUTPUT_SENTINEL');
    expect(response.payload).toContain(`/operator/attempts/${String(attemptId)}/verification`);
    expect(response.payload).not.toContain('href="javascript:');
  });

  it('orders Tasks first, collapses ledger and throughput, and explains each state', async () => {
    const response = await server.inject({ method: 'GET', url: '/dashboard' });
    const html = response.payload;
    const tasksAt = html.indexOf('<h2>Tasks (');
    const ledgerAt = html.indexOf('<h2>Remediation evidence ledger');
    const throughputAt = html.indexOf('<h2>Throughput</h2>');
    expect(tasksAt).toBeGreaterThan(-1);
    expect(ledgerAt).toBeGreaterThan(tasksAt);
    expect(throughputAt).toBeGreaterThan(ledgerAt);
    expect(html).toContain('<details><summary><h2>Remediation evidence ledger');
    expect(html).toContain('<details><summary><h2>Throughput</h2></summary>');
    expect(html).toContain('<th>Verification</th>');
    const tasksTable = html.slice(tasksAt, ledgerAt);
    expect(tasksTable).toContain(
      `<a href="/operator/attempts/${String(attemptId)}/verification">Verification</a>`
    );
    // tests/setup.ts disables the dispatch poller, so a QUEUED task must not claim to be progressing
    expect(tasksTable).not.toContain('Wait — automation is progressing');
    expect(tasksTable).toContain('Action needed — operator step required');
    expect(tasksTable).toContain(
      'not running in this process (dispatch poller: DEVIN_DISPATCH_INTERVAL_MS'
    );
    expect(tasksTable).toContain('<summary>What now?</summary>');
    expect(tasksTable).toContain('href="#state-QUEUED"');
    expect(html).toContain('<svg class="state-diagram"');
    expect(html).toMatch(/id="state-QUEUED" class="[^"]*occupied/);
    expect(html).toContain('<summary>Transitions (');
    expect(tasksTable).toContain('The dispatch poller');
  });

  it('renders scripts only on the dedicated operator page', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/operator/attempts/${String(attemptId)}/verification`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('SECRET_SCRIPT_BODY');
    expect(response.payload).not.toContain('RAW_OUTPUT_SENTINEL');
  });
});
