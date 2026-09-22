import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getRawDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import {
  ActiveAttemptExistsError,
  AttemptNotRequeueableError,
  approveVerificationSpec,
  claimAttemptForDispatch,
  clearVerificationCandidate,
  completeAttempt,
  completeVerifiedAttempt,
  createAttempt,
  findCompletedAttemptsWithTrackedPullRequests,
  findLatestVerification,
  findPendingAttempts,
  findStaleDispatchingAttempts,
  getAttemptByCorrelationId,
  getTaskByIdentity,
  InvalidTransitionError,
  StructuredOutputAlreadyAcceptedError,
  listAttempts,
  listVerifications,
  markDispatching,
  markVerifying,
  releaseDispatchClaim,
  markRunning,
  markSessionCreated,
  PullRequestMismatchError,
  recordStructuredOutput,
  recordPullRequest,
  recordVerification,
  REQUEUE_OUTCOME_REASON,
  requeueDispatchFailedAttempt,
  setVerificationCandidate,
  upsertTask,
  VerificationSpecMismatchError,
} from '../src/db/task-state.js';
import { hashVerificationSpec } from '../src/verification/spec.js';

function verifyAttempt(attemptId: number, headSha = 'sha', script = 'echo ok') {
  const specSha256 = hashVerificationSpec('sh', script);
  markVerifying(attemptId);
  setVerificationCandidate(attemptId, { shell: 'sh', script }, 'operator');
  approveVerificationSpec(attemptId, specSha256, 'operator');
  recordVerification({
    attemptId,
    headSha,
    kind: 'command',
    status: 'passed',
    specShell: 'sh',
    specScript: script,
    specSha256,
  });
  return specSha256;
}

