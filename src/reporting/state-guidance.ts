import type { NormalizedTaskState } from '../tracking/normalized-task-state.js';

export type NextAction = 'wait' | 'operator' | 'human' | 'done';

export interface StateGuidance {
  /** Who moves the task forward from here. */
  next: NextAction;
  /** What the state means and what to expect or do. */
  text: string;
}

export type Worker = 'intake' | 'dispatch' | 'tracking' | 'reconcile' | 'verification';

/** Which background workers are enabled in this process (poller interval > 0, VERIFICATION_ENABLED). */
export type WorkerAvailability = Record<Worker, boolean>;

export const ALL_WORKERS_ENABLED: WorkerAvailability = {
  intake: true,
  dispatch: true,
  tracking: true,
  reconcile: true,
  verification: true,
};

const WORKER_SETTING: Record<Worker, string> = {
  intake: 'intake poller: GITHUB_POLL_INTERVAL_MS + GitHub credentials/repo',
  dispatch: 'dispatch poller: DEVIN_DISPATCH_INTERVAL_MS + GitHub/Devin credentials',
  tracking: 'tracking poller: DEVIN_TRACKING_INTERVAL_MS + GitHub/Devin credentials',
  reconcile: 'reconciliation poller: DEVIN_RECONCILE_INTERVAL_MS + Devin credentials',
  verification: 'verification: VERIFICATION_ENABLED (runs inside the tracking poller)',
};

export const NEXT_ACTION_LABEL: Record<NextAction, string> = {
  wait: 'Wait — automation is progressing',
  operator: 'Action needed — operator step required',
  human: 'Needs human — automation stopped',
  done: 'Terminal — nothing further happens',
};

const BY_REASON = {
  attempt_pending: {
    next: 'wait',
    requires: ['dispatch'],
    text: 'Queued. The dispatch poller (DEVIN_DISPATCH_INTERVAL_MS) will re-check the issue and create a Devin session on its next pass.',
  },
  task_without_attempt: {
    next: 'wait',
    requires: ['intake'],
    text: 'The task row exists but has no attempt yet, so dispatch cannot pick it up. The intake poller creates the missing attempt on its next pass if the issue is still open and carries the trigger label (a webhook delivery does the same); if the issue was closed or unlabelled since, nothing will pick this row up until an operator restores eligibility by reopening the issue and/or re-adding the trigger label.',
  },
  attempt_dispatching: {
    next: 'wait',
    requires: ['reconcile'],
    text: 'A Devin session is being created. Normally this lasts seconds. If it stays here longer than DEVIN_DISPATCH_GRACE_MS with no session link, reconciliation is looking the session up; if the logs keep reporting no_match, run attempt:requeue (see docs/operations.md).',
  },
  attempt_session_created: {
    next: 'wait',
    requires: ['tracking'],
    text: 'Devin session created and starting. The tracking poller will mark it running once Devin reports progress.',
  },
  attempt_running: {
    next: 'wait',
    requires: ['tracking'],
    text: 'Devin is working. The PR column fills in only after the session finishes and reports its structured output; an open PR alone does not advance the state. If Devin is waiting for user input, answer in the Devin session.',
  },
  no_verification_spec: {
    next: 'operator',
    text: 'The PR was verified to exist but no verification command is known. Propose one on the Verification page (or add a "## Verification" block to the issue) and approve it.',
  },
  pr_head_unknown: {
    next: 'wait',
    requires: ['tracking'],
    text: 'PR recorded but its head commit is not known yet; the next tracking pass refreshes it.',
  },
  verified_head_superseded: {
    next: 'human',
    text: 'New commits replaced the PR head that passed verification. The attempt is already completed, so the tracker only refreshes the PR; neither automatic nor explicit re-verification is available for completed attempts. The earlier VERIFIED result does not cover the new head: review it manually before merging.',
  },
  github_checks_pending: {
    next: 'wait',
    requires: ['tracking', 'verification'],
    text: 'GitHub check runs on the PR head are still running. Nothing to do until they finish.',
  },
  spec_pending_approval: {
    next: 'operator',
    text: 'A verification command candidate exists but has not been approved. Review it on the Verification page and click Approve; verification then runs automatically.',
  },
  approved_spec_awaiting_run: {
    next: 'wait',
    requires: ['tracking', 'verification'],
    text: 'Verification spec approved. The next tracking pass checks out the PR head, runs repository setup (minutes on first run) and executes the command. Use the Verification page to rerun explicitly.',
  },
  command_verification_error: {
    next: 'operator',
    text: 'The verification command could not be run (setup or infrastructure error, not a test failure). Inspect the evidence on the Verification page and rerun.',
  },
  current_head_verification_pending: {
    next: 'human',
    text: 'The latest verification run for the current PR head ended as unverified on a completed attempt. Completed attempts are not re-verified automatically or via the Verification page; review the head manually.',
  },
  command_verification_failed: {
    next: 'human',
    text: 'The approved verification command failed against the PR head. Review the PR and evidence; pushing new commits triggers re-verification.',
  },
  command_verification_passed: {
    next: 'done',
    text: 'Independent verification passed for the current PR head. Review and merge the PR.',
  },
  pr_closed_without_merge: {
    next: 'human',
    text: 'The PR was closed without merging. Decide whether to requeue the issue or drop it.',
  },
  pr_merged_before_verification: {
    next: 'human',
    text: 'The PR was merged before independent verification passed. Verify manually.',
  },
  outcome_escalated: {
    next: 'human',
    text: 'Automation stopped and handed off to a human (see outcome reason). Inspect the Devin session and decide the next step.',
  },
  outcome_no_action: {
    next: 'done',
    text: 'Devin concluded no change was needed.',
  },
  outcome_failed: {
    next: 'done',
    text: 'The attempt failed (see outcome reason). Intake does not retry tasks with attempt history; a new attempt requires an operator (see docs/operations.md).',
  },
  outcome_cancelled: {
    next: 'done',
    text: 'Cancelled because the issue was closed or lost its trigger label before dispatch.',
  },
} satisfies Record<string, StateGuidance & { requires?: Worker[] }>;

