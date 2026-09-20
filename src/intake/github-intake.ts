import type { FastifyBaseLogger } from 'fastify';
import type { GitHubClient, GitHubIssue } from '../github/client.js';
import { getDb } from '../db/client.js';
import {
  ActiveAttemptExistsError,
  createAttempt,
  getTaskByIdentity,
  listAttempts,
  upsertTask,
  type Db,
} from '../db/task-state.js';

export type IntakeDecision =
  'created' | 'skipped_existing_attempt' | 'skipped_active_attempt_conflict' | 'skipped_ineligible';

export interface IntakeResult {
  fetched: number;
  created: number;
  skipped: number;
  ineligible: number;
  error?: string;
}

export interface GitHubIntakeOptions {
  client: GitHubClient;
  repoOwner: string;
  repoName: string;
  label: string;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
}

export function isEligibleIssue(issue: GitHubIssue, label: string): boolean {
  return (
    issue.pull_request === undefined &&
    issue.state === 'open' &&
    issue.labels.some((issueLabel) => issueLabel.name === label)
  );
}

export function intakeIssue(
  issue: GitHubIssue,
  identity: { repoOwner: string; repoName: string },
  db: Db = getDb()
): IntakeDecision {
  try {
    return db.transaction((tx) => {
      const taskIdentity = {
        repoOwner: identity.repoOwner,
        repoName: identity.repoName,
        issueNumber: issue.number,
      };
      const existing = getTaskByIdentity(taskIdentity, tx);
      if (!existing) {
        const task = upsertTask({ ...taskIdentity, title: issue.title }, tx);
        createAttempt(task.id, tx);
        return 'created';
      }

      if (listAttempts(existing.id, tx).length === 0) {
        createAttempt(existing.id, tx);
        return 'created';
      }

      return 'skipped_existing_attempt';
    });
  } catch (error: unknown) {
    if (error instanceof ActiveAttemptExistsError) {
      // A concurrent intake won the race; the rolled-back transaction changed nothing.
      return 'skipped_active_attempt_conflict';
    }
    throw error;
  }
}

export async function runIntakeOnce(opts: GitHubIntakeOptions): Promise<IntakeResult> {
  let issues: GitHubIssue[];
  try {
    issues = await opts.client.listOpenIssuesByLabel(opts.repoOwner, opts.repoName, opts.label);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    opts.logger.error(
      { err: error, repoOwner: opts.repoOwner, repoName: opts.repoName, label: opts.label },
      'GitHub intake failed; no task state changed'
    );
    return { fetched: 0, created: 0, skipped: 0, ineligible: 0, error: message };
  }

  const result: IntakeResult = {
    fetched: issues.length,
    created: 0,
    skipped: 0,
    ineligible: 0,
  };
  const db = opts.db ?? getDb();

  for (const issue of issues) {
    if (!isEligibleIssue(issue, opts.label)) {
      result.ineligible += 1;
      opts.logger.debug(
        { issue_number: issue.number, title: issue.title, html_url: issue.html_url },
        'Skipped ineligible GitHub issue'
      );
      continue;
    }

    const decision = intakeIssue(issue, opts, db);
    if (decision === 'created') {
      result.created += 1;
      const task = getTaskByIdentity(
        { repoOwner: opts.repoOwner, repoName: opts.repoName, issueNumber: issue.number },
        db
      );
      const attempt = task ? listAttempts(task.id, db).at(-1) : undefined;
      opts.logger.info(
        {
          issue_number: issue.number,
          title: issue.title,
          html_url: issue.html_url,
          attempt_id: attempt?.id,
          correlation_id: attempt?.correlationId,
        },
        'Created GitHub intake task'
      );
    } else {
      result.skipped += 1;
      const reason =
        decision === 'skipped_active_attempt_conflict'
          ? 'active_attempt_conflict'
          : 'existing_attempt';
      opts.logger.info(
        { issue_number: issue.number, title: issue.title, html_url: issue.html_url, reason },
        'Skipped GitHub issue with existing attempt history'
      );
    }
  }

  opts.logger.info(
    {
      repoOwner: opts.repoOwner,
      repoName: opts.repoName,
      label: opts.label,
      fetched: result.fetched,
      created: result.created,
      skipped: result.skipped,
      ineligible: result.ineligible,
    },
    'GitHub intake completed'
  );
  return result;
}

export function startIntakePoller(opts: GitHubIntakeOptions & { intervalMs: number }): {
  stop(): Promise<void>;
} {
  let inFlight = false;
  let stopped = false;
  let current: Promise<void> | undefined;

  const run = () => {
    if (stopped) return;
    if (inFlight) {
      opts.logger.debug('Skipping GitHub intake poll while previous run is in flight');
      return;
    }
    inFlight = true;
    current = runIntakeOnce(opts)
      .then(() => undefined)
      .catch((error: unknown) => {
        opts.logger.error({ err: error }, 'GitHub intake run failed unexpectedly');
      })
      .finally(() => {
        inFlight = false;
        current = undefined;
      });
  };

  run();
  const interval = setInterval(() => {
    run();
  }, opts.intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(interval);
      await current;
    },
  };
}
