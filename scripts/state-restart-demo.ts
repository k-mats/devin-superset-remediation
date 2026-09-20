import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, runMigrations } from '../src/db/client.js';
import { config } from '../src/config.js';
import {
  completeAttempt,
  createAttempt,
  findStaleDispatchingAttempts,
  getTaskByIdentity,
  listAttempts,
  markDispatching,
  markRunning,
  markSessionCreated,
  setPrUrl,
  upsertTask,
} from '../src/db/task-state.js';

const thisFile = fileURLToPath(import.meta.url);

function write() {
  runMigrations();
  const task = upsertTask({
    repoOwner: 'k-mats',
    repoName: 'superset-fork',
    issueNumber: 101,
    title: 'Persistent task state demo',
  });
  const first = createAttempt(task.id);
  markDispatching(first.id);
  const sessionId = `demo-session-${first.correlationId}`;
  markSessionCreated(first.id, {
    devinSessionId: sessionId,
    devinSessionUrl: `https://app.devin.ai/sessions/${sessionId}?correlation_id=${first.correlationId}`,
  });
  markRunning(first.id);
  setPrUrl(first.id, 'https://github.com/k-mats/superset-fork/pull/101');
  completeAttempt(first.id, 'succeeded');
  const second = createAttempt(task.id);
  markDispatching(second.id);

  console.log(
    JSON.stringify(
      {
        pid: process.pid,
        database: resolve(config.databasePath),
        task,
        attempts: listAttempts(task.id),
      },
      null,
      2
    )
  );
  closeDb();
}

function read() {
  runMigrations();
  const task = getTaskByIdentity({
    repoOwner: 'k-mats',
    repoName: 'superset-fork',
    issueNumber: 101,
  });
  if (!task) {
    throw new Error('Demo task was not found');
  }
  const attempts = listAttempts(task.id);
  const stale = findStaleDispatchingAttempts();
  console.log(
    JSON.stringify(
      { pid: process.pid, database: resolve(config.databasePath), task, attempts, stale },
      null,
      2
    )
  );
  if (
    attempts[0]?.state !== 'completed' ||
    attempts[0].outcome !== 'succeeded' ||
    attempts[1]?.state !== 'dispatching' ||
    attempts[1].devinSessionId !== null ||
    stale.length !== 1 ||
    stale[0]?.id !== attempts[1].id
  ) {
    throw new Error('Recovered state did not match the expected demo state');
  }
  console.log('OK: state recovered across process restart');
  closeDb();
}

function main() {
  const command = process.argv[2];
  if (command === 'write') {
    write();
    return;
  }
  if (command === 'read') {
    read();
    return;
  }

  execFileSync('pnpm', ['exec', 'tsx', thisFile, 'write'], { stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'tsx', thisFile, 'read'], { stdio: 'inherit' });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
