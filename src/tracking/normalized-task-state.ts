import type { Attempt, Verification } from '../db/schema.js';
import { getDb } from '../db/client.js';
import type { DbExecutor } from '../db/task-state.js';
import { findLatestVerification } from '../db/task-state.js';
import { approvalStatus } from '../verification/approval.js';

export const NORMALIZED_TASK_STATES = [
  'QUEUED',
  'DISPATCHING',
  'RUNNING',
  'PR_OPEN',
  'CI_PENDING',
  'VERIFYING',
  'VERIFICATION_FAILED',
  'VERIFIED',
  'NEEDS_HUMAN',
  'NO_ACTION',
  'FAILED',
  'CANCELLED',
] as const;
export type NormalizedTaskState = (typeof NORMALIZED_TASK_STATES)[number];

export interface TaskStateEvidence {
  latestCommand: Verification | undefined;
  latestGitHubChecks: Verification | undefined;
}

export interface TaskStateProjection {
  state: NormalizedTaskState;
  reason: string;
  raw: {
    attemptState: Attempt['state'];
    outcome: Attempt['outcome'];
    outcomeReason: string | null;
    devinSessionStatus: string | null;
    devinSessionStatusDetail: string | null;
    prState: Attempt['prState'];
    prHeadSha: string | null;
    githubChecks: { status: Verification['status']; reason: string | null } | null;
    command: {
      status: Verification['status'];
      reason: string | null;
      specSha256: string | null;
    } | null;
  };
}

function projection(
  attempt: Attempt,
  state: NormalizedTaskState,
  reason: string,
  latestCommand: Verification | undefined,
  latestGitHubChecks: Verification | undefined
): TaskStateProjection {
  return {
    state,
    reason,
    raw: {
      attemptState: attempt.state,
      outcome: attempt.outcome,
      outcomeReason: attempt.outcomeReason,
      devinSessionStatus: attempt.devinSessionStatus,
      devinSessionStatusDetail: attempt.devinSessionStatusDetail,
      prState: attempt.prState,
      prHeadSha: attempt.prHeadSha,
      githubChecks: latestGitHubChecks
        ? { status: latestGitHubChecks.status, reason: latestGitHubChecks.reason }
        : null,
      command: latestCommand
        ? {
            status: latestCommand.status,
            reason: latestCommand.reason,
            specSha256: latestCommand.specSha256,
          }
        : null,
    },
  };
}

export function deriveTaskState(
  attempt: Attempt,
  evidence: TaskStateEvidence
): TaskStateProjection {
  // Defensive staleness filter: evidence must match the current PR head.
  const latestCommand =
    evidence.latestCommand !== undefined && evidence.latestCommand.headSha === attempt.prHeadSha
      ? evidence.latestCommand
      : undefined;
  const latestGitHubChecks =
    evidence.latestGitHubChecks !== undefined &&
    evidence.latestGitHubChecks.headSha === attempt.prHeadSha
      ? evidence.latestGitHubChecks
      : undefined;

  const done = (state: NormalizedTaskState, reason: string) =>
    projection(attempt, state, reason, latestCommand, latestGitHubChecks);

  const succeeded = attempt.outcome === 'succeeded';

  if (attempt.state === 'completed' && !succeeded) {
    switch (attempt.outcome) {
      case 'no_action':
        return done('NO_ACTION', 'outcome_no_action');
      case 'cancelled':
        return done('CANCELLED', 'outcome_cancelled');
      case 'escalated':
        return done('NEEDS_HUMAN', 'outcome_escalated');
      case 'failed':
        return done('FAILED', 'outcome_failed');
      case 'succeeded':
        throw new Error('unreachable: succeeded outcome is handled below');
      case null:
        throw new Error(`Attempt ${String(attempt.id)} is completed without an outcome`);
    }
  }

  if (attempt.state !== 'verifying' && attempt.state !== 'completed') {
    switch (attempt.state) {
      case 'pending':
        return done('QUEUED', 'attempt_pending');
      case 'dispatching':
        return done('DISPATCHING', 'attempt_dispatching');
      case 'session_created':
        return done('RUNNING', 'attempt_session_created');
      case 'running':
        return done('RUNNING', 'attempt_running');
    }
  }

  // state === 'verifying' OR completed with outcome succeeded:
  // VERIFIED is a property of the current tracked PR head, not the historical outcome.
  const approved = approvalStatus(attempt) === 'approved';
  const decisive = (row: Verification): boolean =>
    approved && row.specSha256 !== null && row.specSha256 === attempt.verificationApprovedSha256;

  if (attempt.prState === 'closed') {
    return done('NEEDS_HUMAN', 'pr_closed_without_merge');
  }
  if (latestCommand?.status === 'passed' && decisive(latestCommand)) {
    return done('VERIFIED', 'command_verification_passed');
  }
  if (attempt.prState === 'merged') {
    return done('NEEDS_HUMAN', 'pr_merged_before_verification');
  }
  if (latestCommand?.status === 'failed' && decisive(latestCommand)) {
    return done('VERIFICATION_FAILED', 'command_verification_failed');
  }
  if (
    latestGitHubChecks?.status === 'unverified' &&
    latestGitHubChecks.reason === 'checks_pending'
  ) {
    return done('CI_PENDING', 'github_checks_pending');
  }
  if (latestCommand?.status === 'error') {
    return done('VERIFYING', 'command_verification_error');
  }
  if (attempt.state === 'verifying') {
    const approval = approvalStatus(attempt);
    if (approval === 'approved') {
      return done('VERIFYING', 'approved_spec_awaiting_run');
    }
    if (approval === 'pending_approval') {
      return done('VERIFYING', 'spec_pending_approval');
    }
  } else if (latestCommand?.status === 'unverified') {
    // completed + succeeded: the verifier no longer runs, so approval status
    // alone is not activity — only a recorded run for the current head counts.
    return done('VERIFYING', 'current_head_verification_pending');
  }
  if (succeeded) {
    return done('PR_OPEN', 'verified_head_superseded');
  }
  if (attempt.prHeadSha === null) {
    return done('PR_OPEN', 'pr_head_unknown');
  }
  return done('PR_OPEN', 'no_verification_spec');
}

export function loadTaskStateEvidence(
  attempt: Attempt,
  db: DbExecutor = getDb()
): TaskStateEvidence {
  if (attempt.prHeadSha === null) {
    return { latestCommand: undefined, latestGitHubChecks: undefined };
  }
  return {
    latestCommand: findLatestVerification(attempt.id, attempt.prHeadSha, 'command', db),
    latestGitHubChecks: findLatestVerification(attempt.id, attempt.prHeadSha, 'github_checks', db),
  };
}

export function projectTaskState(attempt: Attempt, db: DbExecutor = getDb()): TaskStateProjection {
  return deriveTaskState(attempt, loadTaskStateEvidence(attempt, db));
}
