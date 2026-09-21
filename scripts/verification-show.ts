import 'dotenv/config';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { tasks } from '../src/db/schema.js';
import { getAttempt, listVerifications } from '../src/db/task-state.js';
import { approvalStatus } from '../src/verification/approval.js';
import { projectTaskState } from '../src/tracking/normalized-task-state.js';

function main(): number {
  const { values } = parseArgs({ options: { attempt: { type: 'string' } } });
  if (!values.attempt) {
    console.error('Usage: pnpm verification:show --attempt <id>');
    return 1;
  }
  runMigrations();
  try {
    const db = getDb();
    const attempt = getAttempt(Number(values.attempt), db);
    if (!attempt) {
      console.error(`Attempt ${values.attempt} not found`);
      return 1;
    }
    const task = db.select().from(tasks).where(eq(tasks.id, attempt.taskId)).get();
    if (!task) {
      console.error(`Task ${String(attempt.taskId)} not found`);
      return 1;
    }

    console.log('Task:');
    console.table([
      {
        identity: `${task.repoOwner}/${task.repoName}#${String(task.issueNumber)}`,
        title: task.title,
      },
    ]);
    console.log('Attempt:');
    console.table([
      {
        id: attempt.id,
        state: attempt.state,
        outcome: attempt.outcome,
        pr_url: attempt.prUrl,
        pr_head_sha: attempt.prHeadSha,
      },
    ]);
    const projection = projectTaskState(attempt, db);
    console.log('Normalized task state (derived, not persisted):');
    console.table([{ state: projection.state, reason: projection.reason }]);
    const formatCheck = (value: { status: string; reason: string | null } | null): string | null =>
      value === null ? null : `${value.status}/${value.reason ?? '-'}`;
    console.log('Raw provider facts:');
    console.table([
      {
        attempt_state: projection.raw.attemptState,
        outcome: projection.raw.outcome,
        outcome_reason: projection.raw.outcomeReason,
        devin_session_status: projection.raw.devinSessionStatus,
        devin_session_status_detail: projection.raw.devinSessionStatusDetail,
        pr_state: projection.raw.prState,
        pr_head_sha: projection.raw.prHeadSha,
        github_checks: formatCheck(projection.raw.githubChecks),
        command:
          projection.raw.command === null
            ? null
            : `${formatCheck(projection.raw.command) ?? '-'} spec=${projection.raw.command.specSha256 ?? '-'}`,
      },
    ]);
    console.log('Candidate:');
    console.table([
      {
        source: attempt.verificationCandidateSource,
        shell: attempt.verificationCandidateShell,
        sha256: attempt.verificationCandidateSha256,
        updated_at: attempt.verificationCandidateUpdatedAt,
        script: attempt.verificationCandidateScript,
      },
    ]);
    console.log('Approved:');
    console.table([
      {
        sha256: attempt.verificationApprovedSha256,
        approved_at: attempt.verificationApprovedAt,
        approved_by: attempt.verificationApprovedBy,
        shell: attempt.verificationApprovedShell,
        script: attempt.verificationApprovedScript,
      },
    ]);
    console.log(`Approval status: ${approvalStatus(attempt)}`);
    console.log('Agent-reported tests_run (not independent verification):');
    console.table(attempt.agentTestsRun ?? []);
    console.log('Verifications:');
    console.table(listVerifications(attempt.id, db));
    return 0;
  } finally {
    closeDb();
  }
}

try {
  process.exitCode = main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
