import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import {
  approveVerificationSpec,
  completeAttempt,
  completeVerifiedAttempt,
  createAttempt,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  recordVerification,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import { bucketForState, buildReport, TASK_BUCKETS } from '../src/reporting/report-model.js';
import { NORMALIZED_TASK_STATES } from '../src/tracking/normalized-task-state.js';
import { hashVerificationSpec } from '../src/verification/spec.js';

const db = () => getDb();

function attemptFor(taskId: number) {
  const attempt = db().select().from(attempts).where(eq(attempts.taskId, taskId)).all()[0];
  if (!attempt) throw new Error('Test attempt was not created');
  return attempt;
}

function taskRow(report: ReturnType<typeof buildReport>) {
  const row = report.tasks[0];
  if (!row) throw new Error('Test report task was not created');
  return row;
}

function makeTask(issueNumber: number, runKind: 'real' | 'demo' | 'mock' = 'real') {
  const task = upsertTask({
    repoOwner: 'owner',
    repoName: 'repo',
    issueNumber,
    title: `Issue ${String(issueNumber)}`,
  });
  createAttempt(task.id, runKind);
  return task;
}

function verify(attemptId: number, sessionId: string, headSha = 'head') {
  markDispatching(attemptId);
  markSessionCreated(attemptId, {
    devinSessionId: sessionId,
    devinSessionUrl: `https://app.devin.ai/sessions/${sessionId}`,
  });
  markRunning(attemptId);
  recordPullRequest(attemptId, {
    prUrl: `https://github.com/owner/repo/pull/${String(attemptId)}`,
    prNumber: attemptId,
    prState: 'open',
    prHeadSha: headSha,
  });
  markVerifying(attemptId);
  const script = 'echo ok';
  const specSha256 = hashVerificationSpec('sh', script);
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
    finishedAt: Date.now(),
  });
  return completeVerifiedAttempt(attemptId, { headSha, specSha256 });
}

describe('report model', () => {
  beforeAll(() => {
    runMigrations();
  });
  beforeEach(() => {
    db().delete(verifications).run();
    db().delete(attempts).run();
    db().delete(tasks).run();
  });
  afterAll(() => {
    closeDb();
  });

  it('uses the latest completed attempt and includes attempt history', () => {
    const task = makeTask(1);
    const first = attemptFor(task.id);
    completeAttempt(first.id, 'failed', { reason: 'first failed' });
    const second = createAttempt(task.id, 'real');
    verify(second.id, 'session-2');

    const report = buildReport({ now: Date.now() });
    expect(report.summary.totalTasks).toBe(1);
    expect(report.summary.byBucket.successful).toBe(1);
    expect(report.summary.byState.VERIFIED).toBe(1);
    expect(report.tasks[0]?.attemptCount).toBe(2);
    expect(report.tasks[0]?.attempts).toHaveLength(2);
    expect(report.tasks[0]?.verifiedAt).not.toBeNull();
    expect(report.tasks[0]?.terminalAt).not.toBeNull();
  });

  it('does not treat a pull request without verification as successful', () => {
    const task = makeTask(2);
    const attempt = attemptFor(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'session-pr' });
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/2',
      prNumber: 2,
      prState: 'open',
      prHeadSha: 'head-pr',
    });
    markVerifying(attempt.id);
    const row = taskRow(buildReport({ now: Date.now() }));
    expect(row.state).toBe('PR_OPEN');
    expect(row.bucket).toBe('active');
  });

  it.each([
    ['escalated', 'needs_human'],
    ['no_action', 'no_action'],
  ] as const)('maps completed %s to %s', (outcome, bucket) => {
    const task = makeTask(outcome === 'escalated' ? 3 : 4);
    const attempt = attemptFor(task.id);
    completeAttempt(attempt.id, outcome);
    expect(buildReport({ now: Date.now() }).tasks[0]?.bucket).toBe(bucket);
  });

  it('filters by current attempt run kind while exposing all-kind breakdown', () => {
    makeTask(5, 'mock');
    makeTask(6, 'demo');
    const report = buildReport({ now: Date.now() });
    expect(report.summary.totalTasks).toBe(0);
    expect(report.runKindBreakdown).toMatchObject({ mock: 1, demo: 1 });
    expect(buildReport({ filter: { runKinds: ['mock', 'demo'] } }).summary.totalTasks).toBe(2);
  });

  it('counts discovered tasks in the requested throughput windows', () => {
    const task = makeTask(7);
    const now = Date.now();
    db()
      .update(tasks)
      .set({ createdAt: now - 2 * 24 * 60 * 60 * 1000 })
      .where(eq(tasks.id, task.id))
      .run();
    const report = buildReport({ now });
    expect(report.throughput.tasksDiscovered).toEqual({ last24h: 0, last7d: 1 });
  });

  it('calculates cycle-time median and null for an empty sample', () => {
    for (const [issueNumber, duration] of [
      [8, 1_000],
      [9, 3_000],
    ] as const) {
      const task = makeTask(issueNumber);
      const attempt = attemptFor(task.id);
      completeAttempt(attempt.id, 'failed');
      const discoveredAt = 1_000_000;
      db().update(tasks).set({ createdAt: discoveredAt }).where(eq(tasks.id, task.id)).run();
      db()
        .update(attempts)
        .set({ completedAt: discoveredAt + duration, updatedAt: discoveredAt + duration })
        .where(eq(attempts.id, attempt.id))
        .run();
    }
    expect(buildReport({ now: 2_000_000 }).cycleTime).toEqual({
      medianMsIntakeToTerminal: 2_000,
      sampleSize: 2,
    });
    db().delete(verifications).run();
    db().delete(attempts).run();
    db().delete(tasks).run();
    expect(buildReport({ now: 2_000_000 }).cycleTime).toEqual({
      medianMsIntakeToTerminal: null,
      sampleSize: 0,
    });
  });

  it('counts tasks without attempts but excludes them from task totals', () => {
    upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber: 10, title: 'No attempt' });
    makeTask(11);
    const report = buildReport({ now: Date.now() });
    expect(report.summary.totalTasks).toBe(1);
    expect(report.tasksWithoutAttempts).toBe(1);
  });

  it('has a bucket for every normalized task state', () => {
    for (const state of NORMALIZED_TASK_STATES) {
      expect(TASK_BUCKETS).toContain(bucketForState(state));
    }
  });
});
