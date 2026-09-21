import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import type { Attempt, Verification } from '../src/db/schema.js';
import {
  approveVerificationSpec,
  createAttempt,
  getAttempt,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  recordVerification,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import {
  deriveTaskState,
  loadTaskStateEvidence,
  projectTaskState,
  type NormalizedTaskState,
} from '../src/tracking/normalized-task-state.js';
import { hashVerificationSpec } from '../src/verification/spec.js';

function makeAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 1,
    taskId: 1,
    attemptNumber: 1,
    correlationId: 'corr-1',
    state: 'pending',
    outcome: null,
    outcomeReason: null,
    devinSessionId: null,
    devinSessionUrl: null,
    devinSessionStatus: null,
    devinSessionStatusDetail: null,
    acusConsumed: null,
    sessionUpdatedAt: null,
    sessionLastPolledAt: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prHeadSha: null,
    prLastCheckedAt: null,
    createdAt: 0,
    updatedAt: 0,
    dispatchedAt: null,
    sessionCreatedAt: null,
    completedAt: null,
    structuredOutputRaw: null,
    agentOutcome: null,
    agentPrUrl: null,
    agentDiagnosis: null,
    agentTestsRun: null,
    agentRisks: null,
    needsHumanReason: null,
    structuredOutputAcceptedAt: null,
    verificationCandidateShell: null,
    verificationCandidateScript: null,
    verificationCandidateSha256: null,
    verificationCandidateSource: null,
    verificationCandidateUpdatedAt: null,
    verificationApprovedShell: null,
    verificationApprovedScript: null,
    verificationApprovedSha256: null,
    verificationApprovedAt: null,
    verificationApprovedBy: null,
    ...overrides,
  };
}

function makeVerification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: 1,
    attemptId: 1,
    headSha: 'head-1',
    kind: 'command',
    status: 'unverified',
    reason: null,
    specShell: null,
    specScript: null,
    specSha256: null,
    exitCode: null,
    evidenceUrl: null,
    evidenceSummary: null,
    startedAt: null,
    finishedAt: null,
    createdAt: 0,
    ...overrides,
  };
}

const noEvidence = { latestCommand: undefined, latestGitHubChecks: undefined };

function verifyingAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return makeAttempt({
    state: 'verifying',
    devinSessionId: 'sess-1',
    prUrl: 'https://github.com/owner/repo/pull/12',
    prNumber: 12,
    prState: 'open',
    prHeadSha: 'head-1',
    ...overrides,
  });
}

function approvedSpec(sha: string): Partial<Attempt> {
  return {
    verificationCandidateShell: 'bash',
    verificationCandidateScript: 'echo ok',
    verificationCandidateSha256: sha,
    verificationCandidateSource: 'operator',
    verificationCandidateUpdatedAt: 1,
    verificationApprovedShell: 'bash',
    verificationApprovedScript: 'echo ok',
    verificationApprovedSha256: sha,
    verificationApprovedAt: 1,
    verificationApprovedBy: 'operator',
  };
}

