import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
} from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  approveVerificationSpec,
  AttemptCompletedError,
  getAttempt,
  getTaskById,
  listVerifications,
  setVerificationCandidate,
  VerificationSpecMismatchError,
  type Db,
} from '../db/task-state.js';
import type { GitHubClient } from '../github/client.js';
import { projectTaskState } from '../tracking/normalized-task-state.js';
import { approvalStatus } from '../verification/approval.js';
import {
  rerunApprovedVerification,
  type RerunVerificationOptions,
  type RerunVerificationResult,
} from '../verification/rerun.js';
import {
  renderOperatorVerificationPage,
  type OperatorVerificationView,
} from '../reporting/render-operator-verification.js';

type GitHubRouteClient = Pick<
  GitHubClient,
  'getIssue' | 'getPullRequest' | 'listCheckRuns' | 'getCombinedStatus'
>;
type VerificationRouteOptions = Omit<
  RerunVerificationOptions,
  'github' | 'logger' | 'db' | 'rerun' | 'verify'
>;

export interface OperatorVerificationRouteOptions {
  getGitHubClient: () => GitHubRouteClient | undefined;
  verification: VerificationRouteOptions | undefined;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  db?: Db;
  rerun?: typeof rerunApprovedVerification;
}

const paramsSchema = z.object({ attemptId: z.coerce.number().int().positive() });
const proposalSchema = z.object({
  shell: z.enum(['sh', 'bash']),
  script: z
    .string()
    .max(65536)
    .refine((value) => value.trimEnd().length > 0, 'script must not be empty'),
});
const approvalSchema = z.object({ spec_sha256: z.string().regex(/^[0-9a-f]{64}$/) });

function bodyObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function loadView(
  attemptId: number,
  db: Db,
  opts: OperatorVerificationRouteOptions
): OperatorVerificationView | undefined {
  const attempt = getAttempt(attemptId, db);
  if (!attempt) return undefined;
  const task = getTaskById(attempt.taskId, db);
  if (!task) return undefined;
  const projection = projectTaskState(attempt, db);
  const status = approvalStatus(attempt);
  const github = opts.getGitHubClient();
  let rerunUnavailableReason: string | null = null;
  if (opts.verification === undefined) rerunUnavailableReason = 'verification_disabled';
  else if (github === undefined) rerunUnavailableReason = 'github_unavailable';
  else if (attempt.state !== 'verifying') rerunUnavailableReason = 'attempt_not_verifying';
  else if (attempt.prNumber === null) rerunUnavailableReason = 'no_pull_request';
  else if (status !== 'approved') rerunUnavailableReason = 'no_approved_spec';
  return {
    task: {
      repoOwner: task.repoOwner,
      repoName: task.repoName,
      issueNumber: task.issueNumber,
      issueUrl: `https://github.com/${task.repoOwner}/${task.repoName}/issues/${String(task.issueNumber)}`,
      title: task.title,
    },
    attempt: {
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      state: attempt.state,
      outcome: attempt.outcome,
      outcomeReason: attempt.outcomeReason,
      prUrl: attempt.prUrl,
      prNumber: attempt.prNumber,
      prState: attempt.prState,
      prHeadSha: attempt.prHeadSha,
    },
    projection: { state: projection.state, reason: projection.reason },
    approvalStatus: status,
    candidate: {
      source: attempt.verificationCandidateSource,
      shell: attempt.verificationCandidateShell,
      script: attempt.verificationCandidateScript,
      sha256: attempt.verificationCandidateSha256,
      updatedAt: attempt.verificationCandidateUpdatedAt,
    },
    approved: {
      sha256: attempt.verificationApprovedSha256,
      shell: attempt.verificationApprovedShell,
      script: attempt.verificationApprovedScript,
      approvedBy: attempt.verificationApprovedBy,
      approvedAt: attempt.verificationApprovedAt,
    },
    agentTestsRun: (attempt.agentTestsRun ?? []).map((test) => ({
      command: test.command,
      result: test.result,
      ...(test.notes === undefined ? {} : { notes: test.notes }),
    })),
    verifications: listVerifications(attempt.id, db).map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      reason: row.reason,
      headSha: row.headSha,
      specSha256: row.specSha256,
      exitCode: row.exitCode,
      evidenceUrl: row.evidenceUrl,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      createdAt: row.createdAt,
      stale: row.headSha !== attempt.prHeadSha,
    })),
    rerunAvailable: rerunUnavailableReason === null,
    rerunUnavailableReason,
  };
}

function sendPage(
  reply: FastifyReply,
  view: OperatorVerificationView,
  status = 200,
  notice?: { level: 'error' | 'info'; message: string }
) {
  reply.type('text/html; charset=utf-8');
  return reply.code(status).send(renderOperatorVerificationPage(view, notice));
}

