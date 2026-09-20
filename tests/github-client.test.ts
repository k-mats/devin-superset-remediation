import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import {
  createGitHubClientFromConfig,
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
