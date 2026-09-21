import { resolve } from 'node:path';
import { asc } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import {
  tasks,
  type Attempt,
  type AttemptOutcome,
  type Verification,
  type VerificationKind,
  type VerificationStatus,
} from '../db/schema.js';
import type { AgentOutcome } from '../devin/structured-output.js';
import {
  findLatestVerification,
  listAttempts,
  listVerifications,
  type DbExecutor,
} from '../db/task-state.js';
import {
  NORMALIZED_TASK_STATES,
  projectTaskState,
  type NormalizedTaskState,
  type TaskStateProjection,
} from '../tracking/normalized-task-state.js';
import { approvalStatus, type ApprovalStatus } from '../verification/approval.js';

export const TASK_BUCKETS = [
  'active',
  'successful',
  'needs_human',
  'failed',
  'no_action',
  'cancelled',
] as const;
export type TaskBucket = (typeof TASK_BUCKETS)[number];

export function bucketForState(state: NormalizedTaskState): TaskBucket {
  switch (state) {
    case 'QUEUED':
    case 'DISPATCHING':
    case 'RUNNING':
    case 'PR_OPEN':
    case 'CI_PENDING':
    case 'VERIFYING':
      return 'active';
    case 'VERIFIED':
      return 'successful';
    case 'NEEDS_HUMAN':
      return 'needs_human';
    case 'FAILED':
    case 'VERIFICATION_FAILED':
      return 'failed';
    case 'NO_ACTION':
      return 'no_action';
    case 'CANCELLED':
      return 'cancelled';
  }
}

export const TERMINAL_BUCKETS: readonly TaskBucket[] = [
  'successful',
  'needs_human',
  'failed',
  'no_action',
  'cancelled',
];

export interface ReportAttemptRow {
  id: number;
  attemptNumber: number;
  correlationId: string;
  state: Attempt['state'];
  outcome: AttemptOutcome | null;
  outcomeReason: string | null;
  devinSessionId: string | null;
  devinSessionUrl: string | null;
  devinSessionStatus: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prState: Attempt['prState'];
  prHeadSha: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  terminalAt: number | null;
  verifiedAt: number | null;
  projection: TaskStateProjection;
}

export interface ReportTaskRow {
  taskId: number;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueUrl: string;
  title: string | null;
  state: NormalizedTaskState;
  reason: string;
  bucket: TaskBucket;
  currentAttempt: ReportAttemptRow;
  attemptCount: number;
  attempts: ReportAttemptRow[];
  devinSessionUrl: string | null;
  prUrl: string | null;
  discoveredAt: number;
  lastUpdatedAt: number;
  terminalAt: number | null;
  verifiedAt: number | null;
}