describe('deriveTaskState', () => {
  const cases: Array<{
    name: string;
    attempt: Attempt;
    evidence?: { latestCommand?: Verification; latestGitHubChecks?: Verification };
    state: NormalizedTaskState;
    reason: string;
  }> = [
    {
      name: 'pending attempt is queued',
      attempt: makeAttempt(),
      state: 'QUEUED',
      reason: 'attempt_pending',
    },
    {
      name: 'dispatching attempt is dispatching',
      attempt: makeAttempt({ state: 'dispatching' }),
      state: 'DISPATCHING',
      reason: 'attempt_dispatching',
    },
    {
      name: 'session_created attempt is running',
      attempt: makeAttempt({ state: 'session_created', devinSessionId: 's' }),
      state: 'RUNNING',
      reason: 'attempt_session_created',
    },
    {
      name: 'running attempt is running',
      attempt: makeAttempt({ state: 'running', devinSessionId: 's' }),
      state: 'RUNNING',
      reason: 'attempt_running',
    },
    {
      name: 'verifying with open PR and no evidence or candidate is PR_OPEN',
      attempt: verifyingAttempt(),
      state: 'PR_OPEN',
      reason: 'no_verification_spec',
    },
    {
      name: 'verifying with pending checks is CI_PENDING',
      attempt: verifyingAttempt(),
      evidence: {
        latestGitHubChecks: makeVerification({
          kind: 'github_checks',
          status: 'unverified',
          reason: 'checks_pending',
        }),
      },
      state: 'CI_PENDING',
      reason: 'github_checks_pending',
    },
    {
      name: 'verifying with no_checks and no candidate stays PR_OPEN',
      attempt: verifyingAttempt(),
      evidence: {
        latestGitHubChecks: makeVerification({
          kind: 'github_checks',
          status: 'unverified',
          reason: 'no_checks',
        }),
      },
      state: 'PR_OPEN',
      reason: 'no_verification_spec',
    },
    {
      name: 'verifying with no_checks and an approved spec is VERIFYING',
      attempt: verifyingAttempt(approvedSpec('sha-x')),
      evidence: {
        latestGitHubChecks: makeVerification({
          kind: 'github_checks',
          status: 'unverified',
          reason: 'no_checks',
        }),
      },
      state: 'VERIFYING',
      reason: 'approved_spec_awaiting_run',
    },
    {
      name: 'passed github_checks alone is not VERIFIED',
      attempt: verifyingAttempt(approvedSpec('sha-x')),
      evidence: {
        latestGitHubChecks: makeVerification({ kind: 'github_checks', status: 'passed' }),
      },
      state: 'VERIFYING',
      reason: 'approved_spec_awaiting_run',
    },
    {
      name: 'failed command matching the approved spec is VERIFICATION_FAILED',
      attempt: verifyingAttempt(approvedSpec('sha-x')),
      evidence: {
        latestCommand: makeVerification({
          kind: 'command',
          status: 'failed',
          specSha256: 'sha-x',
        }),
      },
      state: 'VERIFICATION_FAILED',
      reason: 'command_verification_failed',
    },
    {
      name: 'failed command from a superseded spec is not VERIFICATION_FAILED',
      attempt: verifyingAttempt(approvedSpec('sha-y')),
      evidence: {
        latestCommand: makeVerification({
          kind: 'command',
          status: 'failed',
          specSha256: 'sha-x',
        }),
      },
      state: 'VERIFYING',
      reason: 'approved_spec_awaiting_run',
    },
    {
      name: 'command error is VERIFYING',
      attempt: verifyingAttempt(approvedSpec('sha-x')),
      evidence: {
        latestCommand: makeVerification({
          kind: 'command',
          status: 'error',
          reason: 'timeout',
          specSha256: 'sha-x',
        }),
      },
      state: 'VERIFYING',
      reason: 'command_verification_error',
    },
    {
      name: 'candidate pending approval is VERIFYING',
      attempt: verifyingAttempt({
        verificationCandidateShell: 'bash',
        verificationCandidateScript: 'echo ok',
        verificationCandidateSha256: 'sha-x',
        verificationCandidateSource: 'operator',
        verificationCandidateUpdatedAt: 1,
      }),
      state: 'VERIFYING',
      reason: 'spec_pending_approval',
    },
    {
      name: 'closed PR while verifying is NEEDS_HUMAN even with a failed command',
      attempt: verifyingAttempt({ ...approvedSpec('sha-x'), prState: 'closed' }),
      evidence: {
        latestCommand: makeVerification({
          kind: 'command',
          status: 'failed',
          specSha256: 'sha-x',
        }),
      },
      state: 'NEEDS_HUMAN',
      reason: 'pr_closed_without_merge',
    },
    {
      name: 'completed succeeded is VERIFIED',
      attempt: makeAttempt({
        state: 'completed',
        outcome: 'succeeded',
        outcomeReason: 'independent_verification_passed: head-1',
        devinSessionId: 's',
      }),
      state: 'VERIFIED',
      reason: 'outcome_succeeded',
    },
    {
      name: 'completed escalated is NEEDS_HUMAN',
      attempt: makeAttempt({
        state: 'completed',
        outcome: 'escalated',
        outcomeReason: 'needs_human: x',
      }),
      state: 'NEEDS_HUMAN',
      reason: 'outcome_escalated',
    },
    {
      name: 'completed no_action is NO_ACTION',
      attempt: makeAttempt({ state: 'completed', outcome: 'no_action' }),
      state: 'NO_ACTION',
      reason: 'outcome_no_action',
    },
    {
      name: 'completed failed is FAILED',
      attempt: makeAttempt({ state: 'completed', outcome: 'failed' }),
      state: 'FAILED',
      reason: 'outcome_failed',
    },
    {
      name: 'completed cancelled is CANCELLED',
      attempt: makeAttempt({ state: 'completed', outcome: 'cancelled' }),
      state: 'CANCELLED',
      reason: 'outcome_cancelled',
    },
    {
      name: 'stale evidence for an old head is ignored',
      attempt: verifyingAttempt({ prHeadSha: 'new' }),
      evidence: {
        latestCommand: makeVerification({
          headSha: 'old',
          kind: 'command',
          status: 'failed',
          specSha256: 'sha-x',
        }),
        latestGitHubChecks: makeVerification({
          headSha: 'old',
          kind: 'github_checks',
          status: 'unverified',
          reason: 'checks_pending',
        }),
      },
      state: 'PR_OPEN',
      reason: 'no_verification_spec',
    },
    {
      name: 'suspended devin session stays raw while state is PR_OPEN',
      attempt: verifyingAttempt({ devinSessionStatus: 'suspended' }),
      evidence: {
        latestGitHubChecks: makeVerification({
          kind: 'github_checks',
          status: 'unverified',
          reason: 'no_checks',
        }),
      },
      state: 'PR_OPEN',
      reason: 'no_verification_spec',
    },
    {
      name: 'verifying without a known PR head is PR_OPEN',
      attempt: verifyingAttempt({ prHeadSha: null }),
      state: 'PR_OPEN',
      reason: 'pr_head_unknown',
    },
  ];

  it.each(cases)('$name -> $state / $reason', ({ attempt, evidence, state, reason }) => {
    const projection = deriveTaskState(attempt, {
      latestCommand: evidence?.latestCommand,
      latestGitHubChecks: evidence?.latestGitHubChecks,
    });
    expect(projection.state).toBe(state);
    expect(projection.reason).toBe(reason);
  });

  it('keeps raw evidence visible and separated from the normalized state', () => {
    const attempt = verifyingAttempt({ devinSessionStatus: 'suspended' });
    const projection = deriveTaskState(attempt, {
      latestCommand: undefined,
      latestGitHubChecks: makeVerification({
        kind: 'github_checks',
        status: 'unverified',
        reason: 'no_checks',
      }),
    });
    expect(projection.state).toBe('PR_OPEN');
    expect(projection.raw.devinSessionStatus).toBe('suspended');
    expect(projection.raw.githubChecks).toEqual({ status: 'unverified', reason: 'no_checks' });
    expect(projection.raw.command).toBeNull();
  });

  it('nulls raw evidence rows from a stale head', () => {
    const attempt = verifyingAttempt({ prHeadSha: 'new' });
    const projection = deriveTaskState(attempt, {
      latestCommand: makeVerification({ headSha: 'old', kind: 'command', status: 'failed' }),
      latestGitHubChecks: makeVerification({
        headSha: 'old',
        kind: 'github_checks',
        status: 'unverified',
        reason: 'checks_pending',
      }),
    });
    expect(projection.state).toBe('PR_OPEN');
    expect(projection.raw.command).toBeNull();
    expect(projection.raw.githubChecks).toBeNull();
  });

  it('preserves the outcome reason in raw', () => {
    const projection = deriveTaskState(
      makeAttempt({ state: 'completed', outcome: 'escalated', outcomeReason: 'needs_human: x' }),
      noEvidence
    );
    expect(projection.raw.outcomeReason).toBe('needs_human: x');
  });
});

