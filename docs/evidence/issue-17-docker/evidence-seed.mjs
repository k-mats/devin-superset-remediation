// In-container seed mirroring `pnpm demo:intake` + `pnpm demo:adopt-session` +
// tracking's recordPullRequest/markVerifying, using only compiled dist/ modules.
import { closeDb, getDb, runMigrations } from '/app/dist/db/client.js';
import {
  createAttempt,
  markDispatching,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  upsertTask,
} from '/app/dist/db/task-state.js';
import { createGitHubClientFromConfig, derivePrState } from '/app/dist/github/client.js';
import { config } from '/app/dist/config.js';

runMigrations();
const db = getDb();
const github = createGitHubClientFromConfig(config);
const task = upsertTask(
  {
    repoOwner: 'k-mats',
    repoName: 'superset',
    issueNumber: 13,
    title: 'fix(mcp): query_dataset returns UnexpectedError for reversed time_range',
  },
  db
);
let attempt = createAttempt(task.id, db);
markDispatching(attempt.id, db);
markSessionCreated(
  attempt.id,
  {
    devinSessionId: '5957ce490e56465b930e0349ace6db68',
    devinSessionUrl: 'https://app.devin.ai/sessions/5957ce490e56465b930e0349ace6db68',
  },
  db
);
const pr = await github.getPullRequest('k-mats', 'superset', 14);
attempt = recordPullRequest(
  attempt.id,
  { prUrl: pr.html_url, prNumber: pr.number, prState: derivePrState(pr), prHeadSha: pr.head.sha },
  db
);
attempt = markVerifying(attempt.id, db);
console.log(
  JSON.stringify(
    {
      task_id: task.id,
      attempt_id: attempt.id,
      state: attempt.state,
      pr_url: attempt.prUrl,
      pr_head_sha: attempt.prHeadSha,
    },
    null,
    2
  )
);
closeDb();
