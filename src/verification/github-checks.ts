import type { GitHubCheckRuns, GitHubCombinedStatus } from '../github/client.js';

const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
]);
const FAILURE_STATES = new Set(['failure', 'error']);

export interface GitHubChecksEvaluation {
  status: 'passed' | 'failed' | 'unverified';
  reason?: 'no_checks' | 'checks_pending';
  summary: string;
}

export function evaluateGitHubChecks(
  checkRuns: GitHubCheckRuns,
  combined: GitHubCombinedStatus
): GitHubChecksEvaluation {
  const runCounts = new Map<string, number>();
  const failing: string[] = [];
  const pending: string[] = [];
  for (const run of checkRuns.check_runs) {
    if (run.status !== 'completed') {
      pending.push(run.name);
      runCounts.set('in_progress', (runCounts.get('in_progress') ?? 0) + 1);
      continue;
    }
    const conclusion = run.conclusion ?? 'neutral';
    runCounts.set(conclusion, (runCounts.get(conclusion) ?? 0) + 1);
    if (FAILURE_CONCLUSIONS.has(conclusion)) {
      failing.push(run.name);
    }
  }

  const statusCounts = new Map<string, number>();
  for (const status of combined.statuses) {
    statusCounts.set(status.state, (statusCounts.get(status.state) ?? 0) + 1);
    if (FAILURE_STATES.has(status.state)) {
      failing.push(status.context);
    } else if (status.state === 'pending') {
      pending.push(status.context);
    }
  }

  const describe = (counts: Map<string, number>) =>
    [...counts.entries()].map(([name, count]) => `${name}=${String(count)}`).join(', ');
  const detail =
    failing.length > 0
      ? `; failing: ${failing.join(', ')}`
      : pending.length > 0
        ? `; pending: ${pending.join(', ')}`
        : '';
  const summary = `check_runs=${String(checkRuns.total_count)} (${describe(runCounts)}); statuses=${String(combined.total_count)} (${describe(statusCounts)})${detail}`;

  if (checkRuns.total_count === 0 && combined.total_count === 0) {
    return { status: 'unverified', reason: 'no_checks', summary };
  }
  if (failing.length > 0) {
    return { status: 'failed', summary };
  }
  if (pending.length > 0) {
    return { status: 'unverified', reason: 'checks_pending', summary };
  }
  return { status: 'passed', summary };
}

export function pullRequestChecksUrl(owner: string, repo: string, prNumber: number): string {
  return `https://github.com/${owner}/${repo}/pull/${String(prNumber)}/checks`;
}
