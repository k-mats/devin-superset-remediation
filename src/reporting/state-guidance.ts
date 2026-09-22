import type { NormalizedTaskState } from '../tracking/normalized-task-state.js';

export type NextAction = 'wait' | 'operator' | 'human' | 'done';

export interface StateGuidance {
  /** Who moves the task forward from here. */
  next: NextAction;
  /** What the state means and what to expect or do. */
  text: string;
}

export const NEXT_ACTION_LABEL: Record<NextAction, string> = {
  wait: 'Wait — automation is progressing',
  operator: 'Action needed — operator step required',
  human: 'Needs human — automation stopped',
  done: 'Terminal — nothing further happens',
};

const BY_REASON = {
  attempt_pending: {
    next: 'wait',
    text: 'Queued. The dispatch poller (DEVIN_DISPATCH_INTERVAL_MS) will re-check the issue and create a Devin session on its next pass.',
  },
  attempt_dispatching: {
    next: 'wait',
    text: 'A Devin session is being created. Normally this lasts seconds. If it stays here longer than DEVIN_DISPATCH_GRACE_MS with no session link, reconciliation is looking the session up; if the logs keep reporting no_match, run attempt:requeue (see docs/operations.md).',
  },
  attempt_session_created: {
    next: 'wait',
    text: 'Devin session created and starting. The tracking poller will mark it running once Devin reports progress.',
  },
  attempt_running: {
    next: 'wait',
    text: 'Devin is working. The PR column fills in only after the session finishes and reports its structured output; an open PR alone does not advance the state. If Devin is waiting for user input, answer in the Devin session.',
  },
  no_verification_spec: {
    next: 'operator',
    text: 'The PR was verified to exist but no verification command is known. Propose one on the Verification page (or add a "## Verification" block to the issue) and approve it.',
  },
  pr_head_unknown: {
    next: 'wait',
    text: 'PR recorded but its head commit is not known yet; the next tracking pass refreshes it.',
  },
  verified_head_superseded: {
    next: 'wait',
    text: 'A previously verified PR head was replaced by new commits. Verification reruns automatically for the new head on the next tracking pass.',
  },
  github_checks_pending: {
    next: 'wait',
    text: 'GitHub check runs on the PR head are still running. Nothing to do until they finish.',
  },
  spec_pending_approval: {
    next: 'operator',
    text: 'A verification command candidate exists but has not been approved. Review it on the Verification page and click Approve; verification then runs automatically.',
  },
  approved_spec_awaiting_run: {
    next: 'wait',
    text: 'Verification spec approved. The next tracking pass checks out the PR head, runs repository setup (minutes on first run) and executes the command. Use the Verification page to rerun explicitly.',
  },
  command_verification_error: {
    next: 'operator',
    text: 'The verification command could not be run (setup or infrastructure error, not a test failure). Inspect the evidence on the Verification page and rerun.',
  },
  current_head_verification_pending: {
    next: 'wait',
    text: 'Verification for the current PR head has been recorded as unverified; the next tracking pass re-evaluates it.',
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
} satisfies Record<string, StateGuidance>;

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

export function stateGuidance(state: NormalizedTaskState, reason: string): StateGuidance {
  return isKnownReason(reason) ? BY_REASON[reason] : BY_STATE[state];
}
