import { z } from 'zod';
import type { Config } from '../config.js';

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PER_PAGE = 100;
const MAX_ERROR_BODY_LENGTH = 500;
const MAX_PAGES = 50;

export const githubIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    html_url: z.string(),
    body: z.string().nullish(),
    labels: z.array(z.object({ name: z.string() }).loose()),
    pull_request: z.object({}).loose().optional(),
  })
  .loose();

export type GitHubIssue = z.infer<typeof githubIssueSchema>;

export interface GitHubClientOptions {
  token: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
  perPage?: number;
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
    public readonly rateLimited: boolean = false
  ) {
    super(`GitHub API ${method} ${path} failed with status ${String(status)}: ${body}`);
    this.name = 'GitHubApiError';
  }
}

export class GitHubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly perPage: number;

  constructor(opts: GitHubClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  }

  private async request(path: string): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'devin-superset-remediation',
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
      const body = text.replaceAll(this.token, '[REDACTED]');
      const rateLimited =
        (response.status === 403 || response.status === 429) &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after'));
      throw new GitHubApiError(response.status, 'GET', path, body, rateLimited);
    }

    return response.json();
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
    const path = `/repos/${owner}/${repo}/issues/${String(issueNumber)}`;
    const json = await this.request(path);
    const parsed = githubIssueSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `GitHub API GET ${path} returned an unexpected response: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  async listOpenIssuesByLabel(owner: string, repo: string, label: string): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const path = `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${String(this.perPage)}&page=${String(page)}`;
      const json = await this.request(path);
      const parsed = z.array(githubIssueSchema).safeParse(json);
      if (!parsed.success) {
        throw new Error(
          `GitHub API GET ${path} returned an unexpected response: ${parsed.error.message}`
        );
      }

      issues.push(...parsed.data);
      if (parsed.data.length < this.perPage) {
        return issues;
      }
    }

    throw new Error(`GitHub API pagination exceeded the ${String(MAX_PAGES)}-page safety limit`);
  }
}

export function createGitHubClientFromConfig(config: Config): GitHubClient {
  if (!config.githubToken) {
    throw new Error('Cannot create GitHub API client: missing required configuration GITHUB_TOKEN');
  }
  return new GitHubClient({ token: config.githubToken });
}
