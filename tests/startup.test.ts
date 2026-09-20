import { afterAll, describe, expect, it } from 'vitest';
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
    } finally {
      await server.close();
    }
  });
});
