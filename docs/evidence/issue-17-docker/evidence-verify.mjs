// In-container equivalent of `pnpm demo:verification --attempt <id> [--rerun]`,
// using only compiled dist/ modules (same verifyRemediationOnce as the service poll).
import { parseArgs } from 'node:util';
import { eq } from '/app/node_modules/drizzle-orm/index.js';
import { config } from '/app/dist/config.js';
import { closeDb, getDb, runMigrations } from '/app/dist/db/client.js';
import { tasks } from '/app/dist/db/schema.js';
import { createGitHubClientFromConfig, derivePrState } from '/app/dist/github/client.js';
import { getAttempt, listVerifications, recordPullRequest } from '/app/dist/db/task-state.js';
import { verifyRemediationOnce } from '/app/dist/verification/verify-remediation.js';

const logger = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  debug: (...a) => console.debug(...a),
};

const { values } = parseArgs({
  options: { attempt: { type: 'string' }, rerun: { type: 'boolean', default: false } },
});
runMigrations();
const db = getDb();
const github = createGitHubClientFromConfig(config);
let attempt = getAttempt(Number(values.attempt), db);
const task = db.select().from(tasks).where(eq(tasks.id, attempt.taskId)).get();
const pr = await github.getPullRequest(task.repoOwner, task.repoName, attempt.prNumber);
attempt = recordPullRequest(
  attempt.id,
  { prUrl: pr.html_url, prNumber: pr.number, prState: derivePrState(pr), prHeadSha: pr.head.sha },
  db
);
const started = Date.now();
const decision = await verifyRemediationOnce(attempt, task, {
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
console.log(`Decision: ${decision} (${Date.now() - started} ms wall)`);
console.log('Attempt:');
console.table([getAttempt(attempt.id, db)]);
const rows = listVerifications(attempt.id, db);
console.log('Verifications:');
console.table(
  rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    exit_code: r.exitCode,
    head_sha: r.headSha,
    spec_sha256: r.specSha256,
  }))
);
const newest = rows.at(-1);
if (newest?.evidenceSummary) {
  console.log('Newest evidence_summary:');
  console.log(newest.evidenceSummary);
}
closeDb();