describe('projectTaskState (db-backed)', () => {
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

  it('ignores verification rows recorded for a superseded PR head', () => {
    const db = getDb();
    const task = upsertTask({ repoOwner: 'o', repoName: 'r', issueNumber: 14 });
    const attempt = createAttempt(task.id, db);
    markDispatching(attempt.id, db);
    markSessionCreated(attempt.id, { devinSessionId: `sess-${String(attempt.id)}` }, db);
    markRunning(attempt.id, db);
    recordPullRequest(
      attempt.id,
      {
        prUrl: 'https://github.com/o/r/pull/3',
        prNumber: 3,
        prState: 'open',
        prHeadSha: 'old',
      },
      db
    );
    markVerifying(attempt.id, db);

    const script = 'echo ok';
    const sha = hashVerificationSpec('bash', script);
    setVerificationCandidate(attempt.id, { shell: 'bash', script }, 'operator', db);
    approveVerificationSpec(attempt.id, sha, 'operator', db);
    recordVerification(
      {
        attemptId: attempt.id,
        headSha: 'old',
        kind: 'command',
        status: 'failed',
        specSha256: sha,
      },
      db
    );

    // PR head moved; the recorded failure belongs to the stale head.
    const current = recordPullRequest(
      attempt.id,
      {
        prUrl: 'https://github.com/o/r/pull/3',
        prNumber: 3,
        prState: 'open',
        prHeadSha: 'new',
      },
      db
    );

    const evidence = loadTaskStateEvidence(current, db);
    expect(evidence.latestCommand).toBeUndefined();
    expect(evidence.latestGitHubChecks).toBeUndefined();

    let projection = projectTaskState(current, db);
    expect(projection.state).not.toBe('VERIFICATION_FAILED');
    expect(projection.state).toBe('VERIFYING');
    expect(projection.raw.command).toBeNull();

    recordVerification(
      {
        attemptId: attempt.id,
        headSha: 'new',
        kind: 'github_checks',
        status: 'unverified',
        reason: 'checks_pending',
      },
      db
    );
    const refreshed = getAttempt(attempt.id, db);
    if (refreshed === undefined) throw new Error('attempt missing');
    projection = projectTaskState(refreshed, db);
    expect(projection.state).toBe('CI_PENDING');
    expect(projection.reason).toBe('github_checks_pending');
  });
});
