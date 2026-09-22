import { describe, expect, it, vi } from 'vitest';
import {
  DevinApiError,
  DevinClient,
  classifySessionPhase,
  createDevinClientFromConfig,
  sessionResponseSchema,
} from '../src/devin/client.js';
import { structuredOutputJsonSchema } from '../src/devin/structured-output.js';
import type { Config } from '../src/config.js';

const sessionJson = {
  session_id: 'devin-abc',
  url: 'https://app.devin.ai/sessions/devin-abc',
  status: 'running',
  title: 'Smoke test',
  tags: ['smoke-test'],
  origin: 'api',
  service_user_id: 'svc-1',
  user_id: 'user-1',
  org_id: 'org_123',
  created_at: 1700000000,
  updated_at: 1700000001,
  acus_consumed: 0.5,
  some_unknown_field: 'ignored-but-preserved',
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    host: '0.0.0.0',
    nodeEnv: 'test',
    databasePath: './data/test.db',
    logLevel: 'info',
    githubIntakeLabel: 'devin-ready',
    githubVerifiedLabel: 'devin-verified',
    githubPollIntervalMs: 0,
    devinApiKey: 'test-key',
    devinOrgId: 'org_123',
    devinApiUrl: 'https://api.devin.ai/v3',
    devinDispatchIntervalMs: 0,
    verificationEnabled: true,
    verificationWorkspaceRoot: './data/verification',
    verificationCommandTimeoutMs: 900_000,
    verificationSetupTimeoutMs: 1_800_000,
    verificationCheckoutTimeoutMs: 300_000,
    verificationMaxOutputBytes: 16_384,
    devinTrackingIntervalMs: 0,
    devinReconcileIntervalMs: 0,
    devinDispatchGraceMs: 300_000,
    devinSessionStaleWarnMs: 21_600_000,
    devinMaxAcuPerSession: 5,
    ...overrides,
  };
}

