import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

const databasePath = './test-startup.db';

function removeDatabaseFiles() {
  for (const suffix of ['', '-shm', '-wal']) {
    const file = `${databasePath}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

describe('Startup on a fresh database', () => {
  afterAll(() => {
    removeDatabaseFiles();
  });

  it('creates the schema and reports ready', async () => {
    process.env['DATABASE_PATH'] = databasePath;
    removeDatabaseFiles();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { buildServer } = await import('../src/index.js');
    const { getRawDb } = await import('../src/db/client.js');

    const server = await buildServer();
    await server.ready();

    try {
      const table = getRawDb()
        ?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
        .get();
      expect(table).toBeDefined();

      const response = await server.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
      fetchSpy.mockRestore();
    }
  });

  it('warns and skips intake when polling is enabled without a token', async () => {
    process.env['DATABASE_PATH'] = databasePath;
    process.env['GITHUB_POLL_INTERVAL_MS'] = '1000';
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GITHUB_REPO_OWNER'];
    delete process.env['GITHUB_REPO_NAME'];
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { buildServer } = await import('../src/index.js');
    const server = await buildServer();

    try {
      await server.ready();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
      fetchSpy.mockRestore();
      process.env['GITHUB_POLL_INTERVAL_MS'] = '0';
    }
  });
});
