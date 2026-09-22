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

export const githubPullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string(),
    title: z.string(),
    state: z.enum(['open', 'closed']),
    merged_at: z.string().nullish(),
    body: z.string().nullish(),
    head: z.object({ sha: z.string() }).loose(),
    base: z.object({ repo: z.object({ full_name: z.string() }).loose() }).loose(),
  })
  .loose();

export type GitHubPullRequest = z.infer<typeof githubPullRequestSchema>;

export const githubCheckRunsSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    check_runs: z.array(
      z
        .object({
          name: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
          html_url: z.string().nullish(),
        })
        .loose()
    ),
  })
  .loose();

export type GitHubCheckRuns = z.infer<typeof githubCheckRunsSchema>;

export const githubCombinedStatusSchema = z
  .object({
    state: z.string(),
    total_count: z.number().int().nonnegative(),
    statuses: z.array(
      z
        .object({
          context: z.string(),
          state: z.string(),
          target_url: z.string().nullish(),
        })
        .loose()
    ),
  })
  .loose();

export type GitHubCombinedStatus = z.infer<typeof githubCombinedStatusSchema>;

export function derivePrState(pr: GitHubPullRequest): 'open' | 'closed' | 'merged' {
  return pr.merged_at != null ? 'merged' : pr.state;
}

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

  private async request(
    path: string,
    init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {}
  ): Promise<unknown> {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'devin-superset-remediation',
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
      const body = text.replaceAll(this.token, '[REDACTED]');
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after')));
      throw new GitHubApiError(response.status, method, path, body, rateLimited);
    }

    return response.json();
  }

  async addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[]
  ): Promise<void> {
    const path = `/repos/${owner}/${repo}/issues/${String(issueNumber)}/labels`;
    await this.request(path, { method: 'POST', body: { labels } });
  }

  async removeLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    label: string
  ): Promise<void> {
    const path = `/repos/${owner}/${repo}/issues/${String(issueNumber)}/labels/${encodeURIComponent(label)}`;
    try {
      await this.request(path, { method: 'DELETE' });
    } catch (error: unknown) {
      // A 404 means the label is already absent; removal is idempotent.
      if (error instanceof GitHubApiError && error.status === 404) return;
      throw error;
    }
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

  async getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
    const path = `/repos/${owner}/${repo}/pulls/${String(number)}`;
    const json = await this.request(path);
    const parsed = githubPullRequestSchema.safeParse(json);
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

  async listCheckRuns(owner: string, repo: string, ref: string): Promise<GitHubCheckRuns> {
    const checkRuns: GitHubCheckRuns['check_runs'] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const path = `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=${String(this.perPage)}&page=${String(page)}`;
      const json = await this.request(path);
      const parsed = githubCheckRunsSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(
          `GitHub API GET ${path} returned an unexpected response: ${parsed.error.message}`
        );
      }
      checkRuns.push(...parsed.data.check_runs);
      if (parsed.data.check_runs.length < this.perPage) {
        return { total_count: parsed.data.total_count, check_runs: checkRuns };
      }
    }

    throw new Error(`GitHub API pagination exceeded the ${String(MAX_PAGES)}-page safety limit`);
  }

  async getCombinedStatus(owner: string, repo: string, ref: string): Promise<GitHubCombinedStatus> {
    const statuses: GitHubCombinedStatus['statuses'] = [];
    let firstPage: GitHubCombinedStatus | undefined;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const path = `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status?per_page=${String(this.perPage)}&page=${String(page)}`;
      const json = await this.request(path);
      const parsed = githubCombinedStatusSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(
          `GitHub API GET ${path} returned an unexpected response: ${parsed.error.message}`
        );
      }
      firstPage ??= parsed.data;
      statuses.push(...parsed.data.statuses);
      if (statuses.length >= firstPage.total_count || parsed.data.statuses.length < this.perPage) {
        return { ...firstPage, statuses };
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
