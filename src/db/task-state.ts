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

  db.update(attempts)
    .set({ ...fields, state: to, updatedAt: Date.now() })
    .where(eq(attempts.id, attemptId))
    .run();
  return requireAttempt(attemptId, db);
}

export function upsertTask(
  input: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
    title?: string;
  },
  db: Db = getDb()
): Task {
  const timestamp = Date.now();
  db.insert(tasks)
    .values({
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      issueNumber: input.issueNumber,
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [tasks.repoOwner, tasks.repoName, tasks.issueNumber],
      set: { title: input.title ?? null, updatedAt: timestamp },
    })
    .run();

  const task = db
    .select()
    .from(tasks)
    .where(eq(tasks.issueNumber, input.issueNumber))
    .all()
    .find(
      (candidate) =>
        candidate.repoOwner === input.repoOwner && candidate.repoName === input.repoName
    );
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
  db.update(attempts).set({ prUrl, updatedAt: Date.now() }).where(eq(attempts.id, attemptId)).run();
  return requireAttempt(attemptId, db);
}

export function completeAttempt(
  attemptId: number,
  outcome: AttemptOutcome,
  db: Db = getDb()
): Attempt {
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

export function getTaskByIdentity(
  input: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
  },
  db: Db = getDb()
): Task | undefined {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.issueNumber, input.issueNumber))
    .all()
    .find((task) => task.repoOwner === input.repoOwner && task.repoName === input.repoName);
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
