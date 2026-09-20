import {
  GitHubApiError,
  type GitHubClient,
  type GitHubPullRequest,
  derivePrState,
} from '../github/client.js';
import type { Task } from '../db/schema.js';

export function parsePullRequestUrl(
  url: string
): { owner: string; repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  const owner = match?.[1];
  const repo = match?.[2];
  const number = Number(match?.[3]);
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null;
  return { owner, repo, number };
}

export function referencesIssue(
  pr: Pick<GitHubPullRequest, 'title' | 'body'>,
  issueNumber: number
) {
  const number = String(issueNumber);
  const pattern = new RegExp(`(^|[^\\w/])#${number}\\b|/issues/${number}\\b`);
  return pattern.test(pr.title) || pattern.test(pr.body ?? '');
}

type VerifiedPullRequest = {
  url: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
};

export type VerifyPullRequestResult =
  | { ok: true; pr: VerifiedPullRequest }
  | {
      ok: false;
      reason:
        | 'unparseable_url'
        | 'repo_mismatch'
        | 'not_found'
        | 'issue_not_referenced'
        | 'lookup_failed';
      message?: string;
    };

export async function verifyAgentPullRequest(
  task: Task,
  agentPrUrl: string,
  github: Pick<GitHubClient, 'getPullRequest'>
): Promise<VerifyPullRequestResult> {
  const parsed = parsePullRequestUrl(agentPrUrl);
  if (!parsed) return { ok: false, reason: 'unparseable_url' };
  if (
    parsed.owner.toLowerCase() !== task.repoOwner.toLowerCase() ||
    parsed.repo.toLowerCase() !== task.repoName.toLowerCase()
  ) {
    return { ok: false, reason: 'repo_mismatch' };
  }

  let pr: GitHubPullRequest;
  try {
    pr = await github.getPullRequest(parsed.owner, parsed.repo, parsed.number);
  } catch (error: unknown) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return { ok: false, reason: 'not_found', message: error.message };
    }
    return {
      ok: false,
      reason: 'lookup_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (pr.base.repo.full_name.toLowerCase() !== `${task.repoOwner}/${task.repoName}`.toLowerCase()) {
    return { ok: false, reason: 'repo_mismatch' };
  }
  if (!referencesIssue(pr, task.issueNumber)) {
    return { ok: false, reason: 'issue_not_referenced' };
  }
  return {
    ok: true,
    pr: {
      url: pr.html_url,
      number: pr.number,
      state: derivePrState(pr),
      headSha: pr.head.sha,
    },
  };
}