function mockFetch(body: unknown = sessionJson, init: { status?: number; text?: string } = {}) {
  const status = init.status ?? 200;
  return vi.fn<typeof fetch>(() => {
    if (init.text !== undefined) {
      return Promise.resolve(new Response(init.text, { status }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });
}

describe('DevinClient', () => {
  it('createSession POSTs to the org sessions endpoint with auth and parses the response', async () => {
    const fetchFn = mockFetch();
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    const session = await client.createSession({
      prompt: 'hello',
      title: 't',
      tags: ['a'],
      max_acu_limit: 1,
      resumable: false,
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://api.devin.ai/v3/organizations/org_123/sessions');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    expect(JSON.parse(init?.body as string)).toEqual({
      prompt: 'hello',
      title: 't',
      tags: ['a'],
      max_acu_limit: 1,
      resumable: false,
    });
    expect(session.session_id).toBe('devin-abc');
    expect(session.origin).toBe('api');
  });

  it('sends structured_output_schema and structured_output_required in the create body', async () => {
    const fetchFn = mockFetch();
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    await client.createSession({
      prompt: 'hello',
      structured_output_schema: structuredOutputJsonSchema,
      structured_output_required: true,
    });

    const [, init] = fetchFn.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      structured_output_schema: structuredOutputJsonSchema,
      structured_output_required: true,
    });
  });

  it('exposes structured_output returned by a session GET', async () => {
    const structuredOutput = { schema_version: 1, outcome: 'no_action' };
    const fetchFn = mockFetch({ ...sessionJson, structured_output: structuredOutput });
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    const session = await client.getSession('devin-abc');
    expect(session.structured_output).toEqual(structuredOutput);
  });

  it('getSession GETs the session endpoint and returns the parsed response', async () => {
    const fetchFn = mockFetch();
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    const session = await client.getSession('devin-abc');

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('https://api.devin.ai/v3/organizations/org_123/sessions/devin-abc');
    expect(init?.method).toBe('GET');
    expect(session.session_id).toBe('devin-abc');
    expect(session.origin).toBe('api');
  });

  it('listSessions GETs with repeated tags= params and parses the paginated response', async () => {
    const fetchFn = mockFetch({
      items: [sessionJson],
      end_cursor: 'cursor-1',
      has_next_page: true,
      total: 1,
    });
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    const page = await client.listSessions({
      tags: ['devin-superset-remediation', 'correlation:abc-123'],
      first: 200,
      after: 'cursor-0',
      created_after: 1_700_000_000,
    });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(init?.method).toBe('GET');
    expect(url).toBe(
      'https://api.devin.ai/v3/organizations/org_123/sessions' +
        '?tags=devin-superset-remediation&tags=correlation%3Aabc-123' +
        '&first=200&after=cursor-0&created_after=1700000000'
    );
    expect(url).not.toContain('is_archived');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.session_id).toBe('devin-abc');
    expect(page.end_cursor).toBe('cursor-1');
    expect(page.has_next_page).toBe(true);
    expect(page.total).toBe(1);
  });

  it('listSessions omits undefined params and defaults has_next_page', async () => {
    const fetchFn = mockFetch({ items: [] });
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    const page = await client.listSessions({ tags: ['correlation:abc-123'] });

    const [url] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://api.devin.ai/v3/organizations/org_123/sessions?tags=correlation%3Aabc-123'
    );
    expect(page.items).toEqual([]);
    expect(page.has_next_page).toBe(false);
  });

  it('rejects with DevinApiError on non-2xx responses', async () => {
    const fetchFn = mockFetch(undefined, { status: 401, text: 'unauthorized' });
    const client = new DevinClient({ apiKey: 'bad-key', orgId: 'org_123', fetchFn });

    await expect(client.getSession('devin-abc')).rejects.toMatchObject({
      name: 'DevinApiError',
      status: 401,
    });
    await expect(client.getSession('devin-abc')).rejects.toBeInstanceOf(DevinApiError);
  });

  it('rejects when the response does not match the session schema', async () => {
    const fetchFn = mockFetch({ unexpected: true });
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    await expect(client.getSession('devin-abc')).rejects.toThrow(/unexpected response/i);
  });

  it.each([
    ['unknown status', { status: 'bogus' }],
    ['unknown status_detail', { status: 'exit', status_detail: 'mysterious_new_detail' }],
  ])('rejects a session payload with an %s instead of guessing a phase', async (_label, patch) => {
    const fetchFn = mockFetch({ ...sessionJson, ...patch });
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    await expect(client.getSession('devin-abc')).rejects.toThrow(/unexpected response/i);
  });

  it('passes an AbortSignal to fetch so requests are time-bounded', async () => {
    const fetchFn = mockFetch();
    const client = new DevinClient({ apiKey: 'test-key', orgId: 'org_123', fetchFn });

    await client.getSession('devin-abc');
    const [, init] = fetchFn.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('strips a trailing slash from baseUrl', async () => {
    const fetchFn = mockFetch();
    const client = new DevinClient({
      apiKey: 'test-key',
      orgId: 'org_123',
      baseUrl: 'https://api.devin.ai/v3/',
      fetchFn,
    });

    await client.getSession('devin-abc');
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://api.devin.ai/v3/organizations/org_123/sessions/devin-abc'
    );
  });
});

describe('classifySessionPhase', () => {
  const base = sessionResponseSchema.parse(sessionJson);

  it.each([
    ['running', 'working', 'in_progress'],
    ['running', undefined, 'in_progress'],
    ['new', undefined, 'in_progress'],
    ['running', 'waiting_for_approval', 'in_progress'],
    ['running', 'waiting_for_user', 'waiting_for_user'],
    ['suspended', 'inactivity', 'suspended'],
    ['suspended', undefined, 'suspended'],
    ['exit', null, 'finished'],
    ['running', 'finished', 'finished'],
    ['error', 'usage_limit_exceeded', 'error'],
    ['error', 'finished', 'error'],
  ] as const)('status %s / detail %s -> %s', (status, statusDetail, expected) => {
    expect(classifySessionPhase({ ...base, status, status_detail: statusDetail })).toBe(expected);
  });
});

describe('createDevinClientFromConfig', () => {
  it('creates a client when key and org are configured', () => {
    expect(createDevinClientFromConfig(makeConfig())).toBeInstanceOf(DevinClient);
  });

  it('throws when the API key is missing', () => {
    expect(() => createDevinClientFromConfig(makeConfig({ devinApiKey: undefined }))).toThrow(
      /DEVIN_API_KEY/
    );
  });

  it('throws when the org ID is missing', () => {
    expect(() => createDevinClientFromConfig(makeConfig({ devinOrgId: undefined }))).toThrow(
      /DEVIN_ORG_ID/
    );
  });
});
