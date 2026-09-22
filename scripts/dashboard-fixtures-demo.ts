import 'dotenv/config';
import { closeDb, runMigrations } from '../src/db/client.js';
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
import { config } from '../src/config.js';

// Seeds one task per dashboard state/reason into DATABASE_PATH so /dashboard can be
// exercised without Devin or GitHub credentials. Run against a throwaway database and
// start the server with all pollers disabled, e.g.
//   DATABASE_PATH=./data/dashboard-fixtures.db pnpm demo:dashboard-fixtures
//   DATABASE_PATH=./data/dashboard-fixtures.db GITHUB_POLL_INTERVAL_MS=0 \
//     DEVIN_DISPATCH_INTERVAL_MS=0 DEVIN_TRACKING_INTERVAL_MS=0 DEVIN_RECONCILE_INTERVAL_MS=0 pnpm dev

const REPO = { repoOwner: 'dashboard-fixtures', repoName: 'demo' };
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const SPEC = { shell: 'sh' as const, script: 'printf "dashboard fixture\\n"' };

function seedTask(issueNumber: number, title: string): number {
  const task = upsertTask({ ...REPO, issueNumber, title });
  return createAttempt(task.id).id;
}

function withSession(attemptId: number): number {
  markDispatching(attemptId);
  markSessionCreated(attemptId, {
    devinSessionId: `fixture-${String(attemptId)}`,
    devinSessionUrl: `https://app.devin.ai/sessions/fixture-${String(attemptId)}`,
  });
  return attemptId;
}

function withPullRequest(attemptId: number, headSha: string): number {
  markRunning(attemptId);
  recordPullRequest(attemptId, {
    prUrl: `https://github.com/${REPO.repoOwner}/${REPO.repoName}/pull/${String(attemptId)}`,
    prNumber: attemptId,
    prState: 'open',
    prHeadSha: headSha,
  });
  markVerifying(attemptId);
  return attemptId;
}

function withApprovedSpec(attemptId: number): string {
  const candidate = setVerificationCandidate(attemptId, SPEC, 'operator');
  const sha = candidate.verificationCandidateSha256;
  if (sha === null) throw new Error('candidate sha missing');
  approveVerificationSpec(attemptId, sha, 'operator');
  return sha;
}

function withCommandRun(attemptId: number, sha: string, status: 'passed' | 'failed'): void {
  recordVerification({
    attemptId,
    headSha: HEAD_A,
    kind: 'command',
    status,
    reason: status === 'failed' ? 'exit_code_1' : null,
    specShell: SPEC.shell,
    specScript: SPEC.script,
    specSha256: sha,
    exitCode: status === 'failed' ? 1 : 0,
    finishedAt: Date.now(),
  });
}

function verifiedAndCompleted(attemptId: number): void {
  const sha = withApprovedSpec(attemptId);
  withCommandRun(attemptId, sha, 'passed');
  completeVerifiedAttempt(attemptId, { headSha: HEAD_A, specSha256: sha });
}

function main(): void {
  runMigrations();
  const seeded: { issue: number; attempt: number; expect: string }[] = [];
  const add = (issue: number, attempt: number, expect: string) =>
    seeded.push({ issue, attempt, expect });

  add(
    101,
    seedTask(101, 'Queued <script>alert(1)</script> & "quoted"'),
    'QUEUED / attempt_pending'
  );

  let id = seedTask(102, 'Dispatch in progress');
  markDispatching(id);
  add(102, id, 'DISPATCHING / attempt_dispatching');

  add(103, withSession(seedTask(103, 'Session starting')), 'RUNNING / attempt_session_created');

  id = withSession(seedTask(104, 'Devin working'));
  markRunning(id);
  add(104, id, 'RUNNING / attempt_running');

  id = withPullRequest(withSession(seedTask(105, 'Review verification candidate')), HEAD_A);
  setVerificationCandidate(id, SPEC, 'operator');
  add(105, id, 'VERIFYING / spec_pending_approval (Action needed)');

  id = withPullRequest(withSession(seedTask(106, 'Approved verification waiting')), HEAD_A);
  withApprovedSpec(id);
  add(106, id, 'VERIFYING / approved_spec_awaiting_run (Wait)');

  id = withPullRequest(withSession(seedTask(107, 'PR without verification spec')), HEAD_A);
  add(107, id, 'PR_OPEN / no_verification_spec (Action needed)');

  id = withPullRequest(withSession(seedTask(108, 'Verification failed')), HEAD_A);
  withCommandRun(id, withApprovedSpec(id), 'failed');
  add(108, id, 'VERIFICATION_FAILED / command_verification_failed');

  id = withPullRequest(withSession(seedTask(109, 'Verified and completed')), HEAD_A);
  verifiedAndCompleted(id);
  add(109, id, 'VERIFIED / command_verification_passed');

  id = withPullRequest(withSession(seedTask(110, 'Completed: superseded head')), HEAD_A);
  verifiedAndCompleted(id);
  recordPullRequest(id, {
    prUrl: `https://github.com/${REPO.repoOwner}/${REPO.repoName}/pull/${String(id)}`,
    prNumber: id,
    prState: 'open',
    prHeadSha: HEAD_B,
  });
  add(110, id, 'PR_OPEN / verified_head_superseded (Needs human)');

  id = withSession(seedTask(111, 'Failed attempt'));
  completeAttempt(id, 'failed', { reason: 'structured_output_missing' });
  add(111, id, 'FAILED / outcome_failed');

  id = withSession(seedTask(112, 'No change needed'));
  completeAttempt(id, 'no_action', { reason: 'already_fixed' });
  add(112, id, 'NO_ACTION / outcome_no_action');

  id = withSession(seedTask(113, 'Human handoff'));
  completeAttempt(id, 'escalated', { reason: 'devin_requested_human' });
  add(113, id, 'NEEDS_HUMAN / outcome_escalated');

  id = seedTask(114, 'Cancelled before dispatch');
  completeAttempt(id, 'cancelled', { reason: 'issue_closed' });
  add(114, id, 'CANCELLED / outcome_cancelled');

  closeDb();
  console.log(`Seeded ${String(seeded.length)} fixture tasks into ${config.databasePath}`);
  for (const row of seeded) {
    console.log(`  issue #${String(row.issue)}  attempt ${String(row.attempt)}  → ${row.expect}`);
  }
}

main();
