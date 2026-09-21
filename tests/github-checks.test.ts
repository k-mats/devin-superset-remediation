import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../src/github/client.js';
import { evaluateGitHubChecks, pullRequestChecksUrl } from '../src/verification/github-checks.js';

describe('evaluateGitHubChecks', () => {
  it('reports no_checks when nothing exists', () => {
    const result = evaluateGitHubChecks(
      { total_count: 0, check_runs: [] },
      { state: 'pending', total_count: 0, statuses: [] }
    );
    expect(result).toMatchObject({ status: 'unverified', reason: 'no_checks' });
  });

  it('reports checks_pending while runs are incomplete', () => {
    const result = evaluateGitHubChecks(
      {
        total_count: 1,
        check_runs: [{ name: 'ci', status: 'in_progress', conclusion: null }],
      },
      { state: 'pending', total_count: 0, statuses: [] }
    );
    expect(result).toMatchObject({ status: 'unverified', reason: 'checks_pending' });
    expect(result.summary).toContain('ci');
  });

  it('reports failed on failing conclusions and statuses', () => {
    const result = evaluateGitHubChecks(
      {
        total_count: 1,
        check_runs: [{ name: 'unit', status: 'completed', conclusion: 'failure' }],
      },
      { state: 'success', total_count: 0, statuses: [] }
    );
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('unit');

    const statusFailure = evaluateGitHubChecks(
      { total_count: 0, check_runs: [] },
      {
        state: 'failure',
        total_count: 1,
        statuses: [{ context: 'travis', state: 'failure', target_url: 'x' }],
      }
    );
    expect(statusFailure.status).toBe('failed');
  });

  it('treats success, neutral, and skipped conclusions as passed', () => {
    const result = evaluateGitHubChecks(
      {
        total_count: 3,
        check_runs: [
          { name: 'a', status: 'completed', conclusion: 'success' },
          { name: 'b', status: 'completed', conclusion: 'skipped' },
          { name: 'c', status: 'completed', conclusion: 'neutral' },
        ],
      },
      { state: 'success', total_count: 0, statuses: [] }
    );
    expect(result.status).toBe('passed');
    expect(result.summary).toContain('check_runs=3');
  });

  it('builds the pull request checks evidence URL', () => {
    expect(pullRequestChecksUrl('o', 'r', 5)).toBe('https://github.com/o/r/pull/5/checks');
  });
});

describe('GitHubClient check endpoints', () => {
  it('parses and paginates check runs', async () => {
    const run = (name: string) => ({
      name,
      status: 'completed',
      conclusion: 'success',
      html_url: 'u',
    });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 3, check_runs: [run('a'), run('b')] }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_count: 3, check_runs: [run('c')] }), { status: 200 })
      );
    const client = new GitHubClient({ token: 't', fetchFn, perPage: 2 });

    const result = await client.listCheckRuns('owner', 'repo', 'abc123');

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/owner/repo/commits/abc123/check-runs?per_page=2&page=1'
    );
    expect(result.check_runs.map((entry) => entry.name)).toEqual(['a', 'b', 'c']);
    expect(result.total_count).toBe(3);
  });

  it('parses the combined status response', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            state: 'success',
            total_count: 1,
            statuses: [{ context: 'ci', state: 'success', target_url: 'u' }],
          }),
          { status: 200 }
        )
      )
    );
    const client = new GitHubClient({ token: 't', fetchFn });

    const result = await client.getCombinedStatus('owner', 'repo', 'abc123');

    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/owner/repo/commits/abc123/status'
    );
    expect(result).toMatchObject({ state: 'success', total_count: 1 });
  });

  it('rejects malformed check run responses', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ check_runs: 'nope' }), { status: 200 }))
    );
    const client = new GitHubClient({ token: 't', fetchFn });
    await expect(client.listCheckRuns('o', 'r', 'ref')).rejects.toThrow(/unexpected response/i);
  });
});
