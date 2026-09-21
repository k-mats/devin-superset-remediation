import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    createAttempt(task.id, 'real');
  });

  afterAll(async () => {
    await server.close();
    closeDb();
  });

  it('returns a no-store report with the real default filter', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/report' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.payload)).toMatchObject({
      filter: { runKinds: ['real'] },
      summary: { totalTasks: 1 },
    });
  });

  it('rejects an invalid run kind', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/report?run_kind=bogus' });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload)).toEqual({
      error: 'invalid run_kind',
      allowed: ['real', 'demo', 'mock', 'unknown'],
    });
  });

  it('renders escaped task titles and normalized state labels', async () => {
    const response = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.payload).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(response.payload).not.toContain('<script>alert(1)</script>');
    expect(response.payload).toContain('VERIFIED');
  });
});
