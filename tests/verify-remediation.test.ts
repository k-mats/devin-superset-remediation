import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { attempts, tasks, verifications } from '../src/db/schema.js';
import {
  approveVerificationSpec,
  createAttempt,
  getAttempt,
  listVerifications,
  markDispatching,
  markRunning,
  markSessionCreated,
  markVerifying,
  recordPullRequest,
  recordStructuredOutput,
  recordVerification,
  setVerificationCandidate,
  upsertTask,
} from '../src/db/task-state.js';
import type { GitHubIssue } from '../src/github/client.js';
import { hashVerificationSpec, type VerificationSpec } from '../src/verification/spec.js';
import {
  verifyRemediationOnce,
  type VerifyRemediationOptions,
} from '../src/verification/verify-remediation.js';
import { approvalStatus } from '../src/verification/approval.js';
import type { CommandRunResult } from '../src/verification/runner.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function spec(script: string, shell: 'bash' | 'sh' = 'bash'): VerificationSpec {
  return { shell, script, sha256: hashVerificationSpec(shell, script) };
}

function freshAttempt(id: number) {
  const attempt = getAttempt(id);
  if (!attempt) throw new Error(`Attempt ${String(id)} not found`);
  return attempt;
}

function approveIssueSpec(attemptId: number, script: string, shell: 'bash' | 'sh' = 'bash') {
  const approved = spec(script, shell);
  setVerificationCandidate(attemptId, approved, 'issue_verification_section');
  approveVerificationSpec(attemptId, approved.sha256, 'operator');
  return approved;
}

function prResponse(headSha: string) {
  return {
    number: 12,
    title: 'Remediation PR',
    html_url: 'https://github.com/owner/repo/pull/12',
    state: 'open' as const,
    merged_at: null,
    body: null,
    head: { sha: headSha },
  };
}

function issueWithSpec(script: string, shell: 'bash' | 'sh' = 'bash'): GitHubIssue {
  return {
    number: 7,
    title: 'Fix it',
    state: 'open',
    html_url: 'u',
    labels: [],
    body: `Desc\n\n## Verification\n\n\`\`\`${shell}\n${script}\n\`\`\`\n`,
  };
}

function verifyingAttempt(overrides: { issueNumber?: number } = {}) {
  const task = upsertTask({
    repoOwner: 'Owner',
    repoName: 'Repo',
    issueNumber: overrides.issueNumber ?? 7,
  });
  const attempt = createAttempt(task.id);
  markDispatching(attempt.id);
  markSessionCreated(attempt.id, { devinSessionId: `sess-${String(attempt.id)}` });
  markRunning(attempt.id);
  recordPullRequest(attempt.id, {
    prUrl: 'https://github.com/owner/repo/pull/12',
    prNumber: 12,
    prState: 'open',
    prHeadSha: 'head-1',
  });
  return { task, attempt: markVerifying(attempt.id) };
}

function options(overrides: Partial<VerifyRemediationOptions> = {}): VerifyRemediationOptions {
  return {
    github: {
      getIssue: vi.fn().mockResolvedValue(issueWithSpec('echo ok')),
      getPullRequest: vi.fn().mockResolvedValue(prResponse('head-1')),
      listCheckRuns: vi.fn().mockResolvedValue({ total_count: 0, check_runs: [] }),
      getCombinedStatus: vi
        .fn()
        .mockResolvedValue({ state: 'pending', total_count: 0, statuses: [] }),
    },
    logger: logger(),
    db: getDb(),
    workspaceRoot: '/tmp/verify-test',
    commandTimeoutMs: 5_000,
    setupTimeoutMs: 5_000,
    checkoutTimeoutMs: 5_000,
    maxOutputBytes: 4096,
    runCommand: vi.fn().mockResolvedValue({
      status: 'passed',
      exitCode: 0,
      output: 'all good',
      startedAt: 1,
      finishedAt: 2,
    } satisfies CommandRunResult),
    checkout: vi.fn().mockResolvedValue(undefined),
    resolveAdapter: vi.fn().mockReturnValue({ name: 'noop', setup: vi.fn().mockResolvedValue({}) }),
    ...overrides,
  };
}

