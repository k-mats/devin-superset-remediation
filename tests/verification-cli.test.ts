import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'fs';
import path from 'node:path';

const databasePath = path.resolve('./test-verification-cli.db');
const cliDir = path.resolve('src/cli');

function removeDatabaseFiles() {
  for (const suffix of ['', '-shm', '-wal']) {
    const file = `${databasePath}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function runCli(
  script: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'pnpm',
      ['exec', 'tsx', path.join(cliDir, script), ...args],
      {
        env: { ...process.env, DATABASE_PATH: databasePath },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(new Error(error.message));
          return;
        }
        resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr });
      }
    );
  });
}

describe('verification CLI entrypoints', () => {
  let candidateSha: string;

  beforeAll(async () => {
    removeDatabaseFiles();
    process.env['DATABASE_PATH'] = databasePath;
    const { runMigrations, closeDb } = await import('../src/db/client.js');
    const { upsertTask, createAttempt } = await import('../src/db/task-state.js');
    runMigrations();
    const task = upsertTask({
      repoOwner: 'owner',
      repoName: 'repo',
      issueNumber: 1,
      title: 'cli test',
    });
    createAttempt(task.id);
    closeDb();
  });

  afterAll(() => {
    removeDatabaseFiles();
    delete process.env['DATABASE_PATH'];
  });

  it('prints usage and exits 1 without arguments', async () => {
    const result = await runCli('verification-approve.ts', []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage: verification-approve');
  });

  it('proposes a spec candidate and prints its sha256', async () => {
    const result = await runCli('verification-propose.ts', [
      '--attempt',
      '1',
      '--command',
      'echo ok',
    ]);
    expect(result.code).toBe(0);
    const match = /Candidate sha256: ([0-9a-f]{64})/.exec(result.stdout);
    expect(match).not.toBeNull();
    candidateSha = match?.[1] ?? '';
    expect(result.stdout).toContain(`--spec-hash ${candidateSha}`);
  });

  it('rejects a wrong spec hash', async () => {
    const wrong = '0'.repeat(64);
    const result = await runCli('verification-approve.ts', [
      '--attempt',
      '1',
      '--spec-hash',
      wrong,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('does not match');
  });

  it('approves the candidate spec', async () => {
    const result = await runCli('verification-approve.ts', [
      '--attempt',
      '1',
      '--spec-hash',
      candidateSha,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`New approved sha256:      ${candidateSha}`);

    const { getDb, closeDb } = await import('../src/db/client.js');
    const { getAttempt } = await import('../src/db/task-state.js');
    const attempt = getAttempt(1, getDb());
    closeDb();
    expect(attempt?.verificationApprovedSha256).toBe(candidateSha);
  });

  it('shows the attempt including approval status', async () => {
    const result = await runCli('verification-show.ts', ['--attempt', '1']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Approval status');
  });
});
