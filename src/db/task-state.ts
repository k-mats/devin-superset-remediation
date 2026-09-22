import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, max, ne, or } from 'drizzle-orm';
import Database, { type RunResult } from 'better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { getDb } from './client.js';
import type { StructuredOutput } from '../devin/structured-output.js';
import {
  attempts,
  type Attempt,
  type AttemptOutcome,
  type AttemptState,
  tasks,
  type Task,
  type Verification,
  type VerificationCandidateSource,
  type VerificationKind,
  verifications,
} from './schema.js';
import { hashVerificationSpec, type VerificationShell } from '../verification/spec.js';

export type Db = ReturnType<typeof getDb>;
export type DbExecutor = BaseSQLiteDatabase<'sync', RunResult, Record<string, unknown>>;
type TaskIdentityInput = {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
};

function normalizeIdentity(input: TaskIdentityInput): TaskIdentityInput {
  return {
    repoOwner: input.repoOwner.toLowerCase(),
    repoName: input.repoName.toLowerCase(),
    issueNumber: input.issueNumber,
  };
}

function normalizePullRequestUrl(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

function identityWhere(input: TaskIdentityInput) {
  const identity = normalizeIdentity(input);
  return and(
    eq(tasks.repoOwner, identity.repoOwner),
    eq(tasks.repoName, identity.repoName),
    eq(tasks.issueNumber, identity.issueNumber)
  );
}

export const ALLOWED_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  pending: ['dispatching', 'completed'],
  dispatching: ['pending', 'session_created', 'completed'],
  session_created: ['running', 'verifying', 'completed'],
  running: ['verifying', 'completed'],
  verifying: ['completed'],
  completed: [],
};

