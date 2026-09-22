import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, getRawDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import { DevinApiError, DevinClient, type SessionResponse } from '../src/devin/client.js';
import { projectTaskState } from '../src/tracking/normalized-task-state.js';
import {
  approveVerificationSpec,
  completeAttempt,
  createAttempt,
  getAttempt,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifiedLabelApplied,
  markVerifying,
  recordPullRequest,
  recordVerification,
  listVerifications,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import { hashVerificationSpec } from '../src/verification/spec.js';
import { GitHubApiError, type GitHubPullRequest } from '../src/github/client.js';
import { runTrackingOnce, toEpochMs } from '../src/tracking/session-tracker.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function session(overrides: Partial<SessionResponse> = {}): SessionResponse {
  return {
    session_id: 'sess-1',
    url: 'https://app.devin.ai/sessions/sess-1',
    status: 'exit',
    status_detail: 'finished',
    tags: [],
    org_id: 'org',
    created_at: 1_700_000_000,
    updated_at: 1_700_000_001,
    ...overrides,
  };
}

function pullRequest(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 12,
    html_url: 'https://github.com/owner/repo/pull/12',
    title: 'Fixes #7',
    state: 'open',
    merged_at: null,
    body: null,
    head: { sha: 'sha-1' },
    base: { repo: { full_name: 'owner/repo' } },
    ...overrides,
  };
}

function activeAttempt(issueNumber = 7) {
  const task = upsertTask({ repoOwner: 'owner', repoName: 'repo', issueNumber });
  const attempt = createAttempt(task.id);
  markDispatching(attempt.id);
  return {
    task,
    attempt: markSessionCreated(attempt.id, {
      devinSessionId: `sess-${String(issueNumber)}`,
    }),
  };
}

const VERIFIED_SPEC_SHA = hashVerificationSpec('bash', 'echo ok');

// completeAttempt refuses 'succeeded' and completeVerifiedAttempt needs
// verification rows, so tests seed the terminal row directly. The approved spec
// and a decisive passed command row for the current head make the attempt
// project VERIFIED; pass `superseded: true` to advance prHeadSha past the
// verified head afterwards.
function completedVerifiedAttempt(issueNumber = 40, opts: { superseded?: boolean } = {}) {
  const { task, attempt } = activeAttempt(issueNumber);
  markRunning(attempt.id);
  recordPullRequest(attempt.id, {
    prUrl: 'https://github.com/owner/repo/pull/12',
    prNumber: 12,
    prState: 'open',
    prHeadSha: 'sha-1',
  });
  markVerifying(attempt.id);
  setVerificationCandidate(
    attempt.id,
    { shell: 'bash', script: 'echo ok' },
    'issue_verification_section'
  );
  approveVerificationSpec(attempt.id, VERIFIED_SPEC_SHA, 'operator');
  recordVerification({
    attemptId: attempt.id,
    headSha: 'sha-1',
    kind: 'command',
    status: 'passed',
    specShell: 'bash',
    specScript: 'echo ok',
    specSha256: VERIFIED_SPEC_SHA,
  });
  const rawDb = getRawDb();
  if (!rawDb) throw new Error('Raw database was not initialized');
  rawDb
    .prepare(
      "UPDATE attempts SET state = 'completed', outcome = 'succeeded', completed_at = ?, updated_at = ? WHERE id = ?"
    )
    .run(Date.now(), Date.now(), attempt.id);
  if (opts.superseded) {
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-2',
    });
  }
  const completed = getAttempt(attempt.id);
  if (!completed) throw new Error('attempt missing');
  return { task, attempt: completed };
}

