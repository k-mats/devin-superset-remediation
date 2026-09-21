import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import * as taskState from '../src/db/task-state.js';
import { ActiveAttemptExistsError, getTaskByIdentity, listAttempts } from '../src/db/task-state.js';
import { runIntakeOnce } from '../src/intake/github-intake.js';
import {
  handleGitHubWebhook,
  signGitHubPayload,
  verifyGitHubSignature,
  type WebhookOutcome,
} from '../src/intake/github-webhook.js';
import { githubWebhookRoutes } from '../src/routes/github-webhook.js';

const SECRET = 'test-webhook-secret';
const identity = { repoOwner: 'owner', repoName: 'repo' };

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

interface PayloadOverrides {
  action?: string;
  labels?: string[];
  state?: string;
  pullRequest?: boolean;
  owner?: string;
  repo?: string;
  number?: number;
  label?: string;
}

function issuesPayload(overrides: PayloadOverrides = {}) {
  const number = overrides.number ?? 7;
  return {
    action: overrides.action ?? 'labeled',
    label: { name: overrides.label ?? 'devin-ready' },
    issue: {
      number,
      title: 'Fix the thing',
      state: overrides.state ?? 'open',
      html_url: `https://github.com/owner/repo/issues/${String(number)}`,
      body: 'Details',
      labels: (overrides.labels ?? ['devin-ready']).map((name) => ({ name })),
      ...(overrides.pullRequest ? { pull_request: { url: 'https://example.invalid' } } : {}),
    },
    repository: {
      name: overrides.repo ?? 'repo',
      owner: { login: overrides.owner ?? 'owner' },
    },
  };
}

interface InjectOptions {
  body?: string;
  secret?: string;
  signature?: string | null;
  event?: string | null;
  contentType?: string;
  deliveryId?: string;
}

async function buildWebhookServer(overrides: { secret?: string } = {}) {
  const server = Fastify({ logger: false });
  await server.register(githubWebhookRoutes, {
    secret: overrides.secret ?? SECRET,
    ...identity,
    label: 'devin-ready',
    logger: logger(),
    db: getDb(),
  });
  // A sibling route proves the buffer parser does not leak out of the plugin.
  server.post('/echo', (request) => request.body);
  await server.ready();
  return server;
}

function post(server: Awaited<ReturnType<typeof buildWebhookServer>>, opts: InjectOptions = {}) {
  const body = opts.body ?? JSON.stringify(issuesPayload());
  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'application/json',
    'x-github-delivery': opts.deliveryId ?? 'delivery-1',
  };
  if (opts.event !== null) headers['x-github-event'] = opts.event ?? 'issues';
  if (opts.signature !== null) {
    headers['x-hub-signature-256'] =
      opts.signature ?? signGitHubPayload(body, opts.secret ?? SECRET);
  }
  return server.inject({ method: 'POST', url: '/webhooks/github', headers, payload: body });
}

function taskAndAttempts(issueNumber = 7) {
  const task = getTaskByIdentity({ ...identity, issueNumber });
  return { task, attempts: task ? listAttempts(task.id) : [] };
}

function expectNoState() {
  expect(getDb().select().from(tasks).all()).toHaveLength(0);
  expect(getDb().select().from(attempts).all()).toHaveLength(0);
}

function expectSingleTaskAndAttempt(issueNumber = 7) {
  const { task, attempts: found } = taskAndAttempts(issueNumber);
  expect(task).toBeDefined();
  expect(found).toHaveLength(1);
  expect(found[0]?.state).toBe('pending');
  expect(getDb().select().from(tasks).all()).toHaveLength(1);
  expect(getDb().select().from(attempts).all()).toHaveLength(1);
}