describe('task state repository', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
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
    const withPr = recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/k-mats/superset-fork/pull/101',
      prNumber: 101,
      prState: 'open',
      prHeadSha: 'sha',
    });
    const specSha256 = verifyAttempt(attempt.id);
    const completed = completeVerifiedAttempt(attempt.id, { headSha: 'sha', specSha256 });

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
    recordPullRequest(first.id, {
      prUrl: 'https://github.com/k-mats/superset-fork/pull/1',
      prNumber: 1,
      prState: 'open',
      prHeadSha: 'sha',
    });
    completeAttempt(first.id, 'failed');
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

  it('compares pull request identity by number while guarding URL-only rows', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 102 });
    const attempt = createAttempt(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'canonicalize-session' });
    markRunning(attempt.id);
    const rawDb = getRawDb();
    if (!rawDb) throw new Error('Raw database was not initialized');
    rawDb
      .prepare('UPDATE attempts SET pr_url = ?, pr_number = ? WHERE id = ?')
      .run('https://github.com/Acme/Widget/pull/42/', 42, attempt.id);

    const refreshed = recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/acme/widget/pull/42',
      prNumber: 42,
      prState: 'open',
      prHeadSha: 'abc',
    });
    expect(refreshed.prUrl).toBe('https://github.com/acme/widget/pull/42');
    expect(() =>
      recordPullRequest(attempt.id, {
        prUrl: 'https://github.com/owner/repo/pull/43',
        prNumber: 43,
        prState: 'open',
        prHeadSha: 'def',
      })
    ).toThrow(PullRequestMismatchError);
    completeAttempt(attempt.id, 'failed');

    const repositoryChanged = createAttempt(task.id);
    markDispatching(repositoryChanged.id);
    markSessionCreated(repositoryChanged.id, { devinSessionId: 'repository-change-session' });
    markRunning(repositoryChanged.id);
    rawDb
      .prepare('UPDATE attempts SET pr_url = ?, pr_number = ? WHERE id = ?')
      .run('https://github.com/other/project/pull/42/', 42, repositoryChanged.id);
    expect(() =>
      recordPullRequest(repositoryChanged.id, {
        prUrl: 'https://github.com/acme/widget/pull/42',
        prNumber: 42,
        prState: 'open',
        prHeadSha: 'ghi',
      })
    ).toThrow(PullRequestMismatchError);
    completeAttempt(repositoryChanged.id, 'failed');

    const urlOnly = createAttempt(task.id);
    markDispatching(urlOnly.id);
    markSessionCreated(urlOnly.id, { devinSessionId: 'url-only-session' });
    completeAttempt(urlOnly.id, 'failed');
    rawDb
      .prepare('UPDATE attempts SET pr_url = ?, pr_number = NULL WHERE id = ?')
      .run('https://github.com/other/project/pull/42/', urlOnly.id);
    expect(() =>
      recordPullRequest(urlOnly.id, {
        prUrl: 'https://github.com/acme/widget/pull/42',
        prNumber: 42,
        prState: 'open',
        prHeadSha: 'ghi',
      })
    ).toThrow(PullRequestMismatchError);
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
    completeAttempt(attempt.id, 'failed');
    expect(() => markRunning(attempt.id)).toThrow(InvalidTransitionError);
    expect(() =>
      recordPullRequest(attempt.id, {
        prUrl: 'https://example.com/pr',
        prNumber: 1,
        prState: 'open',
        prHeadSha: 'sha',
      })
    ).not.toThrow();
    expect(() => completeAttempt(attempt.id, 'failed')).toThrow(InvalidTransitionError);
    expect(() => recordStructuredOutput(attempt.id, { raw: null, parsed: undefined })).toThrow(
      InvalidTransitionError
    );
  });

  it('accepts a structured output only once', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'sess' });
    const parsed = {
      schema_version: 1 as const,
      outcome: 'no_action' as const,
      pr_url: null,
      diagnosis: 'd',
      tests_run: [],
      risks: [],
      needs_human_reason: null,
    };

    const recorded = recordStructuredOutput(attempt.id, { raw: parsed, parsed });
    expect(recorded.agentOutcome).toBe('no_action');
    expect(recorded.structuredOutputAcceptedAt).toEqual(expect.any(Number));

    const second = {
      ...parsed,
      outcome: 'needs_human' as const,
      needs_human_reason: 'needs a call',
    };
    expect(() => recordStructuredOutput(attempt.id, { raw: second, parsed: second })).toThrow(
      StructuredOutputAlreadyAcceptedError
    );

    const stored = listAttempts(task.id)[0];
    expect(stored?.agentOutcome).toBe('no_action');
    expect(stored?.structuredOutputAcceptedAt).toBe(recorded.structuredOutputAcceptedAt);

    // Evidence-only writes after acceptance are also rejected, so a stale
    // reader cannot wipe the accepted agent fields.
    expect(() =>
      recordStructuredOutput(attempt.id, { raw: { partial: true }, parsed: undefined })
    ).toThrow(StructuredOutputAlreadyAcceptedError);
    const after = listAttempts(task.id)[0];
    expect(after?.agentOutcome).toBe('no_action');
    expect(after?.structuredOutputRaw).toBe(recorded.structuredOutputRaw);
    expect(after?.state).toBe('session_created');

    // Once the attempt is completed, acceptance still wins over the
    // completed-state guard so concurrent collectors see AlreadyAccepted.
    completeAttempt(attempt.id, 'escalated', { reason: 'done' });
    expect(() => recordStructuredOutput(attempt.id, { raw: parsed, parsed })).toThrow(
      StructuredOutputAlreadyAcceptedError
    );
    expect(() => recordStructuredOutput(attempt.id, { raw: null, parsed: undefined })).toThrow(
      StructuredOutputAlreadyAcceptedError
    );

    const plain = createAttempt(task.id);
    completeAttempt(plain.id, 'cancelled');
    expect(() => recordStructuredOutput(plain.id, { raw: null, parsed: undefined })).toThrow(
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

  it('rejects succeeded via completeAttempt even for a verifying attempt with a session', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);

    expect(() => completeAttempt(attempt.id, 'succeeded')).toThrow(InvalidTransitionError);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'sess-succeeded' });
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 1,
      prState: 'open',
      prHeadSha: 'sha',
    });
    markVerifying(attempt.id);
    expect(() => completeAttempt(attempt.id, 'succeeded')).toThrow(InvalidTransitionError);
    expect(getDb().select().from(attempts).all()[0]?.state).toBe('verifying');
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

  it('requeues a dispatching attempt without a session as failed + new pending attempt', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    claimAttemptForDispatch(attempt.id);

    const GRACE = 300_000;
    const dispatchedAt = getDb().select().from(attempts).get()?.dispatchedAt ?? 0;
    expect(() =>
      requeueDispatchFailedAttempt(attempt.id, GRACE, getDb(), dispatchedAt + GRACE - 1)
    ).toThrow(/within the 300000 ms dispatch grace period/);
    expect(listAttempts(task.id)).toHaveLength(1);

    const { failed, requeued } = requeueDispatchFailedAttempt(
      attempt.id,
      GRACE,
      getDb(),
      dispatchedAt + GRACE
    );
    expect(failed).toMatchObject({
      id: attempt.id,
      state: 'completed',
      outcome: 'failed',
      outcomeReason: REQUEUE_OUTCOME_REASON,
    });
    expect(requeued).toMatchObject({ taskId: task.id, attemptNumber: 2, state: 'pending' });
    expect(requeued.correlationId).not.toBe(attempt.correlationId);
    expect(listAttempts(task.id)).toHaveLength(2);
    expect(findPendingAttempts().map((row) => row.attempt.id)).toEqual([requeued.id]);
  });

  it('refuses to requeue attempts that are not dispatching or already have a session', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    expect(() => requeueDispatchFailedAttempt(attempt.id, 0)).toThrow(AttemptNotRequeueableError);
    expect(listAttempts(task.id)).toHaveLength(1);

    claimAttemptForDispatch(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'devin-1' });
    expect(() => requeueDispatchFailedAttempt(attempt.id, 0)).toThrow(AttemptNotRequeueableError);
    expect(getAttemptByCorrelationId(attempt.correlationId)?.state).toBe('session_created');
    expect(listAttempts(task.id)).toHaveLength(1);
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

    completeAttempt(first.id, 'failed');
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

  it('tracks completed pull requests until they are closed or merged', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 4 });
    const rawDb = getRawDb();
    if (!rawDb) throw new Error('Raw database was not initialized');
    const setPrState = (prState: 'open' | 'closed' | 'merged' | null) => {
      const attempt = createAttempt(task.id);
      markDispatching(attempt.id);
      markSessionCreated(attempt.id, { devinSessionId: `legacy-session-${String(attempt.id)}` });
      completeAttempt(attempt.id, 'failed');
      rawDb
        .prepare('UPDATE attempts SET pr_url = ?, pr_number = ?, pr_state = ? WHERE id = ?')
        .run('https://github.com/owner/repo/pull/42', 42, prState, attempt.id);
      return attempt.id;
    };
    const unknown = setPrState(null);
    const open = setPrState('open');
    const closed = setPrState('closed');
    const merged = setPrState('merged');

    expect(
      findCompletedAttemptsWithTrackedPullRequests().map(({ attempt: row }) => row.id)
    ).toEqual([unknown, open]);
    expect(
      findCompletedAttemptsWithTrackedPullRequests().map(({ attempt: row }) => row.id)
    ).not.toContain(closed);
    expect(
      findCompletedAttemptsWithTrackedPullRequests().map(({ attempt: row }) => row.id)
    ).not.toContain(merged);
  });
});

