import { describe, expect, it, vi } from 'vitest';
import type { GitHubPullRequest } from '../src/github/client.js';
import { GitHubApiError } from '../src/github/client.js';
import {
  parsePullRequestUrl,
  referencesIssue,
  verifyAgentPullRequest,
} from '../src/outcome/verify-pull-request.js';

const task = {
  id: 1,
  repoOwner: 'Owner',
  repoName: 'Repo',
  issueNumber: 11,
  title: null,
  createdAt: 0,
  updatedAt: 0,
};

function pullRequest(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 12,
    html_url: 'https://github.com/owner/repo/pull/12',
    title: 'Fixes #11',
    state: 'open',
    merged_at: null,
    body: null,
    head: { sha: 'sha-1' },
    base: { repo: { full_name: 'owner/repo' } },
    ...overrides,
  };
}

describe('verify pull request', () => {
  it('parses canonical GitHub pull request URLs', () => {
    expect(parsePullRequestUrl('https://github.com/owner/repo/pull/12/')).toEqual({
      owner: 'owner',
      repo: 'repo',
      number: 12,
    });
    expect(parsePullRequestUrl('https://github.com/owner/repo/issues/12')).toBeNull();
  });

  it('requires an exact issue reference', () => {
    expect(referencesIssue({ title: 'Fix #11', body: null }, task)).toBe(true);
    expect(referencesIssue({ title: 'Fix #110', body: null }, task)).toBe(false);
    expect(referencesIssue({ title: 'See owner/repo#11', body: null }, task)).toBe(true);
    expect(
      referencesIssue({ title: 'See https://github.com/OWNER/REPO/issues/11', body: null }, task)
    ).toBe(true);
    expect(
      referencesIssue({ title: 'See https://github.com/other/repo/issues/11', body: null }, task)
    ).toBe(false);
  });

  it.each([
    ['unparseable_url', 'https://example.com/pr/1'],
    ['repo_mismatch', 'https://github.com/other/repo/pull/12'],
  ] as const)('rejects %s', async (reason, url) => {
    const result = await verifyAgentPullRequest(task, url, {
      getPullRequest: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('rejects a missing or unrelated pull request', async () => {
    const notFound = await verifyAgentPullRequest(task, 'https://github.com/owner/repo/pull/12', {
      getPullRequest: vi
        .fn()
        .mockRejectedValue(new GitHubApiError(404, 'GET', '/pulls/12', 'missing')),
    });
    expect(notFound).toMatchObject({ ok: false, reason: 'not_found' });

    const unrelated = await verifyAgentPullRequest(task, 'https://github.com/owner/repo/pull/12', {
      getPullRequest: vi.fn().mockResolvedValue(pullRequest({ title: 'Other work' })),
    });
    expect(unrelated).toMatchObject({ ok: false, reason: 'issue_not_referenced' });
  });

  it('classifies terminal and transient lookup errors separately', async () => {
    const rejected = await verifyAgentPullRequest(task, 'https://github.com/owner/repo/pull/12', {
      getPullRequest: vi
        .fn()
        .mockRejectedValue(new GitHubApiError(403, 'GET', '/pulls/12', 'forbidden')),
    });
    expect(rejected).toMatchObject({ ok: false, reason: 'lookup_rejected' });

    const deferred = await verifyAgentPullRequest(task, 'https://github.com/owner/repo/pull/12', {
      getPullRequest: vi
        .fn()
        .mockRejectedValue(new GitHubApiError(403, 'GET', '/pulls/12', 'rate limited', true)),
    });
    expect(deferred).toMatchObject({ ok: false, reason: 'lookup_failed' });
  });

  it('accepts a case-insensitive repository match and returns verified fields', async () => {
    const result = await verifyAgentPullRequest(task, 'https://github.com/owner/repo/pull/12', {
      getPullRequest: vi.fn().mockResolvedValue(pullRequest()),
    });
    expect(result).toEqual({
      ok: true,
      pr: {
        url: 'https://github.com/owner/repo/pull/12',
        number: 12,
        state: 'open',
        headSha: 'sha-1',
      },
    });
  });

  it('rejects a pull request whose base repository differs', async () => {
    const result = await verifyAgentPullRequest(task, 'https://github.com/owner/repo/pull/12', {
      getPullRequest: vi
        .fn()
        .mockResolvedValue(pullRequest({ base: { repo: { full_name: 'owner/other' } } })),
    });
    expect(result).toMatchObject({ ok: false, reason: 'repo_mismatch' });
  });
});
