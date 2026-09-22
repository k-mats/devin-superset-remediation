import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
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
  recordSessionSnapshot,
  recordStructuredOutput,
  recordPullRequest,
  recordVerification,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import { bucketForState, buildReport, TASK_BUCKETS } from '../src/reporting/report-model.js';
import { renderDashboard } from '../src/reporting/render-dashboard.js';
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

function makeTask(issueNumber: number) {
  const task = upsertTask({
    repoOwner: 'owner',
    repoName: 'repo',
    issueNumber,
    title: `Issue ${String(issueNumber)}`,
  });
  createAttempt(task.id);
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
    exitCode: 0,
    evidenceUrl: `https://example.test/evidence/${sessionId}`,
    specSha256,
    finishedAt: Date.now(),
  });
  recordVerification({
    attemptId,
    headSha,
    kind: 'github_checks',
    status: 'passed',
    reason: 'checks_passed',
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
    const second = createAttempt(task.id);
    verify(second.id, 'session-2');

    const report = buildReport({ now: Date.now() });
    expect(report.summary.totalTasks).toBe(1);
    expect(report.summary.byBucket.successful).toBe(1);
    expect(report.summary.byState.VERIFIED).toBe(1);
    expect(report.tasks[0]?.attemptCount).toBe(2);
    expect(report.tasks[0]?.attempts).toHaveLength(2);
    expect(report.tasks[0]?.verifiedAt).not.toBeNull();
    expect(report.tasks[0]?.terminalAt).not.toBeNull();
    expect(report.tasks[0]?.attempts[0]?.terminalAt).not.toBeNull();
    expect(report.tasks[0]?.attempts[1]?.verifiedAt).not.toBeNull();
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

  it('surfaces a derived terminal state without a persisted timestamp', () => {
    const task = makeTask(3);
    const attempt = attemptFor(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'session-closed-pr' });
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/3',
      prNumber: 3,
      prState: 'closed',
      prHeadSha: 'head-closed',
    });
    markVerifying(attempt.id);
    const now = Date.now();
    const report = buildReport({ now });
    const row = taskRow(report);

    expect(row.bucket).toBe('needs_human');
    expect(row.terminalAt).toBeNull();
    expect(report.summary.terminalWithoutTimestamp).toBe(1);
    expect(report.throughput.tasksReachedTerminal.last24h).toBe(0);
    expect(report.cycleTime.sampleSize).toBe(0);
  });

  it('uses decisive failed verification time for a verifying terminal state', () => {
    const task = makeTask(6);
    const attempt = attemptFor(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'session-failed-verification' });
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/6',
      prNumber: 6,
      prState: 'open',
      prHeadSha: 'head-failed',
    });
    markVerifying(attempt.id);
    const script = 'echo failed';
    const specSha256 = hashVerificationSpec('sh', script);
    setVerificationCandidate(attempt.id, { shell: 'sh', script }, 'operator');
    approveVerificationSpec(attempt.id, specSha256, 'operator');
    const verificationTimestamp = 2_000_000;
    recordVerification({
      attemptId: attempt.id,
      headSha: 'head-failed',
      kind: 'command',
      status: 'failed',
      specShell: 'sh',
      specScript: script,
      specSha256,
      finishedAt: verificationTimestamp,
    });

    const row = taskRow(buildReport({ now: Date.now() }));
    expect(row.state).toBe('VERIFICATION_FAILED');
    expect(row.terminalAt).toBe(verificationTimestamp);
  });

  it.each([
    ['escalated', 'needs_human'],
    ['no_action', 'no_action'],
  ] as const)('maps completed %s to %s', (outcome, bucket) => {
    const task = makeTask(outcome === 'escalated' ? 4 : 5);
    const attempt = attemptFor(task.id);
    completeAttempt(attempt.id, outcome);
    expect(buildReport({ now: Date.now() }).tasks[0]?.bucket).toBe(bucket);
  });

  it('reports the configured database context', () => {
    const report = buildReport({ now: Date.now() });
    expect(report.context.databasePath).toBe(resolve('./test-database.db'));
    expect(report.context.configuredRepository).toBeNull();
    expect(report.unit).toEqual({
      summary: 'tasks',
      throughput: {
        tasksDiscovered: 'tasks',
        tasksReachedTerminal: 'tasks',
        tasksVerified: 'tasks',
        attemptsCreated: 'attempts',
        observedAcuTerminalAttempts: 'acus',
      },
    });
  });

  it('includes tasks from repositories other than the configured intake repository', () => {
    const first = makeTask(12);
    const second = upsertTask({
      repoOwner: 'other-owner',
      repoName: 'other-repo',
      issueNumber: 13,
      title: 'Other repository task',
    });
    createAttempt(second.id);

    const report = buildReport({ now: Date.now() });
    expect(report.summary.totalTasks).toBe(2);
    expect(report.tasks.map((task) => `${task.repoOwner}/${task.repoName}`)).toEqual(
      expect.arrayContaining([
        `${first.repoOwner}/${first.repoName}`,
        `${second.repoOwner}/${second.repoName}`,
      ])
    );
  });

  it('includes verification evidence in lastUpdatedAt', () => {
    const task = makeTask(5);
    const attempt = attemptFor(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, { devinSessionId: 'session-verification' });
    markRunning(attempt.id);
    markVerifying(attempt.id);
    const attemptUpdatedAt = 2_000_000;
    db()
      .update(attempts)
      .set({ updatedAt: attemptUpdatedAt })
      .where(eq(attempts.id, attempt.id))
      .run();
    db().update(tasks).set({ updatedAt: attemptUpdatedAt }).where(eq(tasks.id, task.id)).run();
    const verification = recordVerification({
      attemptId: attempt.id,
      headSha: 'head',
      kind: 'command',
      status: 'failed',
      reason: 'command_failed',
      finishedAt: null,
    });
    const verificationTimestamp = attemptUpdatedAt + 1_000;
    db()
      .update(verifications)
      .set({ createdAt: verificationTimestamp })
      .where(eq(verifications.id, verification.id))
      .run();

    expect(taskRow(buildReport({ now: verificationTimestamp })).lastUpdatedAt).toBe(
      verificationTimestamp
    );
  });

  it('retains historical terminal throughput when a retry is active', () => {
    const task = makeTask(14);
    const first = attemptFor(task.id);
    completeAttempt(first.id, 'failed');
    const second = createAttempt(task.id);
    const terminalAt = 1_000_000;
    const discoveredAt = terminalAt - 10_000;
    db().update(tasks).set({ createdAt: discoveredAt }).where(eq(tasks.id, task.id)).run();
    db()
      .update(attempts)
      .set({ completedAt: terminalAt, updatedAt: terminalAt })
      .where(eq(attempts.id, first.id))
      .run();
    db()
      .update(attempts)
      .set({ createdAt: terminalAt + 1, updatedAt: terminalAt + 1 })
      .where(eq(attempts.id, second.id))
      .run();

    const report = buildReport({ now: terminalAt + 1_000 });
    expect(report.summary.byBucket.active).toBe(1);
    expect(report.summary.byState.QUEUED).toBe(1);
    expect(report.throughput.tasksReachedTerminal.last24h).toBe(1);
    expect(report.cycleTime.sampleSize).toBe(1);
  });

  it('counts distinct historical task events across failed and verified retries', () => {
    const task = makeTask(15);
    const first = attemptFor(task.id);
    completeAttempt(first.id, 'failed');
    const second = createAttempt(task.id);
    verify(second.id, 'session-retry');
    const firstTerminalAt = 1_000_000;
    const secondTerminalAt = 2_000_000;
    const discoveredAt = 900_000;
    db().update(tasks).set({ createdAt: discoveredAt }).where(eq(tasks.id, task.id)).run();
    db()
      .update(attempts)
      .set({ completedAt: firstTerminalAt, updatedAt: firstTerminalAt })
      .where(eq(attempts.id, first.id))
      .run();
    db()
      .update(attempts)
      .set({ completedAt: secondTerminalAt, updatedAt: secondTerminalAt })
      .where(eq(attempts.id, second.id))
      .run();
    db()
      .update(verifications)
      .set({ finishedAt: secondTerminalAt })
      .where(eq(verifications.attemptId, second.id))
      .run();

    const report = buildReport({ now: secondTerminalAt + 1_000 });
    expect(report.summary.byState.VERIFIED).toBe(1);
    expect(report.throughput.tasksReachedTerminal.last24h).toBe(1);
    expect(report.throughput.tasksVerified.last24h).toBe(1);
    expect(report.cycleTime.sampleSize).toBe(2);
  });

  it('retains completed success events after a later PR head refresh', () => {
    const task = makeTask(16);
    const attempt = attemptFor(task.id);
    verify(attempt.id, 'session-head-refresh', 'head-original');
    const completedAt = 2_000_000;
    db()
      .update(tasks)
      .set({ createdAt: completedAt - 1_000 })
      .where(eq(tasks.id, task.id))
      .run();
    db()
      .update(attempts)
      .set({
        completedAt,
        updatedAt: completedAt,
        prHeadSha: 'head-refresh',
      })
      .where(eq(attempts.id, attempt.id))
      .run();

    const report = buildReport({ now: completedAt + 1_000 });
    expect(report.summary.byState.PR_OPEN).toBe(1);
    expect(report.summary.byBucket.active).toBe(1);
    expect(report.throughput.tasksReachedTerminal.last24h).toBe(1);
    expect(report.throughput.tasksVerified.last24h).toBe(1);
    expect(report.cycleTime.sampleSize).toBe(1);
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
    expect(report.throughput.tasksDiscovered).toEqual({
      last24h: 0,
      last7d: 1,
      last30d: 1,
      total: 1,
    });
  });

  it('counts attemptsCreated across 24h/7d/30d/Total windows at boundaries', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    const createdAts = [
      now - day, // exactly at the 24h boundary → inside 24h
      now - day - 1, // outside 24h, inside 7d
      now - 7 * day - 1, // outside 7d, inside 30d
      now - 30 * day - 1, // outside 30d, total only
      now + 1, // future → excluded everywhere
    ];
    createdAts.forEach((createdAt, index) => {
      const task = makeTask(50 + index);
      const attempt = attemptFor(task.id);
      db().update(tasks).set({ createdAt }).where(eq(tasks.id, task.id)).run();
      db().update(attempts).set({ createdAt }).where(eq(attempts.id, attempt.id)).run();
    });

    const report = buildReport({ now });
    expect(report.throughput.attemptsCreated).toEqual({
      last24h: 1,
      last7d: 2,
      last30d: 3,
      total: 4,
    });
    expect(report.throughput.tasksDiscovered).toEqual({
      last24h: 1,
      last7d: 2,
      last30d: 3,
      total: 4,
    });
    const { last24h, last7d, last30d, total } = report.throughput.attemptsCreated;
    expect(total).toBeGreaterThanOrEqual(last30d);
    expect(last30d).toBeGreaterThanOrEqual(last7d);
    expect(last7d).toBeGreaterThanOrEqual(last24h);
  });

  it('counts attempt-less tasks in tasksDiscovered but not in totalTasks', () => {
    makeTask(60);
    const orphan = upsertTask({
      repoOwner: 'owner',
      repoName: 'repo',
      issueNumber: 61,
      title: 'orphan',
    });
    const now = Date.now();
    db().update(tasks).set({ createdAt: now }).where(eq(tasks.id, orphan.id)).run();

    const report = buildReport({ now });
    expect(report.throughput.tasksDiscovered).toEqual({
      last24h: 2,
      last7d: 2,
      last30d: 2,
      total: 2,
    });
    expect(report.summary.totalTasks).toBe(1);
    expect(report.tasksWithoutAttempts).toBe(1);
  });

  it('counts retried terminal attempts once per task and VERIFIED alike', () => {
    const task = makeTask(62);
    const first = attemptFor(task.id);
    completeAttempt(first.id, 'failed');
    const second = createAttempt(task.id);
    verify(second.id, 'session-retry-windows');
    const now = 100 * 24 * 60 * 60 * 1000;
    db()
      .update(attempts)
      .set({ completedAt: now - 1, updatedAt: now - 1, createdAt: now - 2 })
      .where(eq(attempts.id, first.id))
      .run();
    db()
      .update(attempts)
      .set({ completedAt: now - 1, updatedAt: now - 1, createdAt: now - 2 })
      .where(eq(attempts.id, second.id))
      .run();
    db()
      .update(verifications)
      .set({ finishedAt: now - 1 })
      .where(eq(verifications.attemptId, second.id))
      .run();

    const report = buildReport({ now });
    expect(report.throughput.tasksReachedTerminal).toEqual({
      last24h: 1,
      last7d: 1,
      last30d: 1,
      total: 1,
    });
    expect(report.throughput.tasksVerified).toEqual({
      last24h: 1,
      last7d: 1,
      last30d: 1,
      total: 1,
    });
    expect(report.throughput.attemptsCreated).toEqual({
      last24h: 2,
      last7d: 2,
      last30d: 2,
      total: 2,
    });
  });

  it('sums observed ACU over eligible terminal attempts only', () => {
    // eligible + observed: terminal attempt with a session and ACU 1.5
    const observedTask = makeTask(70);
    const observed = attemptFor(observedTask.id);
    markDispatching(observed.id);
    markSessionCreated(observed.id, {
      devinSessionId: 'session-observed',
      devinSessionUrl: 'https://app.devin.ai/sessions/session-observed',
    });
    markRunning(observed.id);
    recordSessionSnapshot(observed.id, {
      status: 'running',
      statusDetail: null,
      acusConsumed: 1.5,
      sessionUpdatedAt: Date.now(),
    });
    completeAttempt(observed.id, 'failed');
    // eligible but not observed: terminal attempt with a session but no ACU
    const silentTask = makeTask(71);
    const silent = attemptFor(silentTask.id);
    markDispatching(silent.id);
    markSessionCreated(silent.id, {
      devinSessionId: 'session-silent',
      devinSessionUrl: 'https://app.devin.ai/sessions/session-silent',
    });
    completeAttempt(silent.id, 'failed');
    // not eligible: running attempt with ACU 9 but no terminal timestamp
    const runningTask = makeTask(72);
    const running = attemptFor(runningTask.id);
    markDispatching(running.id);
    markSessionCreated(running.id, {
      devinSessionId: 'session-running',
      devinSessionUrl: 'https://app.devin.ai/sessions/session-running',
    });
    markRunning(running.id);
    recordSessionSnapshot(running.id, {
      status: 'running',
      statusDetail: null,
      acusConsumed: 9,
      sessionUpdatedAt: Date.now(),
    });
    // not eligible: terminal attempt without a Devin session
    const noSessionTask = makeTask(73);
    const noSession = attemptFor(noSessionTask.id);
    completeAttempt(noSession.id, 'failed');

    const report = buildReport({ now: Date.now() });
    const acu = report.throughput.observedAcuTerminalAttempts;
    expect(acu.unit).toBe('acus');
    expect(acu.semantics).toBe('observed_lower_bound');
    expect(acu.attribution).toBe('attempt_terminal_at');
    expect(acu.eligibility).toBe('terminal_attempts_with_terminal_at_and_devin_session');
    expect(acu.acus.total).toBe(1.5);
    expect(acu.observedAttempts.total).toBe(1);
    expect(acu.eligibleAttempts.total).toBe(2);
    expect(acu.acus.last24h).toBe(1.5);
    expect(acu.acus.last7d).toBe(1.5);
    expect(acu.acus.last30d).toBe(1.5);
  });

  it('reports null ACU when no eligible attempt has an observed value', () => {
    const task = makeTask(74);
    const attempt = attemptFor(task.id);
    markDispatching(attempt.id);
    markSessionCreated(attempt.id, {
      devinSessionId: 'session-null-acu',
      devinSessionUrl: 'https://app.devin.ai/sessions/session-null-acu',
    });
    completeAttempt(attempt.id, 'failed');

    const report = buildReport({ now: Date.now() });
    const acu = report.throughput.observedAcuTerminalAttempts;
    expect(acu.acus).toEqual({ last24h: null, last7d: null, last30d: null, total: null });
    expect(acu.observedAttempts.total).toBe(0);
    expect(acu.eligibleAttempts.total).toBe(1);
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
      basis: 'all_terminal_attempts',
    });
    db().delete(verifications).run();
    db().delete(attempts).run();
    db().delete(tasks).run();
    expect(buildReport({ now: 2_000_000 }).cycleTime).toEqual({
      medianMsIntakeToTerminal: null,
      sampleSize: 0,
      basis: 'all_terminal_attempts',
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

  describe('ledger', () => {
    it('keeps command and GitHub Checks evidence separate for a verified task', () => {
      const task = makeTask(30);
      const attempt = attemptFor(task.id);
      verify(attempt.id, 'ledger-verified');
      recordSessionSnapshot(attempt.id, {
        status: 'completed',
        statusDetail: 'done',
        acusConsumed: 2.5,
        sessionUpdatedAt: Date.now(),
      });

      const row = buildReport({ now: Date.now() }).ledger[0];
      if (row === undefined || row.current === null) throw new Error('Ledger attempt is missing');
      const current = row.current;
      expect(row.state).toBe('VERIFIED');
      expect(current.verification.command?.status).toBe('passed');
      expect(current.verification.command?.specSha256).toBe(current.approval.approvedSha256);
      expect(current.verification.command?.exitCode).toBe(0);
      expect(current.verification.githubChecks?.status).toBe('passed');
      expect(current.approval.approvedBy).toBe('operator');
      expect(current.approval.approvedAt).not.toBeNull();
      expect(current.acusConsumed).toBe(2.5);
      expect(current.timestamps).toHaveProperty('sessionLastPolledAt');
    });

    it('separates verification of a superseded PR head as stale evidence', () => {
      const task = makeTask(31);
      const attempt = attemptFor(task.id);
      verify(attempt.id, 'ledger-stale', 'head-a');
      recordPullRequest(attempt.id, {
        prUrl: `https://github.com/owner/repo/pull/${String(attempt.id)}`,
        prNumber: attempt.id,
        prState: 'open',
        prHeadSha: 'head-b',
      });

      const row = buildReport({ now: Date.now() }).ledger[0];
      if (row === undefined || row.current === null) throw new Error('Ledger attempt is missing');
      const current = row.current;
      expect(current.verification.command).toBeNull();
      expect(current.verification.stale[0]).toMatchObject({
        headSha: 'head-a',
        status: 'passed',
      });
      expect(row.state).toBe('PR_OPEN');
      expect(row.reason).toBe('verified_head_superseded');
      expect(renderDashboard(buildReport({ now: Date.now() }))).toContain('stale command');
    });

    it('keeps same-head verification history separate from current evidence', () => {
      const task = makeTask(31);
      const attempt = attemptFor(task.id);
      const headSha = 'same-head';
      recordPullRequest(attempt.id, {
        prUrl: `https://github.com/owner/repo/pull/${String(attempt.id)}`,
        prNumber: attempt.id,
        prState: 'open',
        prHeadSha: headSha,
      });
      const script = 'echo ok';
      const specSha256 = hashVerificationSpec('sh', script);
      setVerificationCandidate(attempt.id, { shell: 'sh', script }, 'operator');
      approveVerificationSpec(attempt.id, specSha256, 'operator');
      recordVerification({
        attemptId: attempt.id,
        headSha,
        kind: 'github_checks',
        status: 'unverified',
        reason: 'no_checks',
      });
      recordVerification({
        attemptId: attempt.id,
        headSha,
        kind: 'command',
        status: 'unverified',
        reason: 'verification_spec_pending_approval',
      });
      recordVerification({
        attemptId: attempt.id,
        headSha,
        kind: 'command',
        status: 'failed',
        exitCode: 127,
      });
      recordVerification({
        attemptId: attempt.id,
        headSha,
        kind: 'command',
        status: 'passed',
        specShell: 'sh',
        specScript: script,
        specSha256,
        exitCode: 0,
      });

      const report = buildReport({ now: Date.now() });
      const row = report.ledger[0];
      if (row === undefined || row.current === null) throw new Error('Ledger attempt is missing');
      const current = row.current;
      expect(current.verification.command?.status).toBe('passed');
      expect(current.verification.githubChecks).toMatchObject({
        status: 'unverified',
        reason: 'no_checks',
      });
      expect(
        current.verification.prior.map((verification) => [
          verification.kind,
          verification.status,
          verification.exitCode,
        ])
      ).toEqual([
        ['command', 'failed', 127],
        ['command', 'unverified', null],
      ]);
      expect(current.verification.stale).toEqual([]);
      expect(renderDashboard(report)).toContain('prior command');
      expect(renderDashboard(report)).toContain('2 prior run(s) for this head');
      expect(renderDashboard(report)).toContain('observed at:');
    });

    it('preserves unknown ACU as null and omits raw verification payloads', () => {
      const task = makeTask(32);
      const attempt = attemptFor(task.id);
      recordPullRequest(attempt.id, {
        prUrl: `https://github.com/owner/repo/pull/${String(attempt.id)}`,
        prNumber: attempt.id,
        prState: 'open',
        prHeadSha: 'redacted-head',
      });
      recordVerification({
        attemptId: attempt.id,
        headSha: 'redacted-head',
        kind: 'command',
        status: 'passed',
        specScript: 'SECRET_SCRIPT_BODY',
        evidenceSummary: 'RAW_OUTPUT_SENTINEL',
      });
      recordVerification({
        attemptId: attempt.id,
        headSha: 'redacted-head',
        kind: 'command',
        status: 'passed',
        specScript: 'SECRET_SCRIPT_BODY',
        evidenceSummary: 'RAW_OUTPUT_SENTINEL',
      });

      const report = buildReport({ now: Date.now() });
      const row = report.ledger[0];
      if (row === undefined || row.current === null) throw new Error('Ledger attempt is missing');
      expect(row.current.acusConsumed).toBeNull();
      expect(JSON.stringify(row)).not.toContain('"acusConsumed":0');
      expect(JSON.stringify(report)).not.toContain('SECRET_SCRIPT_BODY');
      expect(JSON.stringify(report)).not.toContain('RAW_OUTPUT_SENTINEL');
      expect(JSON.stringify(report)).not.toContain('evidenceSummary');
      expect(JSON.stringify(report)).not.toContain('specScript');
    });

    it('includes failed, needs-human, no-action, and cancelled outcomes', () => {
      const failed = makeTask(33);
      completeAttempt(attemptFor(failed.id).id, 'failed', { reason: 'broken' });
      const noAction = makeTask(34);
      completeAttempt(attemptFor(noAction.id).id, 'no_action');
      const cancelled = makeTask(35);
      completeAttempt(attemptFor(cancelled.id).id, 'cancelled');
      const escalated = makeTask(36);
      const escalatedAttempt = attemptFor(escalated.id);
      markDispatching(escalatedAttempt.id);
      markSessionCreated(escalatedAttempt.id, { devinSessionId: 'ledger-escalated' });
      markRunning(escalatedAttempt.id);
      recordStructuredOutput(escalatedAttempt.id, {
        raw: { outcome: 'needs_human' },
        parsed: {
          schema_version: 1,
          outcome: 'needs_human',
          pr_url: null,
          diagnosis: 'needs review',
          tests_run: [],
          risks: [],
          needs_human_reason: 'blocked on product decision',
        },
      });
      completeAttempt(escalatedAttempt.id, 'escalated', { reason: 'needs review' });

      const ledger = buildReport({ now: Date.now() }).ledger;
      expect(ledger.find((row) => row.issueNumber === 33)?.state).toBe('FAILED');
      expect(ledger.find((row) => row.issueNumber === 34)?.state).toBe('NO_ACTION');
      expect(ledger.find((row) => row.issueNumber === 35)?.state).toBe('CANCELLED');
      expect(ledger.find((row) => row.issueNumber === 36)).toMatchObject({
        state: 'NEEDS_HUMAN',
        current: { agentReported: { needsHumanReason: 'blocked on product decision' } },
      });
    });

    it('keeps all attempts in ascending history while exposing the active current attempt', () => {
      const task = makeTask(37);
      const first = attemptFor(task.id);
      markDispatching(first.id);
      markSessionCreated(first.id, { devinSessionId: 'ledger-first' });
      recordSessionSnapshot(first.id, {
        status: 'failed',
        statusDetail: null,
        acusConsumed: 1.5,
        sessionUpdatedAt: Date.now(),
      });
      completeAttempt(first.id, 'failed');
      const second = createAttempt(task.id);
      markDispatching(second.id);
      markSessionCreated(second.id, { devinSessionId: 'ledger-second' });
      markRunning(second.id);

      const row = buildReport({ now: Date.now() }).ledger[0];
      if (row === undefined || row.current === null) throw new Error('Ledger attempt is missing');
      expect(row.current.attemptNumber).toBe(2);
      expect(row.history).toHaveLength(2);
      expect(row.history[0]?.acusConsumed).toBe(1.5);
    });

    it('keeps ledger order aligned with task rows', () => {
      const task = makeTask(38);
      const taskWithoutAttempt = upsertTask({
        repoOwner: 'owner',
        repoName: 'repo',
        issueNumber: 39,
        title: 'No attempt',
      });
      const report = buildReport({ now: Date.now() });
      expect(report.ledger.length).toBe(report.tasks.length + report.tasksWithoutAttempts);
      expect(report.ledger.filter((row) => row.current !== null).map((row) => row.taskId)).toEqual(
        report.tasks.map((row) => row.taskId)
      );
      expect(report.tasks[0]?.taskId).toBe(task.id);
      expect(report.ledger.find((row) => row.taskId === taskWithoutAttempt.id)).toMatchObject({
        state: 'QUEUED',
        reason: 'task_without_attempt',
        bucket: 'active',
        attemptCount: 0,
        current: null,
        history: [],
        terminalAt: null,
        verifiedAt: null,
      });
    });
  });
});
