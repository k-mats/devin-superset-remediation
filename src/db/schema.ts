import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
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
    prVerifiedLabel: text('pr_verified_label'),
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
    verificationCandidateShell: text('verification_candidate_shell').$type<'bash' | 'sh'>(),
    verificationCandidateScript: text('verification_candidate_script'),
    verificationCandidateSha256: text('verification_candidate_sha256'),
    verificationCandidateSource: text(
      'verification_candidate_source'
    ).$type<VerificationCandidateSource>(),
    verificationCandidateUpdatedAt: integer('verification_candidate_updated_at'),
    verificationApprovedShell: text('verification_approved_shell').$type<'bash' | 'sh'>(),
    verificationApprovedScript: text('verification_approved_script'),
    verificationApprovedSha256: text('verification_approved_sha256'),
    verificationApprovedAt: integer('verification_approved_at'),
    verificationApprovedBy: text('verification_approved_by'),
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
    check(
      'attempts_verification_candidate_source_check',
      sql`${table.verificationCandidateSource} IS NULL OR ${table.verificationCandidateSource} IN ('issue_verification_section', 'agent_tests_run', 'operator')`
    ),
    check(
      'attempts_verification_candidate_shell_check',
      sql`${table.verificationCandidateShell} IS NULL OR ${table.verificationCandidateShell} IN ('bash', 'sh')`
    ),
    check(
      'attempts_verification_approved_shell_check',
      sql`${table.verificationApprovedShell} IS NULL OR ${table.verificationApprovedShell} IN ('bash', 'sh')`
    ),
    check(
      'attempts_verification_candidate_check',
      sql`(${table.verificationCandidateSha256} IS NULL) = (${table.verificationCandidateShell} IS NULL) AND (${table.verificationCandidateSha256} IS NULL) = (${table.verificationCandidateScript} IS NULL) AND (${table.verificationCandidateSha256} IS NULL) = (${table.verificationCandidateSource} IS NULL) AND (${table.verificationCandidateSha256} IS NULL) = (${table.verificationCandidateUpdatedAt} IS NULL)`
    ),
    check(
      'attempts_verification_approved_check',
      sql`(${table.verificationApprovedSha256} IS NULL) = (${table.verificationApprovedShell} IS NULL) AND (${table.verificationApprovedSha256} IS NULL) = (${table.verificationApprovedScript} IS NULL) AND (${table.verificationApprovedSha256} IS NULL) = (${table.verificationApprovedAt} IS NULL) AND (${table.verificationApprovedSha256} IS NULL) = (${table.verificationApprovedBy} IS NULL)`
    ),
  ]
);

export const VERIFICATION_CANDIDATE_SOURCES = [
  'issue_verification_section',
  'agent_tests_run',
  'operator',
] as const;
export const verificationCandidateSourceSchema = z.enum(VERIFICATION_CANDIDATE_SOURCES);
export type VerificationCandidateSource = z.infer<typeof verificationCandidateSourceSchema>;

export const VERIFICATION_KINDS = ['command', 'github_checks'] as const;
export const verificationKindSchema = z.enum(VERIFICATION_KINDS);
export type VerificationKind = z.infer<typeof verificationKindSchema>;

export const VERIFICATION_STATUSES = ['passed', 'failed', 'unverified', 'error'] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const verifications = sqliteTable(
  'verifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    attemptId: integer('attempt_id')
      .notNull()
      .references(() => attempts.id, { onDelete: 'restrict' }),
    headSha: text('head_sha').notNull(),
    kind: text('kind').$type<VerificationKind>().notNull(),
    status: text('status').$type<VerificationStatus>().notNull(),
    reason: text('reason'),
    specShell: text('spec_shell').$type<'bash' | 'sh'>(),
    specScript: text('spec_script'),
    specSha256: text('spec_sha256'),
    exitCode: integer('exit_code'),
    evidenceUrl: text('evidence_url'),
    evidenceSummary: text('evidence_summary'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('verifications_attempt_head_kind_index').on(table.attemptId, table.headSha, table.kind),
    check('verifications_kind_check', sql`${table.kind} IN ('command', 'github_checks')`),
    check(
      'verifications_status_check',
      sql`${table.status} IN ('passed', 'failed', 'unverified', 'error')`
    ),
    check(
      'verifications_spec_shell_check',
      sql`${table.specShell} IS NULL OR ${table.specShell} IN ('bash', 'sh')`
    ),
  ]
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Attempt = typeof attempts.$inferSelect;
export type NewAttempt = typeof attempts.$inferInsert;
export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
