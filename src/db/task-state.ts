import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { getDb } from './client.js';
import {
  attempts,
  type Attempt,
  type AttemptOutcome,
  type AttemptState,
  tasks,
  type Task,
} from './schema.js';

type Db = ReturnType<typeof getDb>;
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

function identityWhere(input: TaskIdentityInput) {
  const identity = normalizeIdentity(input);
  return and(
    eq(tasks.repoOwner, identity.repoOwner),
    eq(tasks.repoName, identity.repoName),
    eq(tasks.issueNumber, identity.issueNumber)
  );
}

export const ALLOWED_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  pending: ['dispatching'],
  dispatching: ['session_created', 'completed'],
  session_created: ['running', 'completed'],
  running: ['completed'],
  completed: [],
};

export class InvalidTransitionError extends Error {
  constructor(attemptId: number, from: AttemptState, to: AttemptState) {
    super(`Invalid transition for attempt ${String(attemptId)}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

function requireAttempt(attemptId: number, db: Db): Attempt {
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
  db: Db
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

export function upsertTask(input: TaskIdentityInput & { title?: string }, db: Db = getDb()): Task {
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

export function createAttempt(taskId: number, db: Db = getDb()): Attempt {
  return db.transaction((tx) => {
    const current = tx
      .select({ maxAttemptNumber: max(attempts.attemptNumber) })
      .from(attempts)
      .where(eq(attempts.taskId, taskId))
      .get();
    const timestamp = Date.now();
    return tx
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
  });
}

export function markDispatching(attemptId: number, db: Db = getDb()): Attempt {
  return transitionAttempt(attemptId, 'dispatching', { dispatchedAt: Date.now() }, db);
}

export function markSessionCreated(
  attemptId: number,
  input: { devinSessionId: string; devinSessionUrl?: string },
  db: Db = getDb()
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

export function markRunning(attemptId: number, db: Db = getDb()): Attempt {
  return transitionAttempt(attemptId, 'running', {}, db);
}

export function setPrUrl(attemptId: number, prUrl: string, db: Db = getDb()): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (attempt.state === 'completed') {
    throw new InvalidTransitionError(attemptId, attempt.state, attempt.state);
  }
  const result = db
    .update(attempts)
    .set({ prUrl, updatedAt: Date.now() })
    .where(and(eq(attempts.id, attemptId), eq(attempts.state, attempt.state)))
    .run();
  if (result.changes !== 1) {
    throw new InvalidTransitionError(attemptId, attempt.state, attempt.state);
  }
  return requireAttempt(attemptId, db);
}

export function completeAttempt(
  attemptId: number,
  outcome: AttemptOutcome,
  db: Db = getDb()
): Attempt {
  const attempt = requireAttempt(attemptId, db);
  if (outcome === 'succeeded' && attempt.devinSessionId === null) {
    throw new InvalidTransitionError(attemptId, attempt.state, 'completed');
  }
  return transitionAttempt(
    attemptId,
    'completed',
    {
      outcome,
      completedAt: Date.now(),
    },
    db
  );
}

export function getTaskByIdentity(input: TaskIdentityInput, db: Db = getDb()): Task | undefined {
  return db.select().from(tasks).where(identityWhere(input)).get();
}

export function getAttempt(attemptId: number, db: Db = getDb()): Attempt | undefined {
  return db.select().from(attempts).where(eq(attempts.id, attemptId)).get();
}

export function getAttemptByCorrelationId(
  correlationId: string,
  db: Db = getDb()
): Attempt | undefined {
  return db.select().from(attempts).where(eq(attempts.correlationId, correlationId)).get();
}

export function listAttempts(taskId: number, db: Db = getDb()): Attempt[] {
  return db
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, taskId))
    .orderBy(asc(attempts.attemptNumber))
    .all();
}

export function findStaleDispatchingAttempts(db: Db = getDb()): Attempt[] {
  return db
    .select()
    .from(attempts)
    .where(and(eq(attempts.state, 'dispatching'), isNull(attempts.devinSessionId)))
    .all();
}
