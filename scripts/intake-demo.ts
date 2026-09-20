import 'dotenv/config';
import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.js';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks } from '../src/db/schema.js';
import { createGitHubClientFromConfig } from '../src/github/client.js';
import { runIntakeOnce } from '../src/intake/github-intake.js';

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
  runMigrations();
  try {
    const client = createGitHubClientFromConfig(config);
    const result = await runIntakeOnce({
      client,
      repoOwner: config.githubRepoOwner ?? '',
      repoName: config.githubRepoName ?? '',
      label: config.githubIntakeLabel,
      logger,
    });
    console.log('Intake result:');
    console.table(result);

    const db = getDb();
    const taskRows = db
      .select()
      .from(tasks)
      .where(eq(tasks.repoOwner, (config.githubRepoOwner ?? '').toLowerCase()))
      .all()
      .filter((task) => task.repoName === (config.githubRepoName ?? '').toLowerCase());
    const taskIds = new Set(taskRows.map((task) => task.id));
    const attemptRows = db
      .select()
      .from(attempts)
      .all()
      .filter((attempt) => taskIds.has(attempt.taskId));
    console.log('Tasks:');
    console.table(taskRows);
    console.log('Attempts:');
    console.table(attemptRows);
    return result.error ? 1 : 0;
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
