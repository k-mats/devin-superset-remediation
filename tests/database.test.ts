import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getDb, closeDb, runMigrations } from '../src/db/client.js';
import { sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import fs from 'fs';

describe('Database Integration', () => {
  beforeAll(() => {
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    // Clean up test database file
    if (fs.existsSync('./test-database.db')) {
      fs.unlinkSync('./test-database.db');
    }
  });

  beforeEach(async () => {
    // Clean up database before each test to avoid interference
    const db = getDb();
    await db.delete(sessions);
  });

  it('should successfully insert and query a session', async () => {
    const db = getDb();

    // Insert a test session
    const insertResult = await db
      .insert(sessions)
      .values({
        createdAt: Date.now(),
        status: 'test',
      })
      .returning();

    expect(insertResult).toBeDefined();
    expect(insertResult.length).toBeGreaterThan(0);

    // Query the inserted session
    const result = await db.select().from(sessions).where(eq(sessions.status, 'test'));

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('status', 'test');
  });

  it('should handle database read/write round trip', async () => {
    const db = getDb();

    const testTimestamp = Date.now();
    const testStatus = 'roundtrip_test';

    // Write
    await db.insert(sessions).values({
      createdAt: testTimestamp,
      status: testStatus,
    });

    // Read
    const result = await db.select().from(sessions).where(eq(sessions.status, testStatus));

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.createdAt).toBe(testTimestamp);
    expect(result[0]?.status).toBe(testStatus);
  });
});