describe('verifyGitHubSignature', () => {
  const body = Buffer.from('{"a":1}');

  it('accepts a correctly signed body', () => {
    expect(verifyGitHubSignature(body, signGitHubPayload(body, SECRET), SECRET)).toBe(true);
  });

  it('accepts upper-case hex digests', () => {
    const signature = signGitHubPayload(body, SECRET);
    const upper = `sha256=${signature.slice('sha256='.length).toUpperCase()}`;
    expect(verifyGitHubSignature(body, upper, SECRET)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong algorithm prefix', `sha1=${'a'.repeat(40)}`],
    ['no prefix', 'a'.repeat(64)],
    ['too short', 'sha256=abcd'],
    ['too long', `sha256=${'a'.repeat(65)}`],
    ['non-hex characters', `sha256=${'z'.repeat(64)}`],
    ['wrong digest', `sha256=${'0'.repeat(64)}`],
  ])('rejects a %s signature', (_label, signature) => {
    expect(verifyGitHubSignature(body, signature, SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyGitHubSignature(body, signGitHubPayload(body, 'other'), SECRET)).toBe(false);
  });

  it('rejects a body modified after signing', () => {
    const signature = signGitHubPayload(body, SECRET);
    expect(verifyGitHubSignature(Buffer.from('{"a":2}'), signature, SECRET)).toBe(false);
  });
});

describe('GitHub webhook route', () => {
  let server: Awaited<ReturnType<typeof buildWebhookServer>>;

  beforeAll(async () => {
    runMigrations();
    server = await buildWebhookServer();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(async () => {
    await server.close();
    closeDb();
  });

  describe('valid signed intake', () => {
    it('accepts a correctly signed issues webhook and persists one task and one pending attempt', async () => {
      const response = await post(server);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'accepted', decision: 'created', issueNumber: 7 });
      expectSingleTaskAndAttempt();
      const { task } = taskAndAttempts();
      expect(task).toMatchObject({ repoOwner: 'owner', repoName: 'repo', title: 'Fix the thing' });
    });

    it.each(['opened', 'reopened', 'labeled'])(
      'accepts the %s action for an eligible issue',
      async (action) => {
        const response = await post(server, { body: JSON.stringify(issuesPayload({ action })) });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'accepted', decision: 'created' });
        expectSingleTaskAndAttempt();
      }
    );

    it('verifies the signature over the exact raw bytes, not re-serialized JSON', async () => {
      // Same JSON value, different bytes (whitespace + key order): only the
      // signature computed over these exact bytes may be accepted.
      const payload = issuesPayload();
      const rawBody = `{\n  "repository": ${JSON.stringify(payload.repository)},\n  "issue": ${JSON.stringify(payload.issue)},\n  "action": "labeled"\n}`;
      const canonical = JSON.stringify(JSON.parse(rawBody));
      expect(canonical).not.toBe(rawBody);

      const rejected = await post(server, {
        body: rawBody,
        signature: signGitHubPayload(canonical, SECRET),
      });
      expect(rejected.statusCode).toBe(401);
      expectNoState();

      const accepted = await post(server, { body: rawBody });
      expect(accepted.statusCode).toBe(200);
      expectSingleTaskAndAttempt();
    });

    it('does not leak the buffer parser to sibling routes', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/echo',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ hello: 'world' }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ hello: 'world' });
    });
  });

  describe('signature failures', () => {
    it.each<[string, InjectOptions]>([
      ['missing signature', { signature: null }],
      ['malformed signature', { signature: 'sha256=not-hex' }],
      ['wrong secret', { secret: 'wrong-secret' }],
      ['wrong digest', { signature: `sha256=${'f'.repeat(64)}` }],
    ])('rejects %s with 401 and changes no state', async (_label, opts) => {
      const response = await post(server, opts);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Invalid signature' });
      expectNoState();
    });

    it('rejects a payload modified after signing', async () => {
      const original = JSON.stringify(issuesPayload({ labels: ['other'] }));
      const tampered = JSON.stringify(issuesPayload({ labels: ['devin-ready'] }));
      const response = await post(server, {
        body: tampered,
        signature: signGitHubPayload(original, SECRET),
      });
      expect(response.statusCode).toBe(401);
      expectNoState();
    });

    it('does not include the signature or secret in the response', async () => {
      const response = await post(server, { secret: 'wrong-secret' });
      expect(response.body).not.toContain(SECRET);
      expect(response.body).not.toContain('sha256=');
    });
  });

  describe('payload and content-type failures', () => {
    it('returns 400 for a signed but malformed JSON body', async () => {
      const response = await post(server, { body: '{"action": "labeled",' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Request body is not valid JSON' });
      expectNoState();
    });

    it('returns 400 for signed JSON that is not an issues payload', async () => {
      const response = await post(server, { body: JSON.stringify({ action: 'labeled' }) });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Unexpected issues webhook payload' });
      expectNoState();
    });

    it('returns 415 for form-encoded deliveries', async () => {
      const body = `payload=${encodeURIComponent(JSON.stringify(issuesPayload()))}`;
      const response = await post(server, {
        body,
        contentType: 'application/x-www-form-urlencoded',
      });
      expect(response.statusCode).toBe(415);
      expectNoState();
    });

    it('returns 415 for text bodies even when correctly signed', async () => {
      const response = await post(server, { contentType: 'text/plain' });
      expect(response.statusCode).toBe(415);
      expectNoState();
    });
  });

  describe('eligibility and scope', () => {
    it('ignores events for an unexpected repository', async () => {
      const response = await post(server, {
        body: JSON.stringify(issuesPayload({ owner: 'someone-else' })),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ignored', reason: 'unexpected_repository' });
      expectNoState();
    });

    it('matches the repository case-insensitively but persists the configured identity', async () => {
      const response = await post(server, {
        body: JSON.stringify(issuesPayload({ owner: 'OWNER', repo: 'Repo' })),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'accepted', decision: 'created' });
      const { task } = taskAndAttempts();
      expect(task).toMatchObject({ repoOwner: 'owner', repoName: 'repo' });
    });

    it('ignores unsupported event types', async () => {
      const response = await post(server, { event: 'issue_comment' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ignored', reason: 'unsupported_event' });
      expectNoState();
    });

    it('ignores deliveries without an event header', async () => {
      const response = await post(server, { event: null });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ignored', reason: 'unsupported_event' });
      expectNoState();
    });

    it.each(['edited', 'closed', 'unlabeled', 'assigned', 'deleted'])(
      'ignores the unsupported %s action',
      async (action) => {
        const response = await post(server, { body: JSON.stringify(issuesPayload({ action })) });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'ignored', reason: 'unsupported_action' });
        expectNoState();
      }
    );

    it('ignores a labeled event for a non-intake label', async () => {
      const response = await post(server, {
        body: JSON.stringify(issuesPayload({ label: 'bug', labels: ['bug'] })),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ignored', reason: 'ineligible_issue' });
      expectNoState();
    });

    it('ignores an opened issue without the intake label', async () => {
      const response = await post(server, {
        body: JSON.stringify(issuesPayload({ action: 'opened', labels: [] })),
      });
      expect(response.json()).toMatchObject({ status: 'ignored', reason: 'ineligible_issue' });
      expectNoState();
    });

    it('ignores pull requests and closed issues carrying the intake label', async () => {
      const pr = await post(server, { body: JSON.stringify(issuesPayload({ pullRequest: true })) });
      expect(pr.json()).toMatchObject({ status: 'ignored', reason: 'ineligible_issue' });
      const closed = await post(server, {
        body: JSON.stringify(issuesPayload({ state: 'closed' })),
      });
      expect(closed.json()).toMatchObject({ status: 'ignored', reason: 'ineligible_issue' });
      expectNoState();
    });

    it('accepts a labeled event for another label when the issue already carries devin-ready', async () => {
      // The payload's `label` field is not special-cased; the issue's label set decides.
      const response = await post(server, {
        body: JSON.stringify(issuesPayload({ label: 'bug', labels: ['bug', 'devin-ready'] })),
      });
      expect(response.json()).toMatchObject({ status: 'accepted', decision: 'created' });
      expectSingleTaskAndAttempt();
    });
  });

  describe('replay and convergence', () => {
    const pollingClient = () => ({
      listOpenIssuesByLabel: vi.fn().mockResolvedValue([issuesPayload().issue]),
    });
    const pollingOptions = () => ({
      client: pollingClient() as unknown as Parameters<typeof runIntakeOnce>[0]['client'],
      ...identity,
      label: 'devin-ready',
      logger: logger(),
      db: getDb(),
    });

    it('replaying the same signed fixture creates no additional task or attempt', async () => {
      const body = JSON.stringify(issuesPayload());
      const outcomes: WebhookOutcome[] = [];
      for (let count = 0; count < 5; count += 1) {
        const response = await post(server, { body, deliveryId: `delivery-${String(count)}` });
        expect(response.statusCode).toBe(200);
        outcomes.push(response.json<WebhookOutcome>());
      }

      expect(outcomes[0]).toMatchObject({ status: 'accepted', decision: 'created' });
      for (const outcome of outcomes.slice(1)) {
        expect(outcome).toMatchObject({ status: 'accepted', decision: 'skipped_existing_attempt' });
      }
      expectSingleTaskAndAttempt();
    });

    it('webhook followed by polling creates no duplicate work', async () => {
      await post(server);
      const result = await runIntakeOnce(pollingOptions());

      expect(result).toMatchObject({ fetched: 1, created: 0, skipped: 1 });
      expectSingleTaskAndAttempt();
    });

    it('polling followed by webhook creates no duplicate work', async () => {
      const result = await runIntakeOnce(pollingOptions());
      expect(result).toMatchObject({ created: 1 });

      const response = await post(server);
      expect(response.json()).toMatchObject({
        status: 'accepted',
        decision: 'skipped_existing_attempt',
      });
      expectSingleTaskAndAttempt();
    });

    it('a webhook losing an intake race to polling reports the conflict without duplicate attempts', async () => {
      // Simulate polling committing its attempt between the webhook's
      // existence check and its insert: the partial unique index rejects the
      // second active attempt and the webhook transaction rolls back.
      const spy = vi.spyOn(taskState, 'createAttempt').mockImplementationOnce(() => {
        void runIntakeOnce(pollingOptions());
        throw new ActiveAttemptExistsError(1);
      });

      try {
        const response = await post(server);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: 'accepted',
          decision: 'skipped_active_attempt_conflict',
        });
      } finally {
        spy.mockRestore();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      expectSingleTaskAndAttempt();
    });

    it('interleaved webhook and polling for several issues converge on one attempt each', async () => {
      const issues = [7, 8, 9].map((number) => issuesPayload({ number }));
      const client = {
        listOpenIssuesByLabel: vi.fn().mockResolvedValue(issues.map((payload) => payload.issue)),
      };
      const options = {
        ...pollingOptions(),
        client: client as unknown as Parameters<typeof runIntakeOnce>[0]['client'],
      };

      await post(server, { body: JSON.stringify(issues[1]) });
      await Promise.all([
        runIntakeOnce(options),
        post(server, { body: JSON.stringify(issues[0]) }),
        post(server, { body: JSON.stringify(issues[2]) }),
        post(server, { body: JSON.stringify(issues[1]) }),
      ]);
      await runIntakeOnce(options);

      expect(getDb().select().from(tasks).all()).toHaveLength(3);
      expect(getDb().select().from(attempts).all()).toHaveLength(3);
      for (const number of [7, 8, 9]) {
        expect(taskAndAttempts(number).attempts).toHaveLength(1);
      }
    });
  });
});

describe('handleGitHubWebhook', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  it('logs the delivery id and never the payload secret material', () => {
    const log = logger();
    const outcome = handleGitHubWebhook(
      {
        event: 'issues',
        deliveryId: 'delivery-xyz',
        rawBody: Buffer.from(JSON.stringify(issuesPayload())),
      },
      { ...identity, label: 'devin-ready', logger: log, db: getDb() }
    );

    expect(outcome).toEqual({ status: 'accepted', decision: 'created', issueNumber: 7 });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_id: 'delivery-xyz', issue_number: 7, action: 'labeled' }),
      'Created GitHub intake task from webhook'
    );
  });
});