describe('session tracker', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  it('normalizes Devin seconds timestamps and records a running snapshot', async () => {
    expect(toEpochMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    const { task, attempt } = activeAttempt();
    const log = logger();
    const result = await runTrackingOnce({
      devin: {
        getSession: vi
          .fn()
          .mockResolvedValue(session({ status: 'running', status_detail: 'working' })),
      },
      github: { getPullRequest: vi.fn() },
      logger: log,
      staleWarnMs: 0,
    });

    expect(result.markedRunning).toBe(1);
    expect(getAttempt(attempt.id)).toMatchObject({
      taskId: task.id,
      state: 'running',
      devinSessionStatus: 'running',
      sessionUpdatedAt: 1_700_000_001_000,
    });
  });

  it('completes a no-action structured outcome', async () => {
    const { attempt } = activeAttempt();
    await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(
          session({
            structured_output: {
              schema_version: 1,
              outcome: 'no_action',
              pr_url: null,
              diagnosis: 'Not applicable',
              tests_run: [],
              risks: [],
              needs_human_reason: null,
            },
          })
        ),
      },
      github: { getPullRequest: vi.fn() },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'completed',
      outcome: 'no_action',
      agentOutcome: 'no_action',
    });
  });

  it('records a verified pull request and enters verifying', async () => {
    const { attempt } = activeAttempt();
    const github = vi.fn().mockResolvedValue(pullRequest());
    await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(
          session({
            structured_output: {
              schema_version: 1,
              outcome: 'remediated',
              pr_url: 'https://github.com/owner/repo/pull/12',
              diagnosis: 'Fixed',
              tests_run: [],
              risks: [],
              needs_human_reason: null,
            },
          })
        ),
      },
      github: { getPullRequest: github },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'verifying',
      outcome: null,
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    expect(github).toHaveBeenCalledTimes(1);
  });

  it('isolates a failed attempt from the rest of the tracking pass', async () => {
    const first = activeAttempt(7);
    const second = activeAttempt(8);
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary Devin failure'))
      .mockResolvedValueOnce(session({ status: 'running', status_detail: 'working' }));
    const result = await runTrackingOnce({
      devin: { getSession },
      github: { getPullRequest: vi.fn() },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(result.failed).toBe(1);
    expect(result.markedRunning).toBe(1);
    expect(getAttempt(first.attempt.id)?.state).toBe('session_created');
    expect(getAttempt(second.attempt.id)?.state).toBe('running');
  });

  it('refreshes a verifying pull request when Devin session lookup fails', async () => {
    const { task, attempt } = activeAttempt(9);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'old-sha',
    });
    markVerifying(attempt.id);
    const github = vi.fn().mockResolvedValue(
      pullRequest({
        state: 'closed',
        merged_at: '2026-01-01T00:00:00Z',
        head: { sha: 'merged-sha' },
      })
    );

    const result = await runTrackingOnce({
      devin: {
        getSession: vi
          .fn()
          .mockRejectedValue(new DevinApiError(404, 'GET', '/sessions/sess-9', 'missing')),
      },
      github: { getPullRequest: github },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(result.prRefreshed).toBe(1);
    expect(github).toHaveBeenCalledWith('owner', 'repo', 12);
    expect(getAttempt(attempt.id)).toMatchObject({
      taskId: task.id,
      state: 'verifying',
      prState: 'merged',
      prHeadSha: 'merged-sha',
    });
  });

  it('escalates terminal PR lookup rejection but defers rate-limited lookup', async () => {
    const first = activeAttempt(10);
    const second = activeAttempt(11);
    const output = (issueNumber: number) => ({
      schema_version: 1 as const,
      outcome: 'remediated' as const,
      pr_url: `https://github.com/owner/repo/pull/${String(issueNumber)}`,
      diagnosis: 'Fixed',
      tests_run: [],
      risks: [],
      needs_human_reason: null,
    });
    const getSession = vi
      .fn()
      .mockResolvedValueOnce(session({ structured_output: output(10) }))
      .mockResolvedValueOnce(session({ structured_output: output(11) }));
    const getPullRequest = vi
      .fn()
      .mockRejectedValueOnce(new GitHubApiError(403, 'GET', '/pulls/10', 'forbidden'))
      .mockRejectedValueOnce(new GitHubApiError(403, 'GET', '/pulls/11', 'rate limited', true));

    await runTrackingOnce({
      devin: { getSession },
      github: { getPullRequest },
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(getAttempt(first.attempt.id)).toMatchObject({
      state: 'completed',
      outcome: 'escalated',
      outcomeReason: 'pr_lookup_rejected: https://github.com/owner/repo/pull/10',
    });
    expect(getAttempt(second.attempt.id)).toMatchObject({
      state: 'session_created',
      outcome: null,
      agentOutcome: 'remediated',
    });
  });

  it.each([
    ['unknown status', { status: 'archived', status_detail: 'finished' }],
    ['unknown status_detail', { status: 'exit', status_detail: 'brand_new_detail' }],
  ])('leaves a running attempt non-terminal when Devin reports an %s', async (_label, patch) => {
    const { attempt } = activeAttempt(30);
    markRunning(attempt.id);
    const before = getAttempt(attempt.id);
    const fetchFn = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...session(),
            ...patch,
            structured_output: {
              schema_version: 1,
              outcome: 'remediated',
              pr_url: 'https://github.com/owner/repo/pull/12',
              diagnosis: 'Fixed',
              tests_run: [],
              risks: [],
              needs_human_reason: null,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    const devin = new DevinClient({ apiKey: 'k', orgId: 'org', fetchFn });
    const getPullRequest = vi.fn().mockResolvedValue(pullRequest());
    const log = logger();

    const result = await runTrackingOnce({
      devin,
      github: { getPullRequest },
      logger: log,
      staleWarnMs: 0,
    });

    expect(result.failed).toBe(1);
    expect(getPullRequest).not.toHaveBeenCalled();
    const after = getAttempt(attempt.id);
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      state: 'running',
      outcome: null,
      agentOutcome: null,
      structuredOutputAcceptedAt: null,
    });
    if (!after) throw new Error('attempt missing');
    expect(projectTaskState(after)).toMatchObject({ state: 'RUNNING', reason: 'attempt_running' });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempt_id: attempt.id }),
      expect.any(String)
    );
  });

  it('records a plain closed PR while verifying and projects NEEDS_HUMAN', async () => {
    const { attempt } = activeAttempt(31);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);

    await runTrackingOnce({
      devin: { getSession: vi.fn().mockResolvedValue(session({ status: 'exit' })) },
      github: {
        getPullRequest: vi
          .fn()
          .mockResolvedValue(pullRequest({ state: 'closed', merged_at: null })),
      },
      logger: logger(),
      staleWarnMs: 0,
    });

    const after = getAttempt(attempt.id);
    expect(after).toMatchObject({ state: 'verifying', outcome: null, prState: 'closed' });
    if (!after) throw new Error('attempt missing');
    expect(projectTaskState(after)).toMatchObject({
      state: 'NEEDS_HUMAN',
      reason: 'pr_closed_without_merge',
    });
  });

  it('applies the verified label to a completed succeeded pull request exactly once', async () => {
    const { attempt } = completedVerifiedAttempt(40);
    const addLabels = vi.fn().mockResolvedValue(undefined);
    const opts = {
      devin: { getSession: vi.fn() },
      github: { getPullRequest: vi.fn().mockResolvedValue(pullRequest()), addLabels },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: 'devin-verified',
    };

    const result = await runTrackingOnce(opts);

    expect(addLabels).toHaveBeenCalledTimes(1);
    expect(addLabels).toHaveBeenCalledWith('owner', 'repo', 12, ['devin-verified']);
    expect(result.verifiedLabelsApplied).toBe(1);
    expect(getAttempt(attempt.id)?.prVerifiedLabelAppliedAt).not.toBeNull();

    const second = await runTrackingOnce(opts);
    expect(addLabels).toHaveBeenCalledTimes(1);
    expect(second.verifiedLabelsApplied).toBe(0);
  });

  it('does not label a succeeded attempt whose PR head is not verified', async () => {
    const { attempt } = completedVerifiedAttempt(44, { superseded: true });
    const addLabels = vi.fn().mockResolvedValue(undefined);
    const removeLabel = vi.fn().mockResolvedValue(undefined);

    const result = await runTrackingOnce({
      devin: { getSession: vi.fn() },
      github: {
        getPullRequest: vi.fn().mockResolvedValue(pullRequest({ head: { sha: 'sha-2' } })),
        addLabels,
        removeLabel,
      },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: 'devin-verified',
    });

    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    expect(result.verifiedLabelsApplied).toBe(0);
    expect(getAttempt(attempt.id)?.prVerifiedLabelAppliedAt).toBeNull();
  });

  it('removes the label from a labelled attempt whose PR head was superseded', async () => {
    const { attempt } = completedVerifiedAttempt(45, { superseded: true });
    markVerifiedLabelApplied(attempt.id);
    const addLabels = vi.fn().mockResolvedValue(undefined);
    const removeLabel = vi.fn().mockResolvedValue(undefined);
    const opts = {
      devin: { getSession: vi.fn() },
      github: {
        getPullRequest: vi.fn().mockResolvedValue(pullRequest({ head: { sha: 'sha-2' } })),
        addLabels,
        removeLabel,
      },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: 'devin-verified',
    };

    const result = await runTrackingOnce(opts);

    expect(removeLabel).toHaveBeenCalledTimes(1);
    expect(removeLabel).toHaveBeenCalledWith('owner', 'repo', 12, 'devin-verified');
    expect(addLabels).not.toHaveBeenCalled();
    expect(result.verifiedLabelsRemoved).toBe(1);
    expect(getAttempt(attempt.id)?.prVerifiedLabelAppliedAt).toBeNull();

    const second = await runTrackingOnce(opts);
    expect(removeLabel).toHaveBeenCalledTimes(1);
    expect(addLabels).not.toHaveBeenCalled();
    expect(second.verifiedLabelsRemoved).toBe(0);
  });

  it('keeps the marker set and retries after a label removal failure', async () => {
    const { attempt } = completedVerifiedAttempt(46, { superseded: true });
    markVerifiedLabelApplied(attempt.id);
    const removeLabel = vi
      .fn()
      .mockRejectedValueOnce(new GitHubApiError(500, 'DELETE', '/issues/12/labels/x', 'oops'))
      .mockResolvedValueOnce(undefined);
    const opts = {
      devin: { getSession: vi.fn() },
      github: {
        getPullRequest: vi.fn().mockResolvedValue(pullRequest({ head: { sha: 'sha-2' } })),
        removeLabel,
      },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: 'devin-verified',
    };

    const first = await runTrackingOnce(opts);

    expect(first.verifiedLabelsRemoved).toBe(0);
    expect(first.failed).toBe(1);
    expect(getAttempt(attempt.id)?.prVerifiedLabelAppliedAt).not.toBeNull();

    const second = await runTrackingOnce(opts);
    expect(removeLabel).toHaveBeenCalledTimes(2);
    expect(second.verifiedLabelsRemoved).toBe(1);
    expect(getAttempt(attempt.id)?.prVerifiedLabelAppliedAt).toBeNull();
  });

  it('leaves the marker unset and retries after a label application failure', async () => {
    const { attempt } = completedVerifiedAttempt(41);
    const addLabels = vi
      .fn()
      .mockRejectedValueOnce(new GitHubApiError(500, 'POST', '/issues/12/labels', 'oops'))
      .mockResolvedValueOnce(undefined);
    const opts = {
      devin: { getSession: vi.fn() },
      github: { getPullRequest: vi.fn().mockResolvedValue(pullRequest()), addLabels },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: 'devin-verified',
    };

    const first = await runTrackingOnce(opts);

    expect(first.verifiedLabelsApplied).toBe(0);
    expect(first.failed).toBe(1);
    expect(getAttempt(attempt.id)?.prVerifiedLabelAppliedAt).toBeNull();

    const second = await runTrackingOnce(opts);
    expect(addLabels).toHaveBeenCalledTimes(2);
    expect(second.verifiedLabelsApplied).toBe(1);
    expect(getAttempt(attempt.id)?.prVerifiedLabelAppliedAt).not.toBeNull();
  });

  it('does not label when the verified label is disabled or unsupported', async () => {
    completedVerifiedAttempt(42);
    const addLabels = vi.fn().mockResolvedValue(undefined);

    const disabled = await runTrackingOnce({
      devin: { getSession: vi.fn() },
      github: { getPullRequest: vi.fn().mockResolvedValue(pullRequest()), addLabels },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: '',
    });
    expect(disabled.verifiedLabelsApplied).toBe(0);
    expect(addLabels).not.toHaveBeenCalled();

    const unsupported = await runTrackingOnce({
      devin: { getSession: vi.fn() },
      github: { getPullRequest: vi.fn().mockResolvedValue(pullRequest()) },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: 'devin-verified',
    });
    expect(unsupported.verifiedLabelsApplied).toBe(0);
    expect(unsupported.verifiedLabelsRemoved).toBe(0);
    expect(unsupported.failed).toBe(0);
  });

  it('does not label completed attempts that did not succeed', async () => {
    const { attempt } = activeAttempt(43);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);
    completeAttempt(attempt.id, 'escalated', { reason: 'verification_failed' });
    const addLabels = vi.fn().mockResolvedValue(undefined);

    const result = await runTrackingOnce({
      devin: { getSession: vi.fn() },
      github: { getPullRequest: vi.fn().mockResolvedValue(pullRequest()), addLabels },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: 'devin-verified',
    });

    expect(addLabels).not.toHaveBeenCalled();
    expect(result.verifiedLabelsApplied).toBe(0);
  });

  it('warns about stale running sessions but not verifying attempts', async () => {
    const verifying = activeAttempt(12);
    markRunning(verifying.attempt.id);
    recordPullRequest(verifying.attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(verifying.attempt.id);
    const running = activeAttempt(13);
    markRunning(running.attempt.id);
    const log = logger();
    const oldUpdatedAt = Math.floor((Date.now() - 10_000) / 1000);
    const rawDb = getRawDb();
    if (!rawDb) throw new Error('Raw database was not initialized');
    rawDb
      .prepare('UPDATE attempts SET session_created_at = ? WHERE id IN (?, ?)')
      .run(Date.now() - 10_000, verifying.attempt.id, running.attempt.id);

    await runTrackingOnce({
      devin: {
        getSession: vi
          .fn()
          .mockResolvedValueOnce(session({ updated_at: oldUpdatedAt, status: 'exit' }))
          .mockResolvedValueOnce(session({ updated_at: oldUpdatedAt, status: 'running' })),
      },
      github: { getPullRequest: vi.fn().mockResolvedValue(pullRequest()) },
      logger: log,
      staleWarnMs: 1_000,
    });

    const staleWarnings = log.warn.mock.calls.filter(
      ([, message]) =>
        message === 'Devin session has not updated for longer than the stale threshold'
    );
    expect(staleWarnings).toHaveLength(1);
    expect(staleWarnings[0]?.[0]).toMatchObject({ attempt_id: running.attempt.id });
  });
});