export class InvalidTransitionError extends Error {
  constructor(attemptId: number, from: AttemptState, to: AttemptState) {
    super(`Invalid transition for attempt ${String(attemptId)}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class StructuredOutputAlreadyAcceptedError extends Error {
  constructor(attemptId: number) {
    super(`Attempt ${String(attemptId)} already has an accepted structured output`);
    this.name = 'StructuredOutputAlreadyAcceptedError';
  }
}

export class ActiveAttemptExistsError extends Error {
  constructor(taskId: number) {
    super(`Task ${String(taskId)} already has an active attempt`);
    this.name = 'ActiveAttemptExistsError';
  }
}

export class PullRequestMismatchError extends Error {
  constructor(attemptId: number) {
    super(`Pull request identity changed for attempt ${String(attemptId)}`);
    this.name = 'PullRequestMismatchError';
  }
}

function requireAttempt(attemptId: number, db: DbExecutor): Attempt {
  const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
  if (!attempt) {
    throw new Error(`Attempt ${String(attemptId)} not found`);
  }
  return attempt;
}

function transitionAttempt(
  attemptId: number,
  to: AttemptState,
  fields: Partial<typeof attempts.$inferInsert> = {},
  db: DbExecutor
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (!ALLOWED_TRANSITIONS[attempt.state].includes(to)) {
    throw new InvalidTransitionError(attemptId, attempt.state, to);
  }

  const result = db
    .update(attempts)
    .set({ ...fields, state: to, updatedAt: Date.now() })
    .where(and(eq(attempts.id, attemptId), eq(attempts.state, attempt.state)))
    .run();
  if (result.changes !== 1) {
    throw new InvalidTransitionError(attemptId, attempt.state, to);
  }
  return requireAttempt(attemptId, db);
}

export function upsertTask(
  input: TaskIdentityInput & { title?: string },
  db: DbExecutor = getDb()
): Task {
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('Issue number must be a positive integer');
  }
  const timestamp = Date.now();
  const identity = normalizeIdentity(input);
  const set: { updatedAt: number; title?: string | null } = { updatedAt: timestamp };
  if (input.title !== undefined) {
    set.title = input.title;
  }
  db.insert(tasks)
    .values({
      repoOwner: identity.repoOwner,
      repoName: identity.repoName,
      issueNumber: identity.issueNumber,
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [tasks.repoOwner, tasks.repoName, tasks.issueNumber],
      set,
    })
    .run();

  const task = db.select().from(tasks).where(identityWhere(identity)).get();
  if (!task) {
    throw new Error('Task could not be persisted');
  }
  return task;
}

export function createAttempt(taskId: number, db: DbExecutor = getDb()): Attempt {
  try {
    const current = db
      .select({ maxAttemptNumber: max(attempts.attemptNumber) })
      .from(attempts)
      .where(eq(attempts.taskId, taskId))
      .get();
    const timestamp = Date.now();
    return db
      .insert(attempts)
      .values({
        taskId,
        attemptNumber: (current?.maxAttemptNumber ?? 0) + 1,
        correlationId: randomUUID(),
        state: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
  } catch (error: unknown) {
    if (
      error instanceof Database.SqliteError &&
      error.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      // The partial index reports only its single indexed column;
      // attempts_task_attempt_unique would also list attempt_number.
      error.message === 'UNIQUE constraint failed: attempts.task_id'
    ) {
      throw new ActiveAttemptExistsError(taskId);
    }
    throw error;
  }
}

export function claimAttemptForDispatch(
  attemptId: number,
  db: DbExecutor = getDb()
): Attempt | undefined {
  const timestamp = Date.now();
  const result = db
    .update(attempts)
    .set({ state: 'dispatching', dispatchedAt: timestamp, updatedAt: timestamp })
    .where(and(eq(attempts.id, attemptId), eq(attempts.state, 'pending')))
    .run();
  if (result.changes !== 1) {
    return undefined;
  }
  return db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
}

export function releaseDispatchClaim(
  attemptId: number,
  db: DbExecutor = getDb()
): Attempt | undefined {
  const result = db
    .update(attempts)
    .set({ state: 'pending', dispatchedAt: null, updatedAt: Date.now() })
    .where(
      and(
        eq(attempts.id, attemptId),
        eq(attempts.state, 'dispatching'),
        isNull(attempts.devinSessionId)
      )
    )
    .run();
  if (result.changes !== 1) {
    return undefined;
  }
  return db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
}

export class AttemptNotRequeueableError extends Error {
  constructor(attemptId: number, state: AttemptState, hasSession: boolean) {
    super(
      `Attempt ${String(attemptId)} cannot be requeued: state '${state}'${hasSession ? ' with a Devin session' : ''}; only 'dispatching' attempts without a Devin session are eligible`
    );
    this.name = 'AttemptNotRequeueableError';
  }
}

export const REQUEUE_OUTCOME_REASON = 'operator_requeue_dispatch_failed';

/**
 * Operator recovery for a dispatch that failed without ever creating a Devin
 * session: the stuck `dispatching` attempt is completed as `failed` and a new
 * `pending` attempt (fresh correlation id) is created for the same task so the
 * dispatch poller retries it. Runs in one transaction.
 */
export function requeueDispatchFailedAttempt(
  attemptId: number,
  db: Db = getDb()
): { failed: Attempt; requeued: Attempt } {
  return db.transaction((tx) => {
    const attempt = requireAttempt(attemptId, tx);
    if (attempt.state !== 'dispatching' || attempt.devinSessionId !== null) {
      throw new AttemptNotRequeueableError(
        attemptId,
        attempt.state,
        attempt.devinSessionId !== null
      );
    }
    const failed = completeAttempt(attemptId, 'failed', { reason: REQUEUE_OUTCOME_REASON }, tx);
    const requeued = createAttempt(attempt.taskId, tx);
    return { failed, requeued };
  });
}

export function markDispatching(attemptId: number, db: DbExecutor = getDb()): Attempt {
  const claimed = claimAttemptForDispatch(attemptId, db);
  if (!claimed) {
    const attempt = requireAttempt(attemptId, db);
    throw new InvalidTransitionError(attemptId, attempt.state, 'dispatching');
  }
  return claimed;
}

export function markSessionCreated(
  attemptId: number,
  input: { devinSessionId: string; devinSessionUrl?: string },
  db: DbExecutor = getDb()
): Attempt {
  return transitionAttempt(
    attemptId,
    'session_created',
    {
      devinSessionId: input.devinSessionId,
      devinSessionUrl: input.devinSessionUrl,
      sessionCreatedAt: Date.now(),
    },
    db
  );
}

export function markRunning(attemptId: number, db: DbExecutor = getDb()): Attempt {
  return transitionAttempt(attemptId, 'running', {}, db);
}

export function markVerifying(attemptId: number, db: DbExecutor = getDb()): Attempt {
  return transitionAttempt(attemptId, 'verifying', {}, db);
}

export function recordSessionSnapshot(
  attemptId: number,
  input: {
    status: string;
    statusDetail: string | null | undefined;
    acusConsumed: number | null | undefined;
    sessionUpdatedAt: number;
  },
  db: DbExecutor = getDb()
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (attempt.devinSessionId === null) {
    throw new Error(`Attempt ${String(attemptId)} has no Devin session id`);
  }
  const result = db
    .update(attempts)
    .set({
      devinSessionStatus: input.status,
      devinSessionStatusDetail: input.statusDetail ?? null,
      acusConsumed: input.acusConsumed ?? null,
      sessionUpdatedAt: input.sessionUpdatedAt,
      sessionLastPolledAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(attempts.id, attemptId))
    .run();
  if (result.changes !== 1) {
    throw new Error(`Attempt ${String(attemptId)} could not be updated`);
  }
  return requireAttempt(attemptId, db);
}

export function recordPullRequest(
  attemptId: number,
  input: {
    prUrl: string;
    prNumber: number;
    prState: 'open' | 'closed' | 'merged';
    prHeadSha: string;
  },
  db: DbExecutor = getDb()
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (
    (attempt.prNumber !== null && attempt.prNumber !== input.prNumber) ||
    (attempt.prUrl !== null &&
      normalizePullRequestUrl(attempt.prUrl) !== normalizePullRequestUrl(input.prUrl))
  ) {
    throw new PullRequestMismatchError(attemptId);
  }
  const now = Date.now();
  const result = db
    .update(attempts)
    .set({
      prUrl: input.prUrl,
      prNumber: input.prNumber,
      prState: input.prState,
      prHeadSha: input.prHeadSha,
      prLastCheckedAt: now,
      updatedAt: now,
    })
    .where(eq(attempts.id, attemptId))
    .run();
  if (result.changes !== 1) {
    throw new Error(`Attempt ${String(attemptId)} could not be updated`);
  }
  return requireAttempt(attemptId, db);
}

export function recordStructuredOutput(
  attemptId: number,
  input: { raw: unknown; parsed: StructuredOutput | undefined },
  db: DbExecutor = getDb()
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (attempt.structuredOutputAcceptedAt !== null) {
    throw new StructuredOutputAlreadyAcceptedError(attemptId);
  }
  if (attempt.state === 'completed') {
    throw new InvalidTransitionError(attemptId, attempt.state, attempt.state);
  }
  const parsed = input.parsed;
  const set: Partial<typeof attempts.$inferInsert> = {
    structuredOutputRaw:
      input.raw === undefined || input.raw === null ? null : JSON.stringify(input.raw),
    agentOutcome: parsed?.outcome ?? null,
    agentPrUrl: parsed?.pr_url ?? null,
    agentDiagnosis: parsed?.diagnosis ?? null,
    agentTestsRun: parsed?.tests_run ?? null,
    agentRisks: parsed?.risks ?? null,
    needsHumanReason: parsed?.needs_human_reason ?? null,
    updatedAt: Date.now(),
  };
  if (parsed !== undefined) {
    set.structuredOutputAcceptedAt = Date.now();
  }
  const result = db
    .update(attempts)
    .set(set)
    .where(
      and(
        eq(attempts.id, attemptId),
        eq(attempts.state, attempt.state),
        isNull(attempts.structuredOutputAcceptedAt)
      )
    )
    .run();
  if (result.changes !== 1) {
    const current = db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
    if (current !== undefined && current.structuredOutputAcceptedAt !== null) {
      throw new StructuredOutputAlreadyAcceptedError(attemptId);
    }
    throw new InvalidTransitionError(attemptId, attempt.state, attempt.state);
  }
  return requireAttempt(attemptId, db);
}

export function completeAttempt(
  attemptId: number,
  outcome: AttemptOutcome,
  opts: { reason?: string } = {},
  db: DbExecutor = getDb()
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (outcome === 'succeeded') {
    throw new InvalidTransitionError(attemptId, attempt.state, 'completed');
  }
  return transitionAttempt(
    attemptId,
    'completed',
    {
      outcome,
      outcomeReason: opts.reason,
      completedAt: Date.now(),
    },
    db
  );
}

export function completeVerifiedAttempt(
  attemptId: number,
  input: { headSha: string; specSha256: string },
  db: DbExecutor = getDb()
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  const latestRow = db
    .select()
    .from(verifications)
    .where(
      and(
        eq(verifications.attemptId, attemptId),
        eq(verifications.headSha, input.headSha),
        eq(verifications.kind, 'command'),
        eq(verifications.specSha256, input.specSha256)
      )
    )
    .orderBy(desc(verifications.createdAt), desc(verifications.id))
    .limit(1)
    .get();
  if (
    attempt.state !== 'verifying' ||
    attempt.devinSessionId === null ||
    attempt.prHeadSha !== input.headSha ||
    attempt.verificationCandidateSha256 !== input.specSha256 ||
    attempt.verificationApprovedSha256 !== input.specSha256 ||
    latestRow?.status !== 'passed'
  ) {
    throw new InvalidTransitionError(attemptId, attempt.state, 'completed');
  }
  return transitionAttempt(
    attemptId,
    'completed',
    {
      outcome: 'succeeded',
      outcomeReason: `independent_verification_passed: ${input.headSha}`,
      completedAt: Date.now(),
    },
    db
  );
}

export class VerificationSpecMismatchError extends Error {
  constructor(attemptId: number) {
    super(
      `Verification spec hash does not match the current candidate for attempt ${String(attemptId)}`
    );
    this.name = 'VerificationSpecMismatchError';
  }
}

export class AttemptCompletedError extends Error {
  constructor(attemptId: number) {
    super(`Attempt ${String(attemptId)} is completed; verification spec cannot be changed`);
    this.name = 'AttemptCompletedError';
  }
}

export function setVerificationCandidate(
  attemptId: number,
  spec: { shell: VerificationShell; script: string },
  source: VerificationCandidateSource,
  db: DbExecutor = getDb()
): Attempt {
  const sha256 = hashVerificationSpec(spec.shell, spec.script);
  const attempt = requireAttempt(attemptId, db);
  if (attempt.state === 'completed') {
    throw new AttemptCompletedError(attemptId);
  }
  if (
    attempt.verificationCandidateSha256 === sha256 &&
    (source !== 'operator' || attempt.verificationCandidateSource === 'operator')
  ) {
    return attempt;
  }
  // An equal-hash operator proposal falls through to promote the candidate's source.
  const timestamp = Date.now();
  const result = db
    .update(attempts)
    .set({
      verificationCandidateShell: spec.shell,
      verificationCandidateScript: spec.script,
      verificationCandidateSha256: sha256,
      verificationCandidateSource: source,
      verificationCandidateUpdatedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(and(eq(attempts.id, attemptId), ne(attempts.state, 'completed')))
    .run();
  if (result.changes !== 1) {
    const current = requireAttempt(attemptId, db);
    if (current.state === 'completed') {
      throw new AttemptCompletedError(attemptId);
    }
    throw new Error(`Attempt ${String(attemptId)} could not be updated`);
  }
  return requireAttempt(attemptId, db);
}

export function clearVerificationCandidate(
  attemptId: number,
  opts: { onlySource?: VerificationCandidateSource } = {},
  db: DbExecutor = getDb()
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (attempt.state === 'completed') {
    throw new AttemptCompletedError(attemptId);
  }
  const timestamp = Date.now();
  const result = db
    .update(attempts)
    .set({
      verificationCandidateShell: null,
      verificationCandidateScript: null,
      verificationCandidateSha256: null,
      verificationCandidateSource: null,
      verificationCandidateUpdatedAt: null,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(attempts.id, attemptId),
        ne(attempts.state, 'completed'),
        opts.onlySource ? eq(attempts.verificationCandidateSource, opts.onlySource) : undefined
      )
    )
    .run();
  if (result.changes === 0) {
    const current = requireAttempt(attemptId, db);
    if (current.state === 'completed') {
      throw new AttemptCompletedError(attemptId);
    }
    return current;
  }
  return requireAttempt(attemptId, db);
}

export function approveVerificationSpec(
  attemptId: number,
  specSha256: string,
  approvedBy: string,
  db: DbExecutor = getDb()
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (attempt.state === 'completed') {
    throw new AttemptCompletedError(attemptId);
  }
  if (
    attempt.verificationCandidateSha256 === null ||
    attempt.verificationCandidateSha256 !== specSha256
  ) {
    throw new VerificationSpecMismatchError(attemptId);
  }
  const timestamp = Date.now();
  const result = db
    .update(attempts)
    .set({
      verificationApprovedShell: attempt.verificationCandidateShell,
      verificationApprovedScript: attempt.verificationCandidateScript,
      verificationApprovedSha256: attempt.verificationCandidateSha256,
      verificationApprovedAt: timestamp,
      verificationApprovedBy: approvedBy,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(attempts.id, attemptId),
        ne(attempts.state, 'completed'),
        eq(attempts.verificationCandidateSha256, specSha256)
      )
    )
    .run();
  if (result.changes !== 1) {
    const current = requireAttempt(attemptId, db);
    if (current.state === 'completed') {
      throw new AttemptCompletedError(attemptId);
    }
    throw new VerificationSpecMismatchError(attemptId);
  }
  return requireAttempt(attemptId, db);
}

export function recordVerification(
  input: {
    attemptId: number;
    headSha: string;
    kind: VerificationKind;
    status: Verification['status'];
    reason?: string | null;
    specShell?: Verification['specShell'];
    specScript?: string | null;
    specSha256?: string | null;
    exitCode?: number | null;
    evidenceUrl?: string | null;
    evidenceSummary?: string | null;
    startedAt?: number | null;
    finishedAt?: number | null;
  },
  db: DbExecutor = getDb()
): Verification {
  return db
    .insert(verifications)
    .values({
      attemptId: input.attemptId,
      headSha: input.headSha,
      kind: input.kind,
      status: input.status,
      reason: input.reason ?? null,
      specShell: input.specShell ?? null,
      specScript: input.specScript ?? null,
      specSha256: input.specSha256 ?? null,
      exitCode: input.exitCode ?? null,
      evidenceUrl: input.evidenceUrl ?? null,
      evidenceSummary: input.evidenceSummary ?? null,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

export function listVerifications(attemptId: number, db: DbExecutor = getDb()): Verification[] {
  return db
    .select()
    .from(verifications)
    .where(eq(verifications.attemptId, attemptId))
    .orderBy(asc(verifications.createdAt), asc(verifications.id))
    .all();
}

export function findLatestVerification(
  attemptId: number,
  headSha: string,
  kind: VerificationKind,
  db: DbExecutor = getDb()
): Verification | undefined {
  return db
    .select()
    .from(verifications)
    .where(
      and(
        eq(verifications.attemptId, attemptId),
        eq(verifications.headSha, headSha),
        eq(verifications.kind, kind)
      )
    )
    .orderBy(desc(verifications.createdAt), desc(verifications.id))
    .limit(1)
    .get();
}

export function getTaskByIdentity(
  input: TaskIdentityInput,
  db: DbExecutor = getDb()
): Task | undefined {
  return db.select().from(tasks).where(identityWhere(input)).get();
}

export function getTaskById(taskId: number, db: DbExecutor = getDb()): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).get();
}

export function getAttempt(attemptId: number, db: DbExecutor = getDb()): Attempt | undefined {
  return db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
}

export function getAttemptByCorrelationId(
  correlationId: string,
  db: DbExecutor = getDb()
): Attempt | undefined {
  return db.select().from(attempts).where(eq(attempts.correlationId, correlationId)).get();
}

export function listAttempts(taskId: number, db: DbExecutor = getDb()): Attempt[] {
  return db
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, taskId))
    .orderBy(asc(attempts.attemptNumber))
    .all();
}

export function findPendingAttempts(
  db: DbExecutor = getDb()
): Array<{ attempt: Attempt; task: Task }> {
  return db
    .select({ attempt: attempts, task: tasks })
    .from(attempts)
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(eq(attempts.state, 'pending'))
    .orderBy(asc(attempts.createdAt), asc(attempts.id))
    .all();
}

export function findUncertainDispatchCandidates(
  dispatchedBefore: number,
  db: DbExecutor = getDb()
): Array<{ attempt: Attempt; task: Task }> {
  return db
    .select({ attempt: attempts, task: tasks })
    .from(attempts)
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(
      and(
        eq(attempts.state, 'dispatching'),
        isNull(attempts.devinSessionId),
        isNotNull(attempts.dispatchedAt),
        lte(attempts.dispatchedAt, dispatchedBefore)
      )
    )
    .orderBy(asc(attempts.createdAt), asc(attempts.id))
    .all();
}

export function findStaleDispatchingAttempts(db: DbExecutor = getDb()): Attempt[] {
  return db
    .select()
    .from(attempts)
    .where(and(eq(attempts.state, 'dispatching'), isNull(attempts.devinSessionId)))
    .all();
}

export function findTrackableAttempts(
  db: DbExecutor = getDb()
): Array<{ attempt: Attempt; task: Task }> {
  return db
    .select({ attempt: attempts, task: tasks })
    .from(attempts)
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(
      and(
        isNull(attempts.outcome),
        isNotNull(attempts.devinSessionId),
        inArray(attempts.state, ['session_created', 'running', 'verifying'])
      )
    )
    .orderBy(asc(attempts.createdAt), asc(attempts.id))
    .all();
}

export function findCompletedAttemptsWithTrackedPullRequests(
  db: DbExecutor = getDb()
): Array<{ attempt: Attempt; task: Task }> {
  return db
    .select({ attempt: attempts, task: tasks })
    .from(attempts)
    .innerJoin(tasks, eq(attempts.taskId, tasks.id))
    .where(
      and(
        eq(attempts.state, 'completed'),
        isNotNull(attempts.prNumber),
        or(isNull(attempts.prState), eq(attempts.prState, 'open'))
      )
    )
    .orderBy(asc(attempts.createdAt), asc(attempts.id))
    .all();
}
