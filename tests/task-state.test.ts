import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getRawDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks } from '../src/db/schema.js';
import {
  ActiveAttemptExistsError,
  claimAttemptForDispatch,
  completeAttempt,
  createAttempt,
  findPendingAttempts,
  findStaleDispatchingAttempts,
  getAttemptByCorrelationId,
  getTaskByIdentity,
  InvalidTransitionError,
  listAttempts,
  markDispatching,
  releaseDispatchClaim,
  markRunning,
  markSessionCreated,
  recordStructuredOutcome,
  setPrUrl,
  upsertTask,
} from '../src/db/task-state.js';

describe('task state repository', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  it('persists the complete attempt lifecycle', () => {
    const task = upsertTask({
      repoOwner: 'k-mats',
      repoName: 'superset-fork',
      issueNumber: 101,
      title: 'Persistent state',
    });
    const attempt = createAttempt(task.id);
    expect(attempt.state).toBe('pending');

    const dispatching = markDispatching(attempt.id);
    const sessionCreated = markSessionCreated(attempt.id, {
      devinSessionId: 'devin-101',
      devinSessionUrl: 'https://app.devin.ai/sessions/devin-101',
    });
    const running = markRunning(attempt.id);
    const withPr = setPrUrl(attempt.id, 'https://github.com/k-mats/superset-fork/pull/101');
    const completed = completeAttempt(attempt.id, 'succeeded');

    expect(dispatching.dispatchedAt).toEqual(expect.any(Number));
    expect(sessionCreated.sessionCreatedAt).toEqual(expect.any(Number));
    expect(running.state).toBe('running');
    expect(withPr.prUrl).toBe('https://github.com/k-mats/superset-fork/pull/101');
    expect(completed).toMatchObject({
      state: 'completed',
      outcome: 'succeeded',
    });
    expect(completed.completedAt).toEqual(expect.any(Number));
  });

  it('recovers identical rows after reopening the database', () => {
    const task = upsertTask({
      repoOwner: 'k-mats',
      repoName: 'superset-fork',
      issueNumber: 101,
      title: 'Restart state',
    });
    const first = createAttempt(task.id);
    markDispatching(first.id);
    markSessionCreated(first.id, { devinSessionId: 'restart-session' });
    markRunning(first.id);
    setPrUrl(first.id, 'https://github.com/k-mats/superset-fork/pull/1');
    completeAttempt(first.id, 'succeeded');
    const second = createAttempt(task.id);
    markDispatching(second.id);

    const beforeTask = getTaskByIdentity({
      repoOwner: 'k-mats',
      repoName: 'superset-fork',
      issueNumber: 101,
    });
    const beforeAttempts = listAttempts(task.id);
    closeDb();
    getDb();
    runMigrations();

    expect(
      getTaskByIdentity({
        repoOwner: 'k-mats',
        repoName: 'superset-fork',
        issueNumber: 101,
      })
    ).toEqual(beforeTask);
    expect(listAttempts(task.id)).toEqual(beforeAttempts);
  });

  it('numbers and lists multiple attempts in order', () => {
    const task = upsertTask({
      repoOwner: 'owner',
      repoName: 'repo',
      issueNumber: 1,
    });
    const first = createAttempt(task.id);
    completeAttempt(first.id, 'cancelled');
    const second = createAttempt(task.id);
    completeAttempt(second.id, 'cancelled');
    const third = createAttempt(task.id);
    const created = [first, second, third];

    expect(created.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(new Set(created.map((attempt) => attempt.correlationId)).size).toBe(3);
    expect(listAttempts(task.id).map((attempt) => attempt.id)).toEqual(
      created.map((attempt) => attempt.id)
    );
    const secondAttempt = created[1];
    if (!secondAttempt) {
      throw new Error('Second attempt was not created');
    }
    expect(getAttemptByCorrelationId(secondAttempt.correlationId)).toEqual(
      listAttempts(task.id)[1]
    );
  });

  it('upserts a task by repository identity', () => {
    const first = upsertTask({
      repoOwner: 'owner',
      repoName: 'repo',
      issueNumber: 1,
      title: 'old',
    });
    const second = upsertTask({
      repoOwner: 'owner',
      repoName: 'repo',
      issueNumber: 1,
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe('old');
    expect(listAttempts(second.id)).toEqual([]);
  });

  it('rejects invalid issue numbers', () => {
    expect(() =>
      upsertTask({
        repoOwner: 'owner',
        repoName: 'repo',
        issueNumber: 0,
      })
    ).toThrow(new Error('Issue number must be a positive integer'));
    expect(() =>
      upsertTask({
        repoOwner: 'owner',
        repoName: 'repo',
        issueNumber: 1.5,
      })
    ).toThrow(new Error('Issue number must be a positive integer'));
  });

  it('normalizes repository identity', () => {
    const first = upsertTask({
      repoOwner: 'Acme',
      repoName: 'Widget',
      issueNumber: 12,
    });
    const second = upsertTask({
      repoOwner: 'acme',
      repoName: 'widget',
      issueNumber: 12,
    });

    expect(second.id).toBe(first.id);
    expect(second.repoOwner).toBe('acme');
    expect(second.repoName).toBe('widget');
  });

  it('rejects invalid transitions', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);

    expect(() => markSessionCreated(attempt.id, { devinSessionId: 'invalid' })).toThrow(
      InvalidTransitionError
    );
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'valid' });
    markRunning(attempt.id);
    expect(() => markDispatching(attempt.id)).toThrow(InvalidTransitionError);
    completeAttempt(attempt.id, 'succeeded');
    expect(() => markRunning(attempt.id)).toThrow(InvalidTransitionError);
    expect(() => setPrUrl(attempt.id, 'https://example.com/pr')).toThrow(InvalidTransitionError);
    expect(() => completeAttempt(attempt.id, 'failed')).toThrow(InvalidTransitionError);
    expect(() => recordStructuredOutcome(attempt.id, { raw: null, parsed: undefined })).toThrow(
      InvalidTransitionError
    );
  });

  it('rejects stale completion and preserves the newer outcome', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    markDispatching(attempt.id);
    const sqlite = getRawDb();
    if (!sqlite) {
      throw new Error('Database not initialized');
    }
    sqlite
      .prepare("UPDATE attempts SET state = 'completed', outcome = 'failed' WHERE id = ?")
      .run(attempt.id);

    expect(() => completeAttempt(attempt.id, 'succeeded')).toThrow(InvalidTransitionError);
    expect(sqlite.prepare('SELECT outcome FROM attempts WHERE id = ?').get(attempt.id)).toEqual({
      outcome: 'failed',
    });
  });

  it('requires a session for succeeded attempts', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    markDispatching(attempt.id);

    expect(() => completeAttempt(attempt.id, 'succeeded')).toThrow(InvalidTransitionError);
    expect(completeAttempt(attempt.id, 'failed').outcome).toBe('failed');
  });

  it('enforces database constraints', () => {
    const sqlite = getRawDb();
    if (!sqlite) {
      throw new Error('Database not initialized');
    }
    const timestamp = Date.now();
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });

    expect(() =>
      sqlite
        .prepare(
          'INSERT INTO tasks (repo_owner, repo_name, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('owner', 'repo', 1, timestamp, timestamp)
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          'INSERT INTO tasks (repo_owner, repo_name, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('owner', 'zero-issue', 0, timestamp, timestamp)
    ).toThrow();

    const existingAttempt = createAttempt(task.id);
    const insertAttempt = sqlite.prepare(
      `INSERT INTO attempts
        (task_id, attempt_number, correlation_id, state, outcome, devin_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    expect(() =>
      insertAttempt.run(
        task.id,
        existingAttempt.attemptNumber,
        randomUUID(),
        'pending',
        null,
        null,
        timestamp,
        timestamp
      )
    ).toThrow();

    // A second active attempt for the same task violates the partial unique index.
    expect(() =>
      insertAttempt.run(task.id, 2, randomUUID(), 'pending', null, null, timestamp, timestamp)
    ).toThrow();

    insertAttempt.run(
      task.id,
      2,
      randomUUID(),
      'completed',
      'failed',
      'duplicate-session',
      timestamp,
      timestamp
    );
    expect(() =>
      insertAttempt.run(
        task.id,
        3,
        randomUUID(),
        'completed',
        'failed',
        'duplicate-session',
        timestamp,
        timestamp
      )
    ).toThrow();

    expect(() =>
      insertAttempt.run(9999, 4, randomUUID(), 'pending', null, null, timestamp, timestamp)
    ).toThrow();
    expect(() =>
      insertAttempt.run(task.id, 5, randomUUID(), 'unknown', null, null, timestamp, timestamp)
    ).toThrow();
    expect(() =>
      insertAttempt.run(task.id, 6, randomUUID(), 'pending', 'unknown', null, timestamp, timestamp)
    ).toThrow();
    expect(() =>
      insertAttempt.run(task.id, 7, randomUUID(), 'completed', null, null, timestamp, timestamp)
    ).toThrow();
    expect(() =>
      insertAttempt.run(
        task.id,
        8,
        randomUUID(),
        'running',
        'succeeded',
        'running-session',
        timestamp,
        timestamp
      )
    ).toThrow();
    expect(() =>
      insertAttempt.run(task.id, 9, randomUUID(), 'running', null, null, timestamp, timestamp)
    ).toThrow();
    expect(() =>
      insertAttempt.run(task.id, 0, randomUUID(), 'pending', null, null, timestamp, timestamp)
    ).toThrow();
    expect(() =>
      insertAttempt.run(
        task.id,
        10,
        randomUUID(),
        'completed',
        'succeeded',
        null,
        timestamp,
        timestamp
      )
    ).toThrow();
  });

  it('accepts both the database and a transaction as DbExecutor', () => {
    const db = getDb();
    db.transaction((tx) => {
      const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 }, tx);
      const attempt = createAttempt(task.id, tx);
      expect(
        getTaskByIdentity({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 }, tx)
      ).toEqual(task);
      expect(listAttempts(task.id, tx)).toEqual([attempt]);
    });
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 2 });
    expect(getTaskByIdentity({ repoOwner: 'owner', repoName: 'repo', issueNumber: 2 }, db)).toEqual(
      task
    );
  });

  it('claims a pending attempt atomically and returns undefined otherwise', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);

    const claimed = claimAttemptForDispatch(attempt.id);
    expect(claimed).toMatchObject({ id: attempt.id, state: 'dispatching' });
    expect(claimed?.dispatchedAt).toEqual(expect.any(Number));

    expect(claimAttemptForDispatch(attempt.id)).toBeUndefined();
  });

  it('releases a dispatch claim back to pending only when no session exists', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const pending = createAttempt(task.id);

    // Not yet claimed: nothing to release.
    expect(releaseDispatchClaim(pending.id)).toBeUndefined();

    const claimed = claimAttemptForDispatch(pending.id);
    expect(claimed?.state).toBe('dispatching');
    const released = releaseDispatchClaim(pending.id);
    expect(released).toMatchObject({ state: 'pending', dispatchedAt: null });
    expect(releaseDispatchClaim(pending.id)).toBeUndefined();

    // A dispatching attempt that already carries a session id cannot be released.
    claimAttemptForDispatch(pending.id);
    getDb().update(attempts).set({ devinSessionId: 'in-flight' }).run();
    expect(releaseDispatchClaim(pending.id)).toBeUndefined();
  });

  it('rejects markDispatching on a non-pending attempt', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    claimAttemptForDispatch(attempt.id);

    expect(() => markDispatching(attempt.id)).toThrow(InvalidTransitionError);
  });

  it('allows pending -> completed (cancelled) but not succeeded without a session', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const cancelled = createAttempt(task.id);
    expect(() => completeAttempt(cancelled.id, 'succeeded')).toThrow(InvalidTransitionError);
    const completed = completeAttempt(cancelled.id, 'cancelled', { reason: 'label_missing' });
    expect(completed).toMatchObject({
      state: 'completed',
      outcome: 'cancelled',
      outcomeReason: 'label_missing',
    });

    const another = createAttempt(task.id);
    markDispatching(another.id);
    expect(() => completeAttempt(another.id, 'succeeded')).toThrow(InvalidTransitionError);
  });

  it('persists the outcome reason on completion', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    const completed = completeAttempt(attempt.id, 'failed', {
      reason: 'eligibility_check_failed: boom',
    });
    expect(completed.outcomeReason).toBe('eligibility_check_failed: boom');
    expect(listAttempts(task.id)[0]?.outcomeReason).toBe('eligibility_check_failed: boom');
  });

  it('rejects a second active attempt but allows one after completion', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const first = createAttempt(task.id);

    expect(() => createAttempt(task.id)).toThrow(ActiveAttemptExistsError);
    markDispatching(first.id);
    expect(() => createAttempt(task.id)).toThrow(ActiveAttemptExistsError);
    markSessionCreated(first.id, { devinSessionId: 'active-session' });
    expect(() => createAttempt(task.id)).toThrow(ActiveAttemptExistsError);
    markRunning(first.id);
    expect(() => createAttempt(task.id)).toThrow(ActiveAttemptExistsError);

    completeAttempt(first.id, 'succeeded');
    expect(createAttempt(task.id).state).toBe('pending');
  });

  it('lists pending attempts in insertion order with their tasks', () => {
    const first = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const second = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 2 });
    const third = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 3 });
    const firstAttempt = createAttempt(first.id);
    const claimed = createAttempt(second.id);
    claimAttemptForDispatch(claimed.id);
    const thirdAttempt = createAttempt(third.id);

    const rows = findPendingAttempts();
    expect(rows.map((row) => row.attempt.id)).toEqual([firstAttempt.id, thirdAttempt.id]);
    expect(rows[0]?.task.id).toBe(first.id);
    expect(rows[1]?.task.id).toBe(third.id);
  });

  it('migration 0002 demotes duplicate active attempts before creating the index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-0002-'));
    const sqlite = new Database(path.join(dir, 'legacy.db'));
    try {
      // Apply the pre-0002 schema by executing the migration files directly.
      const journal = JSON.parse(
        fs.readFileSync(path.join('drizzle', 'meta', '_journal.json'), 'utf8')
      ) as { entries: Array<{ tag: string; when: number }> };
      for (const entry of journal.entries.slice(0, 2)) {
        const sqlText = fs.readFileSync(path.join('drizzle', `${entry.tag}.sql`), 'utf8');
        for (const statement of sqlText.split('--> statement-breakpoint')) {
          sqlite.exec(statement);
        }
      }
      sqlite.exec(
        'CREATE TABLE `__drizzle_migrations` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
      );
      const recordApplied = sqlite.prepare(
        'INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)'
      );
      for (const entry of journal.entries.slice(0, 2)) {
        recordApplied.run('manual', entry.when);
      }

      const timestamp = Date.now();
      const insertTask = sqlite.prepare(
        'INSERT INTO tasks (repo_owner, repo_name, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      );
      const insertAttempt = sqlite.prepare(
        `INSERT INTO attempts
          (task_id, attempt_number, correlation_id, state, devin_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const taskA = Number(insertTask.run('o', 'r', 1, timestamp, timestamp).lastInsertRowid);
      insertAttempt.run(taskA, 1, randomUUID(), 'dispatching', 'keep-me', timestamp, timestamp);
      insertAttempt.run(taskA, 2, randomUUID(), 'dispatching', null, timestamp, timestamp);
      const taskB = Number(insertTask.run('o', 'r', 2, timestamp, timestamp).lastInsertRowid);
      const b1 = Number(
        insertAttempt.run(taskB, 1, randomUUID(), 'pending', null, timestamp, timestamp)
          .lastInsertRowid
      );
      const b2 = Number(
        insertAttempt.run(taskB, 2, randomUUID(), 'pending', null, timestamp, timestamp)
          .lastInsertRowid
      );
      const taskC = Number(insertTask.run('o', 'r', 3, timestamp, timestamp).lastInsertRowid);
      const c1 = Number(
        insertAttempt.run(taskC, 1, randomUUID(), 'pending', null, timestamp, timestamp)
          .lastInsertRowid
      );
      const taskD = Number(insertTask.run('o', 'r', 4, timestamp, timestamp).lastInsertRowid);
      const d1 = Number(
        insertAttempt.run(
          taskD,
          1,
          randomUUID(),
          'session_created',
          'sess-d1',
          timestamp,
          timestamp
        ).lastInsertRowid
      );
      const d2 = Number(
        insertAttempt.run(
          taskD,
          2,
          randomUUID(),
          'session_created',
          'sess-d2',
          timestamp,
          timestamp
        ).lastInsertRowid
      );

      // The drizzle migrator must split 0002 on statement breakpoints and apply it.
      migrate(drizzle(sqlite), { migrationsFolder: './drizzle' });

      type Row = {
        id: number;
        task_id: number;
        state: string;
        outcome: string | null;
        outcome_reason: string | null;
        devin_session_id: string | null;
      };
      const rowsOf = (taskId: number) =>
        sqlite
          .prepare(
            'SELECT id, task_id, state, outcome, outcome_reason, devin_session_id FROM attempts WHERE task_id = ? ORDER BY id'
          )
          .all(taskId) as Row[];

      const rowsA = rowsOf(taskA);
      expect(rowsA[0]).toMatchObject({ state: 'dispatching', devin_session_id: 'keep-me' });
      expect(rowsA[1]).toMatchObject({
        state: 'completed',
        outcome: 'cancelled',
        outcome_reason: 'migration_0002_duplicate_active_attempt',
      });

      const rowsB = rowsOf(taskB);
      expect(rowsB.find((row) => row.id === b1)?.state).toBe('completed');
      expect(rowsB.find((row) => row.id === b2)?.state).toBe('pending');

      const rowsD = rowsOf(taskD);
      expect(rowsD.find((row) => row.id === d2)?.state).toBe('session_created');
      expect(rowsD.find((row) => row.id === d1)).toMatchObject({
        state: 'completed',
        outcome: 'cancelled',
        devin_session_id: 'sess-d1',
      });

      expect(rowsOf(taskC)).toEqual([
        expect.objectContaining({ id: c1, state: 'pending', outcome: null }),
      ]);
    } finally {
      sqlite.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds only dispatching attempts without sessions', () => {
    const staleTask = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const sessionTask = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 2 });
    const completedTask = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 3 });
    const stale = createAttempt(staleTask.id);
    markDispatching(stale.id);
    const session = createAttempt(sessionTask.id);
    markDispatching(session.id);
    markSessionCreated(session.id, { devinSessionId: 'not-stale' });
    const completed = createAttempt(completedTask.id);
    markDispatching(completed.id);
    completeAttempt(completed.id, 'failed');

    expect(findStaleDispatchingAttempts().map((attempt) => attempt.id)).toEqual([stale.id]);
  });
});