type KnownReason = keyof typeof BY_REASON;

function isKnownReason(reason: string): reason is KnownReason {
  return Object.hasOwn(BY_REASON, reason);
}

const BY_STATE: Record<NormalizedTaskState, StateGuidance> = {
  QUEUED: BY_REASON.attempt_pending,
  DISPATCHING: BY_REASON.attempt_dispatching,
  RUNNING: BY_REASON.attempt_running,
  PR_OPEN: BY_REASON.no_verification_spec,
  CI_PENDING: BY_REASON.github_checks_pending,
  VERIFYING: BY_REASON.approved_spec_awaiting_run,
  VERIFICATION_FAILED: BY_REASON.command_verification_failed,
  VERIFIED: BY_REASON.command_verification_passed,
  NEEDS_HUMAN: BY_REASON.outcome_escalated,
  NO_ACTION: BY_REASON.outcome_no_action,
  FAILED: BY_REASON.outcome_failed,
  CANCELLED: BY_REASON.outcome_cancelled,
};

export function stateGuidance(
  state: NormalizedTaskState,
  reason: string,
  workers: WorkerAvailability = ALL_WORKERS_ENABLED
): StateGuidance {
  const base: StateGuidance & { requires?: Worker[] } = isKnownReason(reason)
    ? BY_REASON[reason]
    : BY_STATE[state];
  if (base.next !== 'wait') return { next: base.next, text: base.text };
  const disabled = (base.requires ?? []).filter((worker) => !workers[worker]);
  if (disabled.length === 0) return { next: base.next, text: base.text };
  const settings = disabled.map((worker) => WORKER_SETTING[worker]).join('; ');
  return {
    next: 'operator',
    text: `The automation this state depends on is not running in this process (${settings}), so it will not progress on its own. Check the startup log for the skipped/disabled worker, fix the configuration and restart, or handle the step manually. Normally: ${base.text}`,
  };
}