describe('independent verification integration', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(verifications).run();
    db.delete(verifications).run();
    db.delete(attempts).run();
    db.delete(tasks).run();
  });

  afterAll(() => {
    closeDb();
  });

  const verificationOpts = (overrides: Record<string, unknown> = {}) => ({
    workspaceRoot: '/tmp/verify-tracker-test',
    commandTimeoutMs: 5_000,
    setupTimeoutMs: 5_000,
    checkoutTimeoutMs: 5_000,
    maxOutputBytes: 4096,
    runCommand: vi.fn().mockResolvedValue({
      status: 'passed',
      exitCode: 0,
      output: 'ok',
      startedAt: 1,
      finishedAt: 2,
    }),
    checkout: vi.fn().mockResolvedValue(undefined),
    resolveAdapter: vi.fn().mockReturnValue({ name: 'noop', setup: vi.fn().mockResolvedValue({}) }),
    ...overrides,
  });

  const githubWithVerification = () => ({
    getPullRequest: vi.fn().mockResolvedValue(pullRequest()),
    getIssue: vi.fn().mockResolvedValue({
      number: 7,
      title: 't',
      state: 'open',
      html_url: 'u',
      labels: [],
      body: '## Verification\n\n```bash\necho ok\n```\n',
    }),
    listCheckRuns: vi.fn().mockResolvedValue({ total_count: 0, check_runs: [] }),
    getCombinedStatus: vi
      .fn()
      .mockResolvedValue({ state: 'success', total_count: 0, statuses: [] }),
  });

  const approveIssueSpec = (attemptId: number) => {
    const spec = {
      shell: 'bash' as const,
      script: 'echo ok',
      sha256: hashVerificationSpec('bash', 'echo ok'),
    };
    setVerificationCandidate(attemptId, spec, 'issue_verification_section');
    approveVerificationSpec(attemptId, spec.sha256, 'operator');
  };

  it('runs verification for a verifying attempt with a refreshed PR', async () => {
    const { attempt } = activeAttempt(20);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);
    approveIssueSpec(attempt.id);

    const addLabels = vi.fn().mockResolvedValue(undefined);
    const result = await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(session({ status: 'exit' })),
      },
      github: { ...githubWithVerification(), addLabels },
      logger: logger(),
      staleWarnMs: 0,
      verifiedLabel: 'devin-verified',
      verification: verificationOpts(),
    });

    expect(result.verificationPassed).toBe(1);
    expect(addLabels).toHaveBeenCalledTimes(1);
    expect(addLabels).toHaveBeenCalledWith('owner', 'repo', 12, ['devin-verified']);
    expect(result.verifiedLabelsApplied).toBe(1);
    expect(getAttempt(attempt.id)).toMatchObject({
      state: 'completed',
      outcome: 'succeeded',
    });
    expect(listVerifications(attempt.id).filter((row) => row.kind === 'command')).toHaveLength(1);
  });

  it('does not run verification when verification is disabled', async () => {
    const { attempt } = activeAttempt(21);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);

    const result = await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(session({ status: 'exit' })),
      },
      github: githubWithVerification(),
      logger: logger(),
      staleWarnMs: 0,
    });

    expect(result.verificationPassed).toBe(0);
    expect(getAttempt(attempt.id)?.state).toBe('verifying');
    expect(listVerifications(attempt.id)).toHaveLength(0);
  });

  it('stays verifying when the verification command fails', async () => {
    const { attempt } = activeAttempt(22);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);
    approveIssueSpec(attempt.id);

    const result = await runTrackingOnce({
      devin: {
        getSession: vi.fn().mockResolvedValue(session({ status: 'exit' })),
      },
      github: githubWithVerification(),
      logger: logger(),
      staleWarnMs: 0,
      verification: verificationOpts({
        runCommand: vi.fn().mockResolvedValue({
          status: 'failed',
          exitCode: 1,
          output: 'bad',
          startedAt: 1,
          finishedAt: 2,
        }),
      }),
    });

    expect(result.verificationFailed).toBe(1);
    expect(getAttempt(attempt.id)?.state).toBe('verifying');
  });

  it('still runs verification when the Devin session lookup fails', async () => {
    const { attempt } = activeAttempt(23);
    markRunning(attempt.id);
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'sha-1',
    });
    markVerifying(attempt.id);
    approveIssueSpec(attempt.id);

    const runCommand = vi.fn().mockResolvedValue({
      status: 'passed',
      exitCode: 0,
      output: 'ok',
      startedAt: 1,
      finishedAt: 2,
    });
    const result = await runTrackingOnce({
      devin: { getSession: vi.fn().mockRejectedValue(new Error('devin down')) },
      github: githubWithVerification(),
      logger: logger(),
      staleWarnMs: 0,
      verification: verificationOpts({ runCommand }),
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(result.verificationPassed).toBe(1);
    expect(getAttempt(attempt.id)).toMatchObject({ state: 'completed', outcome: 'succeeded' });
  });
});