describe('verifyRemediationOnce', () => {
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

  it('skips attempts that are not verifying or lack a PR', async () => {
    const task = upsertTask({ repoOwner: 'o', repoName: 'r', issueNumber: 99 });
    const attempt = createAttempt(task.id);
    expect(await verifyRemediationOnce(attempt, task, options())).toBe('verification_skipped');
  });

  it('records github_checks unverified when there are no checks, deduped across calls', async () => {
    const { task, attempt } = verifyingAttempt();
    const opts = options();
    await verifyRemediationOnce(attempt, task, opts);
    await verifyRemediationOnce(attempt, task, opts);
    const rows = listVerifications(attempt.id).filter((row) => row.kind === 'github_checks');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'unverified',
      reason: 'no_checks',
      headSha: 'head-1',
    });
    expect(rows[0]?.evidenceUrl).toBe('https://github.com/owner/repo/pull/12/checks');
  });

  it('records an error row when the GitHub checks lookup fails, deduped across calls', async () => {
    const { task, attempt } = verifyingAttempt();
    const opts = options();
    (opts.github.listCheckRuns as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await verifyRemediationOnce(attempt, task, opts);
    await verifyRemediationOnce(freshAttempt(attempt.id), task, opts);
    const checks = listVerifications(attempt.id).filter((r) => r.kind === 'github_checks');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      status: 'error',
      reason: 'checks_lookup_failed',
      headSha: 'head-1',
    });
    expect(checks[0]?.evidenceSummary).toContain('boom');
    // The command path still evaluated on both passes.
    expect(
      listVerifications(attempt.id).filter((r) => r.kind === 'command').length
    ).toBeGreaterThan(0);
  });

  it('treats a post-dispatch issue verification section as pending_approval without running it', async () => {
    const { task, attempt } = verifyingAttempt();
    const opts = options();
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_unverified');
    expect(opts.runCommand).not.toHaveBeenCalled();
    const updated = freshAttempt(attempt.id);
    expect(updated.state).toBe('verifying');
    expect(updated.verificationCandidateSource).toBe('issue_verification_section');
    expect(updated.verificationApprovedSha256).toBeNull();
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command).toMatchObject({
      status: 'unverified',
      reason: 'verification_spec_pending_approval',
    });
    expect(command?.evidenceSummary).toContain('source=issue_verification_section');
  });

  it('does not clobber an operator candidate with a post-dispatch issue section', async () => {
    const { task, attempt } = verifyingAttempt();
    const operatorSpec = setVerificationCandidate(attempt.id, spec('echo op'), 'operator');
    const opts = options();
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_unverified');
    expect(opts.runCommand).not.toHaveBeenCalled();
    const updated = freshAttempt(attempt.id);
    expect(updated.verificationCandidateSource).toBe('operator');
    expect(updated.verificationCandidateSha256).toBe(operatorSpec.verificationCandidateSha256);
  });

  it('clears an issue-sourced candidate when the verification section is removed', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const opts = options();
    (opts.github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issueWithSpec('echo ok'),
      body: 'Desc without a verification section',
    });
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_unverified');
    expect(opts.runCommand).not.toHaveBeenCalled();
    const updated = freshAttempt(attempt.id);
    expect(updated.state).toBe('verifying');
    expect(updated.verificationCandidateSource).toBeNull();
    expect(updated.verificationCandidateSha256).toBeNull();
    expect(approvalStatus(updated)).toBe('no_candidate');
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command).toMatchObject({
      status: 'unverified',
      reason: 'no_approved_verification_spec',
    });
  });

  it('promotes an equal-hash issue candidate to operator on explicit proposal', async () => {
    const { task, attempt } = verifyingAttempt();
    setVerificationCandidate(attempt.id, spec('echo ok'), 'issue_verification_section');
    const promoted = setVerificationCandidate(attempt.id, spec('echo ok'), 'operator');
    expect(promoted.verificationCandidateSource).toBe('operator');
    approveVerificationSpec(attempt.id, hashVerificationSpec('bash', 'echo ok'), 'operator');
    const opts = options();
    (opts.github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issueWithSpec('echo ok'),
      body: 'Desc without a verification section',
    });
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_passed');
    expect(opts.runCommand).toHaveBeenCalledTimes(1);
    const updated = freshAttempt(attempt.id);
    expect(updated.verificationCandidateSource).toBe('operator');
  });

  it('leaves an operator candidate untouched when the issue section is removed', async () => {
    const { task, attempt } = verifyingAttempt();
    const operatorSpec = setVerificationCandidate(attempt.id, spec('echo op'), 'operator');
    approveVerificationSpec(attempt.id, hashVerificationSpec('bash', 'echo op'), 'operator');
    const opts = options();
    (opts.github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issueWithSpec('echo ok'),
      body: 'Desc without a verification section',
    });
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_passed');
    expect(opts.runCommand).toHaveBeenCalledTimes(1);
    const updated = freshAttempt(attempt.id);
    expect(updated.verificationCandidateSource).toBe('operator');
    expect(updated.verificationCandidateSha256).toBe(operatorSpec.verificationCandidateSha256);
  });

  it('runs an approved spec and completes the attempt when the head is unchanged', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const result = await verifyRemediationOnce(attempt, task, options());
    expect(result).toBe('verification_passed');
    const updated = getAttempt(attempt.id);
    expect(updated).toMatchObject({
      state: 'completed',
      outcome: 'succeeded',
      verificationCandidateSource: 'issue_verification_section',
      verificationApprovedBy: 'operator',
    });
    expect(updated?.outcomeReason).toContain('head-1');
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command).toMatchObject({ status: 'passed', specShell: 'bash' });
    expect(command?.specScript).toBe('echo ok');
  });

  it('stays verifying when the PR head moved during a passing verification', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const opts = options();
    (opts.github.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      prResponse('head-2')
    );
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_passed');
    const updated = freshAttempt(attempt.id);
    expect(updated.state).toBe('verifying');
    expect(updated.prHeadSha).toBe('head-2');
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command).toMatchObject({ status: 'passed', headSha: 'head-1' });
  });

  it('stays verifying when the post-pass PR re-check fails', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const opts = options();
    (opts.github.getPullRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_passed');
    expect(freshAttempt(attempt.id).state).toBe('verifying');
  });

  it('repairs completion idempotently from a recorded passed row', async () => {
    const { task, attempt } = verifyingAttempt();
    const approved = approveIssueSpec(attempt.id, 'echo ok');
    recordVerification({
      attemptId: attempt.id,
      headSha: 'head-1',
      kind: 'command',
      status: 'passed',
      specShell: approved.shell,
      specScript: approved.script,
      specSha256: approved.sha256,
    });
    const opts = options();
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_passed');
    expect(opts.runCommand).not.toHaveBeenCalled();
    expect(freshAttempt(attempt.id)).toMatchObject({ state: 'completed', outcome: 'succeeded' });
  });

  it('stays verifying and records failed when the command fails', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const opts = options();
    (opts.runCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'failed',
      exitCode: 1,
      output: 'nope',
      startedAt: 1,
      finishedAt: 2,
    } satisfies CommandRunResult);
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_failed');
    expect(getAttempt(attempt.id)?.state).toBe('verifying');
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('records error without completing the attempt', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const opts = options();
    (opts.runCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'error',
      reason: 'timeout',
      exitCode: null,
      output: '',
      startedAt: 1,
      finishedAt: 2,
    } satisfies CommandRunResult);
    expect(await verifyRemediationOnce(attempt, task, opts)).toBe('verification_error');
    expect(getAttempt(attempt.id)?.state).toBe('verifying');
  });

  it('records unverified no_approved_verification_spec without a candidate', async () => {
    const { task, attempt } = verifyingAttempt();
    const opts = options();
    (opts.github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issueWithSpec('x'),
      body: 'no section',
    });
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_unverified');
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command).toMatchObject({
      status: 'unverified',
      reason: 'no_approved_verification_spec',
    });
    expect(opts.runCommand).not.toHaveBeenCalled();
  });

  it('does not run a pending_approval spec', async () => {
    const { task, attempt } = verifyingAttempt();
    setVerificationCandidate(attempt.id, spec('echo hi'), 'operator');
    const opts = options();
    (opts.github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issueWithSpec('x'),
      body: 'no section',
    });
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_unverified');
    expect(opts.runCommand).not.toHaveBeenCalled();
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command?.reason).toBe('verification_spec_pending_approval');
    expect(command?.evidenceSummary).toContain('source=operator');
  });

  it('derives a candidate from agent_tests_run but never approves it', async () => {
    const { task, attempt } = verifyingAttempt();
    recordStructuredOutput(attempt.id, {
      raw: null,
      parsed: {
        schema_version: 1,
        outcome: 'remediated',
        pr_url: 'u',
        diagnosis: 'd',
        tests_run: [{ command: 'pytest -k x', result: 'passed' }],
        risks: [],
        needs_human_reason: null,
      },
    });
    const opts = options();
    (opts.github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issueWithSpec('x'),
      body: 'no section',
    });
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_unverified');
    const updated = getAttempt(attempt.id);
    expect(updated?.verificationCandidateSource).toBe('agent_tests_run');
    expect(updated?.verificationCandidateScript).toBe('pytest -k x');
    expect(approvalStatus(freshAttempt(attempt.id))).toBe('pending_approval');
    expect(opts.runCommand).not.toHaveBeenCalled();
    const stored = getAttempt(attempt.id);
    expect(stored?.agentTestsRun).toHaveLength(1);
  });

  it('runs the spec after an operator approves the candidate', async () => {
    const { task, attempt } = verifyingAttempt();
    const proposed = spec('echo approved');
    setVerificationCandidate(attempt.id, proposed, 'operator');
    approveVerificationSpec(attempt.id, proposed.sha256, 'operator');
    const opts = options();
    (opts.github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issueWithSpec('x'),
      body: 'no section',
    });
    expect(await verifyRemediationOnce(attempt, task, opts)).toBe('verification_passed');
    expect(opts.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ sha256: proposed.sha256 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('requires re-approval when the issue section changes after approval', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const opts = options();
    expect(approvalStatus(freshAttempt(attempt.id))).toBe('approved');
    // The issue body changed to a different script.
    (opts.github.getIssue as ReturnType<typeof vi.fn>).mockResolvedValue(
      issueWithSpec('echo changed')
    );
    const attempt2 = verifyingAttemptForHead('head-2', attempt);
    const result = await verifyRemediationOnce(attempt2, task, opts);
    expect(result).toBe('verification_unverified');
    const latest = listVerifications(attempt.id)
      .filter((row) => row.kind === 'command')
      .at(-1);
    expect(latest?.reason).toBe('verification_spec_pending_approval');
    expect(approvalStatus(freshAttempt(attempt.id))).toBe('pending_approval');
  });

  it('is idempotent per head and re-runs for a new head', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const opts = options();
    (opts.runCommand as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        status: 'failed',
        exitCode: 1,
        output: 'bad',
        startedAt: 1,
        finishedAt: 2,
      } satisfies CommandRunResult)
      .mockResolvedValue({
        status: 'passed',
        exitCode: 0,
        output: 'ok',
        startedAt: 3,
        finishedAt: 4,
      } satisfies CommandRunResult);

    expect(await verifyRemediationOnce(attempt, task, opts)).toBe('verification_failed');
    const commands = () => listVerifications(attempt.id).filter((r) => r.kind === 'command');
    // A second pass on the same head reuses the recorded failure.
    expect(await verifyRemediationOnce(freshAttempt(attempt.id), task, opts)).toBe(
      'verification_failed'
    );
    expect(opts.runCommand).toHaveBeenCalledTimes(1);

    // New head -> new run with the same approved spec, completing the attempt.
    (opts.github.getPullRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      prResponse('head-2')
    );
    recordPullRequest(attempt.id, {
      prUrl: 'https://github.com/owner/repo/pull/12',
      prNumber: 12,
      prState: 'open',
      prHeadSha: 'head-2',
    });
    expect(await verifyRemediationOnce(freshAttempt(attempt.id), task, opts)).toBe(
      'verification_passed'
    );
    expect(opts.runCommand).toHaveBeenCalledTimes(2);
    expect(commands().filter((r) => r.headSha === 'head-2')).toHaveLength(1);
    expect(commands().filter((r) => r.headSha === 'head-1')).toHaveLength(1);
    expect(freshAttempt(attempt.id).state).toBe('completed');
  });

  it('does not repair completion when the spec was superseded after a recorded pass', async () => {
    const { task, attempt } = verifyingAttempt();
    const approved = approveIssueSpec(attempt.id, 'echo ok');
    recordVerification({
      attemptId: attempt.id,
      headSha: 'head-1',
      kind: 'command',
      status: 'passed',
      specShell: approved.shell,
      specScript: approved.script,
      specSha256: approved.sha256,
    });
    setVerificationCandidate(attempt.id, spec('echo changed'), 'operator');
    const opts = options();
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_unverified');
    expect(opts.runCommand).not.toHaveBeenCalled();
    expect(freshAttempt(attempt.id).state).toBe('verifying');
  });

  it('records a passed row but does not complete when the spec was superseded during the run', async () => {
    const { task, attempt } = verifyingAttempt();
    const approved = approveIssueSpec(attempt.id, 'echo ok');
    const opts = options({
      runCommand: vi.fn(() => {
        setVerificationCandidate(attempt.id, spec('echo other'), 'operator');
        return Promise.resolve({
          status: 'passed',
          exitCode: 0,
          output: 'ok',
          startedAt: 1,
          finishedAt: 2,
        } satisfies CommandRunResult);
      }),
    });
    const result = await verifyRemediationOnce(attempt, task, opts);
    expect(result).toBe('verification_passed');
    const updated = freshAttempt(attempt.id);
    expect(updated.state).toBe('verifying');
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command).toMatchObject({ status: 'passed', specSha256: approved.sha256 });
  });

  it('records checkout_failed errors without running the command', async () => {
    const { task, attempt } = verifyingAttempt();
    approveIssueSpec(attempt.id, 'echo ok');
    const opts = options();
    (opts.checkout as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('git exploded'));
    expect(await verifyRemediationOnce(attempt, task, opts)).toBe('verification_error');
    expect(opts.runCommand).not.toHaveBeenCalled();
    const command = listVerifications(attempt.id).find((row) => row.kind === 'command');
    expect(command).toMatchObject({ status: 'error', reason: 'checkout_failed' });
  });
});

function verifyingAttemptForHead(headSha: string, attempt: { id: number }) {
  const current = freshAttempt(attempt.id);
  return { ...current, state: 'verifying' as const, prHeadSha: headSha };
}
