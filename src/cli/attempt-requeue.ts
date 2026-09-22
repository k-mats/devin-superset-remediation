import 'dotenv/config';
import { parseArgs } from 'node:util';
import { closeDb, getDb, runMigrations } from '../db/client.js';
import {
  AttemptNotRequeueableError,
  getAttempt,
  requeueDispatchFailedAttempt,
} from '../db/task-state.js';

function main(): number {
  const { values } = parseArgs({
    options: {
      attempt: { type: 'string' },
    },
  });
  if (!values.attempt) {
    console.error('Usage: attempt-requeue --attempt <id>');
    return 1;
  }
  runMigrations();
  try {
    const db = getDb();
    const attemptId = Number(values.attempt);
    const before = getAttempt(attemptId, db);
    if (!before) {
      console.error(`Attempt ${values.attempt} not found`);
      return 1;
    }
    console.log(`Current state:        ${before.state}`);
    console.log(`Devin session id:     ${before.devinSessionId ?? '(none)'}`);
    try {
      const { failed, requeued } = requeueDispatchFailedAttempt(attemptId, db);
      console.log(`Attempt ${String(failed.id)} completed as ${failed.outcome ?? '(none)'}`);
      console.log(`  outcome reason:     ${failed.outcomeReason ?? '(none)'}`);
      console.log(`New pending attempt:  ${String(requeued.id)}`);
      console.log(`  attempt number:     ${String(requeued.attemptNumber)}`);
      console.log(`  correlation id:     ${requeued.correlationId}`);
    } catch (error: unknown) {
      if (error instanceof AttemptNotRequeueableError) {
        console.error(`Refusing to requeue: ${error.message}`);
        return 1;
      }
      throw error;
    }
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