export const operatorVerificationRoutes: FastifyPluginCallback<OperatorVerificationRouteOptions> = (
  fastify: FastifyInstance,
  opts: OperatorVerificationRouteOptions,
  done
) => {
  const db = opts.db ?? getDb();
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body)));
    }
  );

  fastify.get('/operator/attempts/:attemptId/verification', async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_attempt_id' });
    const view = loadView(parsed.data.attemptId, db, opts);
    if (!view) return reply.code(404).send({ error: 'attempt_or_task_not_found' });
    reply.header('Cache-Control', 'no-store');
    return sendPage(reply, view);
  });

  fastify.post('/operator/attempts/:attemptId/verification/propose', (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) return reply.code(400).send({ error: 'invalid_attempt_id' });
    const view = loadView(parsedParams.data.attemptId, db, opts);
    if (!view) return reply.code(404).send({ error: 'attempt_or_task_not_found' });
    const parsedBody = proposalSchema.safeParse(bodyObject(request.body));
    if (!parsedBody.success)
      return sendPage(reply, view, 400, {
        level: 'error',
        message:
          'Invalid proposal: shell must be sh or bash and script must be 1–65536 characters.',
      });
    try {
      setVerificationCandidate(parsedParams.data.attemptId, parsedBody.data, 'operator', db);
      return reply
        .code(303)
        .header(
          'Location',
          `/operator/attempts/${String(parsedParams.data.attemptId)}/verification`
        )
        .send();
    } catch (error: unknown) {
      const current = loadView(parsedParams.data.attemptId, db, opts);
      if (!current) return reply.code(404).send({ error: 'attempt_or_task_not_found' });
      if (error instanceof AttemptCompletedError)
        return sendPage(reply, current, 409, { level: 'error', message: error.message });
      throw error;
    }
  });

  fastify.post('/operator/attempts/:attemptId/verification/approve', (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) return reply.code(400).send({ error: 'invalid_attempt_id' });
    const view = loadView(parsedParams.data.attemptId, db, opts);
    if (!view) return reply.code(404).send({ error: 'attempt_or_task_not_found' });
    const parsedBody = approvalSchema.safeParse(bodyObject(request.body));
    if (!parsedBody.success)
      return sendPage(reply, view, 400, { level: 'error', message: 'Invalid spec_sha256.' });
    try {
      approveVerificationSpec(
        parsedParams.data.attemptId,
        parsedBody.data.spec_sha256,
        'operator',
        db
      );
      return reply
        .code(303)
        .header(
          'Location',
          `/operator/attempts/${String(parsedParams.data.attemptId)}/verification`
        )
        .send();
    } catch (error: unknown) {
      const current = loadView(parsedParams.data.attemptId, db, opts);
      if (!current) return reply.code(404).send({ error: 'attempt_or_task_not_found' });
      if (error instanceof VerificationSpecMismatchError)
        return sendPage(reply, current, 409, {
          level: 'error',
          message: 'Candidate changed since this page was rendered; review the current candidate.',
        });
      if (error instanceof AttemptCompletedError)
        return sendPage(reply, current, 409, { level: 'error', message: error.message });
      throw error;
    }
  });

  fastify.post('/operator/attempts/:attemptId/verification/rerun', async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) return reply.code(400).send({ error: 'invalid_attempt_id' });
    const view = loadView(parsedParams.data.attemptId, db, opts);
    if (!view) return reply.code(404).send({ error: 'attempt_or_task_not_found' });
    if (opts.verification === undefined)
      return sendPage(reply, view, 503, {
        level: 'error',
        message: 'verification_disabled: browser reruns are disabled by VERIFICATION_ENABLED.',
      });
    const github = opts.getGitHubClient();
    if (github === undefined)
      return sendPage(reply, view, 503, {
        level: 'error',
        message: 'github_unavailable: configure GITHUB_TOKEN before rerunning verification.',
      });
    const rerun = opts.rerun ?? rerunApprovedVerification;
    const result: RerunVerificationResult = await rerun(parsedParams.data.attemptId, {
      ...opts.verification,
      github,
      logger: opts.logger,
      db,
    });
    if (!result.ok)
      return sendPage(reply, view, 409, {
        level: 'error',
        message: `Rerun unavailable: ${result.reason}`,
      });
    const current = loadView(parsedParams.data.attemptId, db, opts);
    if (!current) return reply.code(404).send({ error: 'attempt_or_task_not_found' });
    return sendPage(reply, current, 200, {
      level: 'info',
      message: `Rerun decision: ${result.decision}`,
    });
  });
  done();
};
