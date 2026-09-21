import 'dotenv/config';
import { parseArgs } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../src/config.js';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { tasks } from '../src/db/schema.js';
import { createGitHubClientFromConfig, derivePrState } from '../src/github/client.js';
import { getAttempt, listVerifications, recordPullRequest } from '../src/db/task-state.js';
import { verifyRemediationOnce } from '../src/verification/verify-remediation.js';

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
    options: { attempt: { type: 'string' }, rerun: { type: 'boolean', default: false } },
  });
  if (!values.attempt) {
    console.error('Usage: pnpm demo:verification --attempt <id> [--rerun]');
    return 1;
  }
  runMigrations();
  try {
    const db = getDb();
    const github = createGitHubClientFromConfig(config);
    let attempt = getAttempt(Number(values.attempt), db);
    if (!attempt) {
      console.error(`Attempt ${values.attempt} not found`);
      return 1;
    }
    if (attempt.prNumber !== null) {
      const owner = config.githubRepoOwner;
      const repo = config.githubRepoName;
      if (!owner || !repo) {
        console.error('Missing GITHUB_REPO_OWNER/GITHUB_REPO_NAME');
        return 1;
      }
      const pr = await github.getPullRequest(owner, repo, attempt.prNumber);
      attempt = recordPullRequest(
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
    const resolvedTask = db.select().from(tasks).where(eq(tasks.id, attempt.taskId)).get();
    if (!resolvedTask) {
      console.error(`Task ${String(attempt.taskId)} not found`);
      return 1;
    }
    const decision = await verifyRemediationOnce(attempt, resolvedTask, {
      github,
      logger,
      db,
      workspaceRoot: config.verificationWorkspaceRoot,
      commandTimeoutMs: config.verificationCommandTimeoutMs,
      setupTimeoutMs: config.verificationSetupTimeoutMs,
      checkoutTimeoutMs: config.verificationCheckoutTimeoutMs,
      maxOutputBytes: config.verificationMaxOutputBytes,
      rerun: values.rerun,
    });
    console.log(`Decision: ${decision}`);
    console.log('Attempt:');
    console.table([getAttempt(attempt.id, db)]);
    const rows = listVerifications(attempt.id, db);
    console.log('Verifications:');
    console.table(
      rows.map((row) => ({
        ...row,
        evidence_summary:
          row.evidenceSummary !== null && row.evidenceSummary.length > 300
            ? `${row.evidenceSummary.slice(0, 300)}…`
            : row.evidenceSummary,
        spec_script:
          row.specScript !== null && row.specScript.length > 300
            ? `${row.specScript.slice(0, 300)}…`
            : row.specScript,
      }))
    );
    const newest = rows.at(-1);
    if (newest?.evidenceSummary) {
      console.log('Newest evidence_summary:');
      console.log(newest.evidenceSummary);
    }
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
