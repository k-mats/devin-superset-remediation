import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../src/config.js';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { createDevinClientFromConfig } from '../src/devin/client.js';
import { createGitHubClientFromConfig } from '../src/github/client.js';
import {
  getAttempt,
  findTrackableAttempts,
  findCompletedAttemptsWithTrackedPullRequests,
} from '../src/db/task-state.js';
import { runTrackingOnce, trackAttemptOnce } from '../src/tracking/session-tracker.js';

const logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'> = {
  info: (...args: unknown[]) => {
    console.log(...args);
  },
  warn: (...args: unknown[]) => {
    console.warn(...args);
  },
  error: (...args: unknown[]) => {
    console.error(...args);
  },
  debug: (...args: unknown[]) => {
    console.debug(...args);
  },
};

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { attempt: { type: 'string' } } });
  runMigrations();
  try {
    const db = getDb();
    const devin = createDevinClientFromConfig(config);
    const github = createGitHubClientFromConfig(config);
    const rows = [
      ...findTrackableAttempts(db),
      ...findCompletedAttemptsWithTrackedPullRequests(db),
    ];
    const touchedIds = new Set(rows.map(({ attempt }) => attempt.id));
    let result;
    if (values.attempt) {
      const attempt = getAttempt(Number(values.attempt), db);
      const row = [
        ...findTrackableAttempts(db),
        ...findCompletedAttemptsWithTrackedPullRequests(db),
      ].find(({ attempt: candidate }) => candidate.id === attempt?.id);
      if (!row) {
        console.error('Trackable attempt not found');
        return 1;
      }
      const decision = await trackAttemptOnce(row.attempt, row.task, {
        devin,
        github,
        logger,
        db,
        staleWarnMs: config.devinSessionStaleWarnMs,
        verification: config.verificationEnabled
          ? {
              workspaceRoot: config.verificationWorkspaceRoot,
              commandTimeoutMs: config.verificationCommandTimeoutMs,
              setupTimeoutMs: config.verificationSetupTimeoutMs,
              checkoutTimeoutMs: config.verificationCheckoutTimeoutMs,
              maxOutputBytes: config.verificationMaxOutputBytes,
            }
          : undefined,
      });
      result = { decision };
    } else {
      result = await runTrackingOnce({
        devin,
        github,
        logger,
        db,
        staleWarnMs: config.devinSessionStaleWarnMs,
        verifiedLabel: config.githubVerifiedLabel,
        verification: config.verificationEnabled
          ? {
              workspaceRoot: config.verificationWorkspaceRoot,
              commandTimeoutMs: config.verificationCommandTimeoutMs,
              setupTimeoutMs: config.verificationSetupTimeoutMs,
              checkoutTimeoutMs: config.verificationCheckoutTimeoutMs,
              maxOutputBytes: config.verificationMaxOutputBytes,
            }
          : undefined,
      });
    }
    console.log('Tracking result:');
    console.table(result);
    console.log('Touched attempts:');
    console.table([...touchedIds].map((id) => getAttempt(id, db)).filter(Boolean));
    return 0;
  } finally {
    closeDb();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
