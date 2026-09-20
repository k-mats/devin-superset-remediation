import { sql } from 'drizzle-orm';
import { check, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import type { AgentOutcome, StructuredOutput } from '../devin/structured-output.js';

export const ATTEMPT_STATES = [
  'pending',
  'dispatching',
  'session_created',
  'running',
  'verifying',
  'completed',
] as const;

export const attemptStateSchema = z.enum(ATTEMPT_STATES);
export type AttemptState = z.infer<typeof attemptStateSchema>;

export const ATTEMPT_OUTCOMES = [
  'succeeded',
  'failed',
  'cancelled',
  'escalated',
  'no_action',
] as const;

export const attemptOutcomeSchema = z.enum(ATTEMPT_OUTCOMES);
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoOwner: text('repo_owner').notNull(),
    repoName: text('repo_name').notNull(),
    issueNumber: integer('issue_number').notNull(),
    title: text('title'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('tasks_identity_unique').on(table.repoOwner, table.repoName, table.issueNumber),
    check('tasks_issue_number_check', sql`${table.issueNumber} > 0`),
  ]
);

export const attempts = sqliteTable(
  'attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    attemptNumber: integer('attempt_number').notNull(),
    correlationId: text('correlation_id').notNull().unique(),
    state: text('state').$type<AttemptState>().notNull().default('pending'),
    outcome: text('outcome').$type<AttemptOutcome>(),
    outcomeReason: text('outcome_reason'),
    devinSessionId: text('devin_session_id').unique(),
    devinSessionUrl: text('devin_session_url'),
    devinSessionStatus: text('devin_session_status'),
    devinSessionStatusDetail: text('devin_session_status_detail'),
    acusConsumed: real('acus_consumed'),
    sessionUpdatedAt: integer('session_updated_at'),
    sessionLastPolledAt: integer('session_last_polled_at'),
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    prState: text('pr_state').$type<'open' | 'closed' | 'merged'>(),
    prHeadSha: text('pr_head_sha'),
    prLastCheckedAt: integer('pr_last_checked_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    dispatchedAt: integer('dispatched_at'),
    sessionCreatedAt: integer('session_created_at'),
    completedAt: integer('completed_at'),
    structuredOutputRaw: text('structured_output_raw'),
    agentOutcome: text('agent_outcome').$type<AgentOutcome>(),
    agentPrUrl: text('agent_pr_url'),
    agentDiagnosis: text('agent_diagnosis'),
    agentTestsRun: text('agent_tests_run', { mode: 'json' }).$type<StructuredOutput['tests_run']>(),
    agentRisks: text('agent_risks', { mode: 'json' }).$type<string[]>(),
    needsHumanReason: text('needs_human_reason'),
    structuredOutputAcceptedAt: integer('structured_output_accepted_at'),
  },
  (table) => [
    uniqueIndex('attempts_task_attempt_unique').on(table.taskId, table.attemptNumber),
    uniqueIndex('attempts_task_active_unique')
      .on(table.taskId)
      .where(
        sql`${table.state} IN ('pending', 'dispatching', 'session_created', 'running', 'verifying')`
      ),
    check('attempts_attempt_number_check', sql`${table.attemptNumber} > 0`),
    check(
      'attempts_state_check',
      sql`${table.state} IN ('pending', 'dispatching', 'session_created', 'running', 'verifying', 'completed')`
    ),
    check(
      'attempts_outcome_check',
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('succeeded', 'failed', 'cancelled', 'escalated', 'no_action')`
    ),
    check(
      'attempts_completed_outcome_check',
      sql`(${table.state} = 'completed') = (${table.outcome} IS NOT NULL)`
    ),
    check(
      'attempts_session_id_check',
      sql`${table.state} NOT IN ('session_created', 'running', 'verifying') OR ${table.devinSessionId} IS NOT NULL`
    ),
    check(
      'attempts_agent_outcome_check',
      sql`${table.agentOutcome} IS NULL OR ${table.agentOutcome} IN ('remediated', 'needs_human', 'no_action')`
    ),
    check(
      'attempts_succeeded_session_check',
      sql`${table.outcome} IS NULL OR ${table.outcome} <> 'succeeded' OR ${table.devinSessionId} IS NOT NULL`
    ),
    check('attempts_pr_fields_check', sql`${table.prNumber} IS NULL OR ${table.prUrl} IS NOT NULL`),
    check(
      'attempts_pr_state_check',
      sql`${table.prState} IS NULL OR ${table.prState} IN ('open', 'closed', 'merged')`
    ),
  ]
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Attempt = typeof attempts.$inferSelect;
export type NewAttempt = typeof attempts.$inferInsert;
