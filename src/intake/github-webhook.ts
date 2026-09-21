import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { githubIssueSchema } from '../github/client.js';
import { getDb } from '../db/client.js';
import { getTaskByIdentity, listAttempts, type Db } from '../db/task-state.js';
import { intakeIssue, isEligibleIssue, type IntakeDecision } from './github-intake.js';

export const SUPPORTED_ISSUE_ACTIONS = ['opened', 'reopened', 'labeled'] as const;

const SIGNATURE_PREFIX = 'sha256=';
const SIGNATURE_HEX_LENGTH = 64;

export const githubIssuesWebhookPayloadSchema = z
  .object({
    action: z.string(),
    issue: githubIssueSchema,
    repository: z
      .object({
        name: z.string(),
        owner: z.object({ login: z.string() }).loose(),
      })
      .loose(),
  })
  .loose();

export type GitHubIssuesWebhookPayload = z.infer<typeof githubIssuesWebhookPayloadSchema>;

/**
 * Verifies a GitHub `X-Hub-Signature-256` header against the exact raw request
 * body. The header must be `sha256=` followed by 64 hex characters; the digest
 * is compared in constant time.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }
  const hex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (hex.length !== SIGNATURE_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(hex)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(hex, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function signGitHubPayload(rawBody: Buffer | string, secret: string): string {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export type WebhookOutcome =
  | { status: 'accepted'; decision: IntakeDecision; issueNumber: number }
  | { status: 'ignored'; reason: WebhookIgnoreReason; issueNumber?: number }
  | { status: 'invalid_payload'; message: string };

export type WebhookIgnoreReason =
  'unsupported_event' | 'unexpected_repository' | 'unsupported_action' | 'ineligible_issue';

export interface GitHubWebhookOptions {
  repoOwner: string;
  repoName: string;
  label: string;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
}

export interface GitHubWebhookDelivery {
  event: string | undefined;
  deliveryId: string | undefined;
  rawBody: Buffer;
}

function sameRepository(
  payload: GitHubIssuesWebhookPayload,
  opts: Pick<GitHubWebhookOptions, 'repoOwner' | 'repoName'>
): boolean {
  return (
    payload.repository.owner.login.toLowerCase() === opts.repoOwner.toLowerCase() &&
    payload.repository.name.toLowerCase() === opts.repoName.toLowerCase()
  );
}

/**
 * Applies the polling intake rules to an already-authenticated webhook
 * delivery. Callers must verify the signature before invoking this.
 */
export function handleGitHubWebhook(
  delivery: GitHubWebhookDelivery,
  opts: GitHubWebhookOptions
): WebhookOutcome {
  const log = { delivery_id: delivery.deliveryId, event: delivery.event };

  if (delivery.event !== 'issues') {
    opts.logger.debug(log, 'Ignored GitHub webhook with unsupported event');
    return { status: 'ignored', reason: 'unsupported_event' };
  }

  let json: unknown;
  try {
    json = JSON.parse(delivery.rawBody.toString('utf8'));
  } catch {
    opts.logger.warn(log, 'Rejected GitHub webhook with malformed JSON body');
    return { status: 'invalid_payload', message: 'Request body is not valid JSON' };
  }

  const parsed = githubIssuesWebhookPayloadSchema.safeParse(json);
  if (!parsed.success) {
    opts.logger.warn(log, 'Rejected GitHub webhook with unexpected issues payload shape');
    return { status: 'invalid_payload', message: 'Unexpected issues webhook payload' };
  }
  const payload = parsed.data;
  const issueNumber = payload.issue.number;
  const issueLog = { ...log, action: payload.action, issue_number: issueNumber };

  if (!sameRepository(payload, opts)) {
    opts.logger.info(
      { ...issueLog, repository: `${payload.repository.owner.login}/${payload.repository.name}` },
      'Ignored GitHub webhook for an unexpected repository'
    );
    return { status: 'ignored', reason: 'unexpected_repository', issueNumber };
  }

  if (!(SUPPORTED_ISSUE_ACTIONS as readonly string[]).includes(payload.action)) {
    opts.logger.debug(issueLog, 'Ignored GitHub webhook with unsupported issues action');
    return { status: 'ignored', reason: 'unsupported_action', issueNumber };
  }

  if (!isEligibleIssue(payload.issue, opts.label)) {
    opts.logger.debug(issueLog, 'Ignored GitHub webhook for an ineligible issue');
    return { status: 'ignored', reason: 'ineligible_issue', issueNumber };
  }

  const db = opts.db ?? getDb();
  const identity = { repoOwner: opts.repoOwner, repoName: opts.repoName };
  const decision = intakeIssue(payload.issue, identity, db);

  if (decision === 'created') {
    const task = getTaskByIdentity({ ...identity, issueNumber }, db);
    const attempt = task ? listAttempts(task.id, db).at(-1) : undefined;
    opts.logger.info(
      {
        ...issueLog,
        title: payload.issue.title,
        html_url: payload.issue.html_url,
        attempt_id: attempt?.id,
        correlation_id: attempt?.correlationId,
      },
      'Created GitHub intake task from webhook'
    );
  } else {
    const reason =
      decision === 'skipped_active_attempt_conflict'
        ? 'active_attempt_conflict'
        : 'existing_attempt';
    opts.logger.info(
      { ...issueLog, html_url: payload.issue.html_url, reason },
      'Skipped GitHub webhook issue with existing attempt history'
    );
  }

  return { status: 'accepted', decision, issueNumber };
}
