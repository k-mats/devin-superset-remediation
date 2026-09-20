import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { closeDb, getRawDb, runMigrations } from '../src/db/client.js';

describe('Database migration', () => {
  beforeAll(() => {
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      const path = `./test-database.db${suffix}`;
      if (fs.existsSync(path)) {
        fs.unlinkSync(path);
      }
    }
  });

  it('creates task state tables with foreign keys enabled', () => {
    const sqlite = getRawDb();
    if (!sqlite) {
      throw new Error('Database not initialized');
    }

    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'attempts') ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(['attempts', 'tasks']);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
