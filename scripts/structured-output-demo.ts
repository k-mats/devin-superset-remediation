import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../src/config.js';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { createDevinClientFromConfig } from '../src/devin/client.js';
import { getAttempt, getAttemptByCorrelationId } from '../src/db/task-state.js';
import { collectStructuredOutput } from '../src/outcome/collect-structured-output.js';

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
  const { values } = parseArgs({
    options: {
      attempt: { type: 'string' },
      correlation: { type: 'string' },
    },
  });
  if (!values.attempt && !values.correlation) {
    console.error(
      'Usage: tsx scripts/structured-output-demo.ts --attempt <id> | --correlation <uuid>'
    );
    return 1;
  }

  runMigrations();
  try {
    const db = getDb();
    const attempt = values.attempt
      ? getAttempt(Number(values.attempt), db)
      : getAttemptByCorrelationId(values.correlation as string, db);
    if (!attempt) {
      console.error('Attempt not found');
      return 1;
    }

    const devin = createDevinClientFromConfig(config);
    const result = await collectStructuredOutput(attempt, { devin, logger, db });

    console.log('Decision:', result.decision);
    console.log('Raw structured_output:');
    console.log(JSON.stringify(result.session?.structured_output ?? null, null, 2));
    console.log('Attempt row:');
    console.table(getAttempt(attempt.id, db));
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
