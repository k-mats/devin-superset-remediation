import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import {
  createGitHubClientFromConfig,
  derivePrState,
  GitHubApiError,
  GitHubClient,
} from '../src/github/client.js';

const issue = {
  number: 7,
  title: 'Fix the thing',
  state: 'open',
  html_url: 'https://github.com/owner/repo/issues/7',
  labels: [{ name: 'devin-ready' }],
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    host: '0.0.0.0',
    nodeEnv: 'test',
    databasePath: './test-database.db',
    logLevel: 'error',
    githubIntakeLabel: 'devin-ready',
    githubPollIntervalMs: 0,
    devinApiKey: undefined,
    devinOrgId: undefined,
    devinApiUrl: 'https://api.devin.ai/v3',
    devinDispatchIntervalMs: 0,
    devinTrackingIntervalMs: 0,
    devinReconcileIntervalMs: 0,
    devinDispatchGraceMs: 300_000,
    devinSessionStaleWarnMs: 21_600_000,
    devinMaxAcuPerSession: 5,
    verificationEnabled: true,
    verificationWorkspaceRoot: './data/verification',
    verificationCommandTimeoutMs: 900_000,
    verificationSetupTimeoutMs: 1_800_000,
    verificationCheckoutTimeoutMs: 300_000,
    verificationMaxOutputBytes: 16_384,
    ...overrides,
  };
}

describe('GitHubClient', () => {
  it('requests labeled open issues with GitHub headers', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify([issue]), { status: 200 }))
    );
    const client = new GitHubClient({ token: 'test-token', fetchFn });

    await client.listOpenIssuesByLabel('owner', 'repo', 'devin ready');

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://api.github.com/repos/owner/repo/issues?state=open&labels=devin%20ready&per_page=100&page=1'
    );
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    expect((init?.headers as Record<string, string>)['Accept']).toBe('application/vnd.github+json');
  });

  it('follows pagination until a short page', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([issue, { ...issue, number: 8 }]), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([issue]), { status: 200 }));
    const client = new GitHubClient({ token: 'test-token', fetchFn, perPage: 2 });

    await expect(
      client.listOpenIssuesByLabel('owner', 'repo', 'devin-ready')
    ).resolves.toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]?.[0]).toContain('page=2');
  });

  it('throws GitHubApiError for non-2xx responses without exposing the token', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('token test-token rejected', { status: 500 }))
    );
    const client = new GitHubClient({ token: 'test-token', fetchFn });

    const error = await client
      .listOpenIssuesByLabel('owner', 'repo', 'devin-ready')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 500 });
    expect(String(error)).not.toContain('test-token');
  });

  it('fetches a single issue by number', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ...issue, body: 'describe it' }), { status: 200 })
      )
    );
    const client = new GitHubClient({ token: 'test-token', fetchFn });

    const result = await client.getIssue('owner', 'repo', 7);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues/7');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    expect(result).toMatchObject({ number: 7, body: 'describe it' });
  });

  it.each([
    ['open', null, 'open'],
    ['closed', null, 'closed'],
    ['closed', '2026-01-01T00:00:00Z', 'merged'],
  ] as const)(
    'fetches pull requests and derives %s/%s as %s',
    async (state, mergedAt, expected) => {
      const fetchFn = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              number: 11,
              html_url: 'https://github.com/owner/repo/pull/11',
              title: 'Fix #7',
              state,
              merged_at: mergedAt,
              body: null,
              head: { sha: 'abc' },
              base: { repo: { full_name: 'owner/repo' } },
            }),
            { status: 200 }
          )
        )
      );
      const client = new GitHubClient({ token: 'test-token', fetchFn });

      const pr = await client.getPullRequest('owner', 'repo', 11);

      expect(fetchFn.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/owner/repo/pulls/11');
      expect(derivePrState(pr)).toBe(expected);
    }
  );

  it('raises GitHubApiError for a missing pull request', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('missing', { status: 404 }))
    );
    const client = new GitHubClient({ token: 'test-token', fetchFn });

    await expect(client.getPullRequest('owner', 'repo', 11)).rejects.toMatchObject({
      name: 'GitHubApiError',
      status: 404,
    });
  });

  it('throws GitHubApiError for a missing issue', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('Not Found', { status: 404 }))
    );
    const client = new GitHubClient({ token: 'test-token', fetchFn });

    const error = await client.getIssue('owner', 'repo', 404).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 404 });
  });

  it.each<[number, Record<string, string>, boolean]>([
    [403, { 'x-ratelimit-remaining': '0' }, true],
    [403, { 'retry-after': '30' }, true],
    [429, {}, true],
    [403, {}, false],
    [500, { 'x-ratelimit-remaining': '0' }, false],
  ])('flags %i with headers %j as rateLimited=%s', async (status, headers, expectedRateLimited) => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('nope', { status, headers }))
    );
    const client = new GitHubClient({ token: 'test-token', fetchFn });

    const error = await client.getIssue('owner', 'repo', 7).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).rateLimited).toBe(expectedRateLimited);
  });

  it('throws for an invalid response shape', async () => {
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ issue }), { status: 200 }))
    );
    const client = new GitHubClient({ token: 'test-token', fetchFn });

    await expect(client.listOpenIssuesByLabel('owner', 'repo', 'devin-ready')).rejects.toThrow(
      /unexpected response/i
    );
  });
});

describe('createGitHubClientFromConfig', () => {
  it('throws when the token is missing', () => {
    expect(() => createGitHubClientFromConfig(makeConfig())).toThrow(/GITHUB_TOKEN/);
  });

  it('creates a client with a configured token', () => {
    expect(createGitHubClientFromConfig(makeConfig({ githubToken: 'test-token' }))).toBeInstanceOf(
      GitHubClient
    );
  });
});