export interface LedgerVerificationEvidence {
  verificationId: number;
  kind: VerificationKind;
  status: VerificationStatus;
  reason: string | null;
  headSha: string;
  specSha256: string | null;
  exitCode: number | null;
  evidenceUrl: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface LedgerAttemptEvidence {
  attemptId: number;
  attemptNumber: number;
  correlationId: string;
  state: NormalizedTaskState;
  reason: string;
  attemptState: Attempt['state'];
  outcome: AttemptOutcome | null;
  outcomeReason: string | null;
  devinSessionId: string | null;
  devinSessionUrl: string | null;
  devinSessionStatus: string | null;
  devinSessionStatusDetail: string | null;
  acusConsumed: number | null;
  prUrl: string | null;
  prNumber: number | null;
  prState: Attempt['prState'];
  prHeadSha: string | null;
  verification: {
    command: LedgerVerificationEvidence | null;
    githubChecks: LedgerVerificationEvidence | null;
    prior: LedgerVerificationEvidence[];
    stale: LedgerVerificationEvidence[];
  };
  approval: {
    status: ApprovalStatus;
    approvedSha256: string | null;
    approvedAt: number | null;
    approvedBy: string | null;
    candidateSha256: string | null;
    candidateSource: Attempt['verificationCandidateSource'];
  };
  agentReported: {
    outcome: AgentOutcome | null;
    prUrl: string | null;
    needsHumanReason: string | null;
    acceptedAt: number | null;
  };
  timestamps: {
    createdAt: number;
    dispatchedAt: number | null;
    sessionCreatedAt: number | null;
    sessionUpdatedAt: number | null;
    prLastCheckedAt: number | null;
    completedAt: number | null;
    terminalAt: number | null;
    verifiedAt: number | null;
  };
}

export interface LedgerRow {
  taskId: number;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueUrl: string;
  title: string | null;
  state: NormalizedTaskState;
  reason: string;
  bucket: TaskBucket;
  attemptCount: number;
  current: LedgerAttemptEvidence | null;
  history: LedgerAttemptEvidence[];
  discoveredAt: number;
  lastUpdatedAt: number;
  terminalAt: number | null;
  verifiedAt: number | null;
}

export interface WindowCounts {
  last24h: number;
  last7d: number;
}

/**
 * Summary fields describe the current task state; throughput and cycle time
 * describe historical events and never decrease retroactively when retries
 * change the current attempt.
 */
export interface Report {
  generatedAt: string;
  context: {
    databasePath: string;
    nodeEnv: string;
    configuredRepository: string | null;
    generatedAt: string;
  };
  unit: {
    summary: 'tasks';
    throughput: {
      tasksDiscovered: 'tasks';
      tasksReachedTerminal: 'tasks';
      tasksVerified: 'tasks';
      attemptsCreated: 'attempts';
    };
  };
  summary: {
    totalTasks: number;
    byBucket: Record<TaskBucket, number>;
    byState: Record<NormalizedTaskState, number>;
    terminalWithoutTimestamp: number;
  };
  throughput: {
    tasksDiscovered: WindowCounts;
    tasksReachedTerminal: WindowCounts;
    tasksVerified: WindowCounts;
    attemptsCreated: WindowCounts;
  };
  cycleTime: {
    medianMsIntakeToTerminal: number | null;
    sampleSize: number;
    basis: 'all_terminal_attempts';
  };
  tasks: ReportTaskRow[];
  ledger: LedgerRow[];
  tasksWithoutAttempts: number;
}

const dayMs = 24 * 60 * 60 * 1000;

function emptyBucketCounts(): Record<TaskBucket, number> {
  return Object.fromEntries(TASK_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    TaskBucket,
    number
  >;
}

function emptyStateCounts(): Record<NormalizedTaskState, number> {
  return Object.fromEntries(NORMALIZED_TASK_STATES.map((state) => [state, 0])) as Record<
    NormalizedTaskState,
    number
  >;
}

function commandVerification(attempt: Attempt, db: DbExecutor) {
  return attempt.prHeadSha === null
    ? undefined
    : findLatestVerification(attempt.id, attempt.prHeadSha, 'command', db);
}

function toLedgerVerification(verification: Verification): LedgerVerificationEvidence {
  return {
    verificationId: verification.id,
    kind: verification.kind,
    status: verification.status,
    reason: verification.reason,
    headSha: verification.headSha,
    specSha256: verification.specSha256,
    exitCode: verification.exitCode,
    evidenceUrl: verification.evidenceUrl,
    startedAt: verification.startedAt,
    finishedAt: verification.finishedAt,
    createdAt: verification.createdAt,
  };
}

function toLedgerAttempt(
  attempt: Attempt,
  reportAttempt: ReportAttemptRow,
  verifications: Verification[],
  db: DbExecutor
): LedgerAttemptEvidence {
  const currentCommand =
    attempt.prHeadSha === null
      ? undefined
      : findLatestVerification(attempt.id, attempt.prHeadSha, 'command', db);
  const currentGitHubChecks =
    attempt.prHeadSha === null
      ? undefined
      : findLatestVerification(attempt.id, attempt.prHeadSha, 'github_checks', db);
  const currentVerificationIds = new Set(
    [currentCommand?.id, currentGitHubChecks?.id].filter(
      (verificationId): verificationId is number => verificationId !== undefined
    )
  );
  const prior = verifications
    .filter(
      (verification) =>
        attempt.prHeadSha !== null &&
        verification.headSha === attempt.prHeadSha &&
        !currentVerificationIds.has(verification.id)
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
    .map(toLedgerVerification);
  const stale = verifications
    .filter((verification) => verification.headSha !== attempt.prHeadSha)
    .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
    .map(toLedgerVerification);

  return {
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    correlationId: attempt.correlationId,
    state: reportAttempt.projection.state,
    reason: reportAttempt.projection.reason,
    attemptState: attempt.state,
    outcome: attempt.outcome,
    outcomeReason: attempt.outcomeReason,
    devinSessionId: attempt.devinSessionId,
    devinSessionUrl: attempt.devinSessionUrl,
    devinSessionStatus: attempt.devinSessionStatus,
    devinSessionStatusDetail: attempt.devinSessionStatusDetail,
    acusConsumed: attempt.acusConsumed,
    prUrl: attempt.prUrl,
    prNumber: attempt.prNumber,
    prState: attempt.prState,
    prHeadSha: attempt.prHeadSha,
    verification: {
      command: currentCommand ? toLedgerVerification(currentCommand) : null,
      githubChecks: currentGitHubChecks ? toLedgerVerification(currentGitHubChecks) : null,
      prior,
      stale,
    },
    approval: {
      status: approvalStatus(attempt),
      approvedSha256: attempt.verificationApprovedSha256,
      approvedAt: attempt.verificationApprovedAt,
      approvedBy: attempt.verificationApprovedBy,
      candidateSha256: attempt.verificationCandidateSha256,
      candidateSource: attempt.verificationCandidateSource,
    },
    agentReported: {
      outcome: attempt.agentOutcome ?? null,
      prUrl: attempt.agentPrUrl,
      needsHumanReason: attempt.needsHumanReason,
      acceptedAt: attempt.structuredOutputAcceptedAt,
    },
    timestamps: {
      createdAt: attempt.createdAt,
      dispatchedAt: attempt.dispatchedAt,
      sessionCreatedAt: attempt.sessionCreatedAt,
      sessionUpdatedAt: attempt.sessionUpdatedAt,
      prLastCheckedAt: attempt.prLastCheckedAt,
      completedAt: attempt.completedAt,
      terminalAt: reportAttempt.terminalAt,
      verifiedAt: reportAttempt.verifiedAt,
    },
  };
}

export function attemptTerminalAt(
  attempt: Attempt,
  projection: TaskStateProjection,
  db: DbExecutor
): number | null {
  if (attempt.state === 'completed' && attempt.completedAt !== null) {
    return attempt.completedAt;
  }
  if (
    attempt.state !== 'completed' &&
    (projection.state === 'VERIFIED' || projection.state === 'VERIFICATION_FAILED')
  ) {
    const latestCommand = commandVerification(attempt, db);
    return latestCommand ? (latestCommand.finishedAt ?? latestCommand.createdAt) : null;
  }
  return null;
}

function attemptVerifiedAt(attempt: Attempt, projection: TaskStateProjection, db: DbExecutor) {
  if (attempt.state === 'completed' && attempt.outcome === 'succeeded') {
    return attempt.completedAt;
  }
  if (attempt.state === 'completed') return null;
  if (projection.state !== 'VERIFIED') return null;
  const latestCommand = commandVerification(attempt, db);
  return latestCommand?.status === 'passed'
    ? (latestCommand.finishedAt ?? latestCommand.createdAt)
    : null;
}

function toAttemptRow(
  attempt: Attempt,
  projection: TaskStateProjection,
  db: DbExecutor
): ReportAttemptRow {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    correlationId: attempt.correlationId,
    state: attempt.state,
    outcome: attempt.outcome,
    outcomeReason: attempt.outcomeReason,
    devinSessionId: attempt.devinSessionId,
    devinSessionUrl: attempt.devinSessionUrl,
    devinSessionStatus: attempt.devinSessionStatus,
    prUrl: attempt.prUrl,
    prNumber: attempt.prNumber,
    prState: attempt.prState,
    prHeadSha: attempt.prHeadSha,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    completedAt: attempt.completedAt,
    terminalAt: attemptTerminalAt(attempt, projection, db),
    verifiedAt: attemptVerifiedAt(attempt, projection, db),
    projection,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return Math.floor(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function inWindow(timestamp: number | null, now: number, windowMs: number): boolean {
  return timestamp !== null && timestamp >= now - windowMs && timestamp <= now;
}

function latestAttempt(attemptRows: Attempt[]): Attempt {
  const attempt = attemptRows.find((row) => row.state !== 'completed') ?? attemptRows.at(-1);
  if (!attempt) throw new Error('Cannot select current attempt from empty history');
  return attempt;
}

export function buildReport(options: { now?: number; db?: DbExecutor }): Report {
  const db = options.db ?? getDb();
  const now = options.now ?? Date.now();
  const generatedAt = new Date(now).toISOString();
  const taskRows = db.select().from(tasks).orderBy(asc(tasks.id)).all();
  const bucketCounts = emptyBucketCounts();
  const stateCounts = emptyStateCounts();
  const rows: ReportTaskRow[] = [];
  const ledgerRows: LedgerRow[] = [];
  let tasksWithoutAttempts = 0;
  let terminalWithoutTimestamp = 0;

  for (const task of taskRows) {
    const attemptRows = listAttempts(task.id, db);
    const issueUrl = `https://github.com/${task.repoOwner}/${task.repoName}/issues/${String(task.issueNumber)}`;
    if (attemptRows.length === 0) {
      tasksWithoutAttempts += 1;
      ledgerRows.push({
        taskId: task.id,
        repoOwner: task.repoOwner,
        repoName: task.repoName,
        issueNumber: task.issueNumber,
        issueUrl,
        title: task.title,
        state: 'QUEUED',
        reason: 'task_without_attempt',
        bucket: 'active',
        attemptCount: 0,
        current: null,
        history: [],
        discoveredAt: task.createdAt,
        lastUpdatedAt: task.updatedAt,
        terminalAt: null,
        verifiedAt: null,
      });
      continue;
    }
    const currentAttempt = latestAttempt(attemptRows);
    const verificationTimestamps = attemptRows.flatMap((attempt) =>
      listVerifications(attempt.id, db).map(
        (verification) => verification.finishedAt ?? verification.createdAt
      )
    );
    const reportAttempts = attemptRows.map((attempt) => {
      const projection = projectTaskState(attempt, db);
      return toAttemptRow(attempt, projection, db);
    });
    const currentReportAttempt = reportAttempts.find((attempt) => attempt.id === currentAttempt.id);
    if (!currentReportAttempt) throw new Error('Current attempt is missing from report history');
    const currentProjection = currentReportAttempt.projection;
    const bucket = bucketForState(currentProjection.state);
    const lastUpdatedAt = Math.max(
      task.updatedAt,
      ...attemptRows.map((attempt) => attempt.updatedAt),
      ...verificationTimestamps
    );
    const row: ReportTaskRow = {
      taskId: task.id,
      repoOwner: task.repoOwner,
      repoName: task.repoName,
      issueNumber: task.issueNumber,
      issueUrl,
      title: task.title,
      state: currentProjection.state,
      reason: currentProjection.reason,
      bucket,
      currentAttempt: currentReportAttempt,
      attemptCount: reportAttempts.length,
      attempts: reportAttempts,
      devinSessionUrl: currentAttempt.devinSessionUrl,
      prUrl: currentAttempt.prUrl,
      discoveredAt: task.createdAt,
      lastUpdatedAt,
      terminalAt: currentReportAttempt.terminalAt,
      verifiedAt: currentReportAttempt.verifiedAt,
    };
    rows.push(row);
    const ledgerAttempts = attemptRows.map((attempt) => {
      const reportAttempt = reportAttempts.find((candidate) => candidate.id === attempt.id);
      if (!reportAttempt) throw new Error('Attempt is missing from ledger history');
      return toLedgerAttempt(attempt, reportAttempt, listVerifications(attempt.id, db), db);
    });
    const currentLedgerAttempt = ledgerAttempts.find(
      (attempt) => attempt.attemptId === currentAttempt.id
    );
    if (!currentLedgerAttempt) throw new Error('Current attempt is missing from ledger history');
    ledgerRows.push({
      taskId: task.id,
      repoOwner: task.repoOwner,
      repoName: task.repoName,
      issueNumber: task.issueNumber,
      issueUrl: row.issueUrl,
      title: task.title,
      state: row.state,
      reason: row.reason,
      bucket,
      attemptCount: ledgerAttempts.length,
      current: currentLedgerAttempt,
      history: ledgerAttempts,
      discoveredAt: task.createdAt,
      lastUpdatedAt,
      terminalAt: currentReportAttempt.terminalAt,
      verifiedAt: currentReportAttempt.verifiedAt,
    });
    bucketCounts[row.bucket] += 1;
    stateCounts[row.state] += 1;
    if (TERMINAL_BUCKETS.includes(row.bucket) && row.terminalAt === null) {
      terminalWithoutTimestamp += 1;
    }
  }

  const reportAttemptTimestampCounts = (
    timestampFor: (attempt: ReportAttemptRow) => number | null
  ): WindowCounts => ({
    last24h: rows.filter((row) =>
      row.attempts.some((attempt) => inWindow(timestampFor(attempt), now, dayMs))
    ).length,
    last7d: rows.filter((row) =>
      row.attempts.some((attempt) => inWindow(timestampFor(attempt), now, dayMs * 7))
    ).length,
  });
  const countWindow = (timestamps: Array<number | null>): WindowCounts => ({
    last24h: timestamps.filter((timestamp) => inWindow(timestamp, now, dayMs)).length,
    last7d: timestamps.filter((timestamp) => inWindow(timestamp, now, dayMs * 7)).length,
  });
  const cycleTimes = rows.flatMap((row) =>
    row.attempts.flatMap((attempt) =>
      attempt.terminalAt === null ? [] : [attempt.terminalAt - row.discoveredAt]
    )
  );
  const configuredRepository =
    config.githubRepoOwner && config.githubRepoName
      ? `${config.githubRepoOwner}/${config.githubRepoName}`
      : null;

  return {
    generatedAt,
    context: {
      databasePath: resolve(config.databasePath),
      nodeEnv: config.nodeEnv,
      configuredRepository,
      generatedAt,
    },
    unit: {
      summary: 'tasks',
      throughput: {
        tasksDiscovered: 'tasks',
        tasksReachedTerminal: 'tasks',
        tasksVerified: 'tasks',
        attemptsCreated: 'attempts',
      },
    },
    summary: {
      totalTasks: rows.length,
      byBucket: bucketCounts,
      byState: stateCounts,
      terminalWithoutTimestamp,
    },
    throughput: {
      tasksDiscovered: countWindow(rows.map((row) => row.discoveredAt)),
      tasksReachedTerminal: reportAttemptTimestampCounts((attempt) => attempt.terminalAt),
      tasksVerified: reportAttemptTimestampCounts((attempt) => attempt.verifiedAt),
      attemptsCreated: countWindow(
        rows.flatMap((row) => row.attempts.map((attempt) => attempt.createdAt))
      ),
    },
    cycleTime: {
      medianMsIntakeToTerminal: median(cycleTimes),
      sampleSize: cycleTimes.length,
      basis: 'all_terminal_attempts',
    },
    tasks: rows.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt),
    ledger: ledgerRows.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt),
    tasksWithoutAttempts,
  };
}
