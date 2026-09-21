import type { Config } from '../config.js';
import { derivePrState, type GitHubClient } from '../github/client.js';
import type { Attempt, Task } from '../db/schema.js';
import { getAttempt, getTaskById, recordPullRequest, type Db } from '../db/task-state.js';
import { approvedSpec, approvalStatus } from './approval.js';
import {
  verifyRemediationOnce,
  type RemediationVerificationDecision,
  type VerifyRemediationOptions,
} from './verify-remediation.js';

export async function refreshTrackedPullRequest(
  attempt: Attempt,
  task: Task,
  github: Pick<GitHubClient, 'getPullRequest'>,
  db: Db
): Promise<Attempt> {
  if (attempt.prNumber === null) return attempt;
  const pr = await github.getPullRequest(task.repoOwner, task.repoName, attempt.prNumber);
  return recordPullRequest(
    attempt.id,
    {
      prUrl: pr.html_url,
      prNumber: pr.number,
      prState: derivePrState(pr),
      prHeadSha: pr.head.sha,
    },
    db
  );
}

export interface RerunVerificationOptions extends Omit<VerifyRemediationOptions, 'rerun' | 'db'> {
  db: Db;
  verify?: typeof verifyRemediationOnce;
}

export type RerunVerificationResult =
  | { ok: true; attempt: Attempt; decision: RemediationVerificationDecision }
  | {
      ok: false;
      reason:
        | 'attempt_not_found'
        | 'task_not_found'
        | 'attempt_not_verifying'
        | 'no_approved_spec'
        | 'no_pull_request';
    };

export async function rerunApprovedVerification(
  attemptId: number,
  opts: RerunVerificationOptions
): Promise<RerunVerificationResult> {
  const attempt = getAttempt(attemptId, opts.db);
  if (!attempt) return { ok: false, reason: 'attempt_not_found' };
  const task = getTaskById(attempt.taskId, opts.db);
  if (!task) return { ok: false, reason: 'task_not_found' };
  if (attempt.state !== 'verifying') {
    return { ok: false, reason: 'attempt_not_verifying' };
  }
  if (attempt.prNumber === null) {
    return { ok: false, reason: 'no_pull_request' };
  }
  if (approvalStatus(attempt) !== 'approved') {
    return { ok: false, reason: 'no_approved_spec' };
  }

  const refreshed = await refreshTrackedPullRequest(attempt, task, opts.github, opts.db);
  if (!approvedSpec(refreshed)) {
    return { ok: false, reason: 'no_approved_spec' };
  }
  const verify = opts.verify ?? verifyRemediationOnce;
  const decision = await verify(refreshed, task, { ...opts, rerun: true });
  return {
    ok: true,
    attempt: getAttempt(attemptId, opts.db) ?? refreshed,
    decision,
  };
}

export function verificationOptionsFromConfig(
  config: Pick<
    Config,
    | 'verificationWorkspaceRoot'
    | 'verificationCommandTimeoutMs'
    | 'verificationSetupTimeoutMs'
    | 'verificationCheckoutTimeoutMs'
    | 'verificationMaxOutputBytes'
  >
): Pick<
  VerifyRemediationOptions,
  'workspaceRoot' | 'commandTimeoutMs' | 'setupTimeoutMs' | 'checkoutTimeoutMs' | 'maxOutputBytes'
> {
  return {
    workspaceRoot: config.verificationWorkspaceRoot,
    commandTimeoutMs: config.verificationCommandTimeoutMs,
    setupTimeoutMs: config.verificationSetupTimeoutMs,
    checkoutTimeoutMs: config.verificationCheckoutTimeoutMs,
    maxOutputBytes: config.verificationMaxOutputBytes,
  };
}
