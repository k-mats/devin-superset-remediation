import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/index.js';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import { createAttempt, upsertTask } from '../src/db/task-state.js';

describe('report routes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

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
    createAttempt(task.id);
    getDb()
      .update(attempts)
      .set({ prUrl: 'javascript:alert(1)', prHeadSha: '123456789012abcdef' })
      .where(eq(attempts.taskId, task.id))
      .run();
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
    expect(response.payload).not.toContain('href="javascript:');
  });
});
