import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getRawDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks } from '../src/db/schema.js';
import {
  completeAttempt,
  createAttempt,
  findStaleDispatchingAttempts,
  getAttemptByCorrelationId,
  getTaskByIdentity,
  InvalidTransitionError,
  listAttempts,
  markDispatching,
  markRunning,
  markSessionCreated,
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
    const created = [createAttempt(task.id), createAttempt(task.id), createAttempt(task.id)];

    expect(created.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(new Set(created.map((attempt) => attempt.correlationId)).size).toBe(3);
    expect(listAttempts(task.id).map((attempt) => attempt.id)).toEqual(
      created.map((attempt) => attempt.id)
    );
    const second = created[1];
    if (!second) {
      throw new Error('Second attempt was not created');
    }
    expect(getAttemptByCorrelationId(second.correlationId)).toEqual(second);
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

    insertAttempt.run(
      task.id,
      2,
      randomUUID(),
      'pending',
      null,
      'duplicate-session',
      timestamp,
      timestamp
    );
    expect(() =>
      insertAttempt.run(
        task.id,
        3,
        randomUUID(),
        'pending',
        null,
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

  it('finds only dispatching attempts without sessions', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const stale = createAttempt(task.id);
    markDispatching(stale.id);
    const session = createAttempt(task.id);
    markDispatching(session.id);
    markSessionCreated(session.id, { devinSessionId: 'not-stale' });
    const completed = createAttempt(task.id);
    markDispatching(completed.id);
    completeAttempt(completed.id, 'failed');

    expect(findStaleDispatchingAttempts().map((attempt) => attempt.id)).toEqual([stale.id]);
  });
});
