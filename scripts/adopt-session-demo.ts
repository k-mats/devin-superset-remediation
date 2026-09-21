import 'dotenv/config';
import { parseArgs } from 'node:util';
import { runMigrations, closeDb, getDb } from '../src/db/client.js';
import { getAttempt, markDispatching, markSessionCreated } from '../src/db/task-state.js';

function main(): number {
  const { values } = parseArgs({
    options: {
      attempt: { type: 'string' },
      session: { type: 'string' },
    },
  });
  if (!values.attempt || !values.session) {
    console.error('Usage: pnpm demo:adopt-session --attempt <id> --session <devin_session_id>');
    return 1;
  }
  runMigrations();
  try {
    const db = getDb();
    const attemptId = Number(values.attempt);
    const attempt = getAttempt(attemptId, db);
    if (!attempt) {
      console.error(`Attempt ${values.attempt} not found`);
      return 1;
    }
    if (attempt.state !== 'pending') {
      console.error(`Attempt ${values.attempt} is in state '${attempt.state}', expected 'pending'`);
      return 1;
    }
    markDispatching(attemptId, db);
    const adopted = markSessionCreated(
      attemptId,
      {
        devinSessionId: values.session,
        devinSessionUrl: `https://app.devin.ai/sessions/${values.session}`,
      },
      db
    );
    console.log('Adopted session for attempt:');
    console.table([adopted]);
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