describe('verification candidate and approval state', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  const candidate = (script: string) => ({
    shell: 'sh' as const,
    script,
    sha256: createHash('sha256').update(`sh\n${script}`).digest('hex'),
  });

  it('sets, idempotently keeps, and overwrites the verification candidate', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);

    const first = setVerificationCandidate(attempt.id, candidate('echo one'), 'operator');
    expect(first.verificationCandidateSha256).toBe(candidate('echo one').sha256);
    expect(first.verificationCandidateSource).toBe('operator');
    expect(first.verificationCandidateUpdatedAt).toEqual(expect.any(Number));

    const same = setVerificationCandidate(
      attempt.id,
      candidate('echo one'),
      'issue_verification_section'
    );
    expect(same.verificationCandidateUpdatedAt).toBe(first.verificationCandidateUpdatedAt);
    expect(same.verificationCandidateSource).toBe('operator');

    const changed = setVerificationCandidate(attempt.id, candidate('echo two'), 'agent_tests_run');
    expect(changed.verificationCandidateSha256).toBe(candidate('echo two').sha256);
    expect(changed.verificationCandidateSource).toBe('agent_tests_run');
  });

  it('approves only a hash matching the current candidate', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    expect(() => approveVerificationSpec(attempt.id, 'deadbeef', 'operator')).toThrow(
      VerificationSpecMismatchError
    );

    const proposed = candidate('echo hi');
    setVerificationCandidate(attempt.id, proposed, 'operator');
    expect(() => approveVerificationSpec(attempt.id, 'deadbeef', 'operator')).toThrow(
      VerificationSpecMismatchError
    );

    const approved = approveVerificationSpec(attempt.id, proposed.sha256, 'operator');
    expect(approved.verificationApprovedSha256).toBe(proposed.sha256);
    expect(approved.verificationApprovedScript).toBe(proposed.script);
    expect(approved.verificationApprovedBy).toBe('operator');
    expect(approved.verificationApprovedAt).toEqual(expect.any(Number));
  });

  it('returns to pending approval when the candidate changes', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    const first = candidate('echo v1');
    setVerificationCandidate(attempt.id, first, 'operator');
    approveVerificationSpec(attempt.id, first.sha256, 'operator');

    const second = candidate('echo v2');
    const updated = setVerificationCandidate(attempt.id, second, 'operator');
    expect(updated.verificationCandidateSha256).toBe(second.sha256);
    expect(updated.verificationApprovedSha256).toBe(first.sha256);
  });

  it('records, lists, and finds verification rows', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);

    recordVerification({
      attemptId: attempt.id,
      headSha: 'sha-a',
      kind: 'github_checks',
      status: 'unverified',
      reason: 'no_checks',
    });
    recordVerification({
      attemptId: attempt.id,
      headSha: 'sha-a',
      kind: 'command',
      status: 'passed',
      specShell: 'bash',
      specScript: 'echo ok',
      specSha256: 'abc',
      exitCode: 0,
    });
    recordVerification({
      attemptId: attempt.id,
      headSha: 'sha-b',
      kind: 'command',
      status: 'failed',
      exitCode: 1,
    });

    expect(listVerifications(attempt.id)).toHaveLength(3);
    expect(findLatestVerification(attempt.id, 'sha-a', 'command')).toMatchObject({
      status: 'passed',
      specSha256: 'abc',
    });
    expect(findLatestVerification(attempt.id, 'sha-b', 'command')).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
    expect(findLatestVerification(attempt.id, 'sha-c', 'command')).toBeUndefined();
  });

  it('enforces candidate and approval check constraints', () => {
    const sqlite = getRawDb();
    if (!sqlite) throw new Error('Database not initialized');
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    const timestamp = Date.now();

    expect(() =>
      sqlite
        .prepare('UPDATE attempts SET verification_candidate_sha256 = ? WHERE id = ?')
        .run('abc', attempt.id)
    ).toThrow();
    expect(() =>
      sqlite
        .prepare('UPDATE attempts SET verification_candidate_source = ? WHERE id = ?')
        .run('bogus', attempt.id)
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          'UPDATE attempts SET verification_approved_sha256 = ?, verification_approved_shell = ?, verification_approved_script = ?, verification_approved_at = ? WHERE id = ?'
        )
        .run('abc', 'sh', 'x', timestamp, attempt.id)
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          'INSERT INTO verifications (attempt_id, head_sha, kind, status, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(attempt.id, 'sha', 'bogus', 'passed', timestamp)
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          'INSERT INTO verifications (attempt_id, head_sha, kind, status, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(attempt.id, 'sha', 'command', 'bogus', timestamp)
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          `UPDATE attempts SET verification_candidate_shell = 'zsh',
             verification_candidate_script = 'x', verification_candidate_sha256 = 'h',
             verification_candidate_source = 'operator', verification_candidate_updated_at = ?
           WHERE id = ?`
        )
        .run(timestamp, attempt.id)
    ).toThrow();
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO verifications (attempt_id, head_sha, kind, status, spec_shell, created_at)
           VALUES (?, 'sha', 'command', 'passed', 'zsh', ?)`
        )
        .run(attempt.id, timestamp)
    ).toThrow();
  });

  it('recomputes the candidate hash and ignores a caller-supplied sha256', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    const bogusSha = hashVerificationSpec('sh', 'echo b');
    const callerSpec = { shell: 'sh' as const, script: 'echo a', sha256: bogusSha };

    const updated = setVerificationCandidate(attempt.id, callerSpec, 'operator');
    const realSha = hashVerificationSpec('sh', 'echo a');
    expect(updated.verificationCandidateSha256).toBe(realSha);
    expect(() => approveVerificationSpec(attempt.id, bogusSha, 'operator')).toThrow(
      VerificationSpecMismatchError
    );
  });

  it('treats an equal-hash non-operator proposal as a no-op over an issue candidate', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    const issueCandidate = setVerificationCandidate(
      attempt.id,
      { shell: 'sh', script: 'echo ok' },
      'issue_verification_section'
    );

    const unchanged = setVerificationCandidate(
      attempt.id,
      { shell: 'sh', script: 'echo ok' },
      'agent_tests_run'
    );
    expect(unchanged).toEqual(issueCandidate);
    expect(unchanged.verificationCandidateSource).toBe('issue_verification_section');
  });

  it('clearVerificationCandidate with onlySource mismatch is a no-op', () => {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    const withCandidate = setVerificationCandidate(
      attempt.id,
      { shell: 'sh', script: 'echo op' },
      'operator'
    );

    const unchanged = clearVerificationCandidate(attempt.id, {
      onlySource: 'issue_verification_section',
    });
    expect(unchanged).toEqual(withCandidate);

    const cleared = clearVerificationCandidate(attempt.id, { onlySource: 'operator' });
    expect(cleared.verificationCandidateSha256).toBeNull();
    expect(cleared.verificationCandidateSource).toBeNull();
  });
});

describe('completeVerifiedAttempt', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  function verifiedAttempt() {
    const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 1 });
    const attempt = createAttempt(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'sess-verified' });
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/1',
      prNumber: 1,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    return attempt.id;
  }

  it('completes a verifying attempt on the happy path', () => {
    const attemptId = verifiedAttempt();
    const specSha256 = verifyAttempt(attemptId, 'sha-1');

    const completed = completeVerifiedAttempt(attemptId, {
      headSha: 'sha-1',
      specSha256,
    });
    expect(completed).toMatchObject({ state: 'completed', outcome: 'succeeded' });
    expect(completed.outcomeReason).toBe('independent_verification_passed: sha-1');
  });

  it('throws when the passed row is for a different head sha', () => {
    const attemptId = verifiedAttempt();
    const specSha256 = verifyAttempt(attemptId, 'sha-2');

    expect(() => completeVerifiedAttempt(attemptId, { headSha: 'sha-1', specSha256 })).toThrow(
      InvalidTransitionError
    );
    expect(() => completeVerifiedAttempt(attemptId, { headSha: 'sha-2', specSha256 })).toThrow(
      InvalidTransitionError
    );
    expect(getDb().select().from(attempts).all()[0]?.state).toBe('verifying');
  });

  it('throws when the latest row for the head and spec is a later failure', () => {
    const attemptId = verifiedAttempt();
    const specSha256 = verifyAttempt(attemptId, 'sha-1');
    recordVerification({
      attemptId,
      headSha: 'sha-1',
      kind: 'command',
      status: 'failed',
      specShell: 'sh',
      specScript: 'echo ok',
      specSha256,
    });

    expect(() => completeVerifiedAttempt(attemptId, { headSha: 'sha-1', specSha256 })).toThrow(
      InvalidTransitionError
    );
    expect(getDb().select().from(attempts).all()[0]?.state).toBe('verifying');
  });

  it('succeeds when a passed row supersedes an earlier failure', () => {
    const attemptId = verifiedAttempt();
    const script = 'echo ok';
    const specSha256 = hashVerificationSpec('sh', script);
    markVerifying(attemptId);
    setVerificationCandidate(attemptId, { shell: 'sh', script }, 'operator');
    approveVerificationSpec(attemptId, specSha256, 'operator');
    recordVerification({
      attemptId,
      headSha: 'sha-1',
      kind: 'command',
      status: 'failed',
      specShell: 'sh',
      specScript: script,
      specSha256,
    });
    recordVerification({
      attemptId,
      headSha: 'sha-1',
      kind: 'command',
      status: 'passed',
      specShell: 'sh',
      specScript: script,
      specSha256,
    });

    const completed = completeVerifiedAttempt(attemptId, {
      headSha: 'sha-1',
      specSha256,
    });
    expect(completed).toMatchObject({ state: 'completed', outcome: 'succeeded' });
  });

  it('throws when the spec is approved but no passed row exists', () => {
    const attemptId = verifiedAttempt();
    const script = 'echo ok';
    const specSha256 = hashVerificationSpec('sh', script);
    markVerifying(attemptId);
    setVerificationCandidate(attemptId, { shell: 'sh', script }, 'operator');
    approveVerificationSpec(attemptId, specSha256, 'operator');

    expect(() => completeVerifiedAttempt(attemptId, { headSha: 'sha-1', specSha256 })).toThrow(
      InvalidTransitionError
    );
  });
});
