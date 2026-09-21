import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutExactSha, CheckoutMismatchError } from '../src/verification/git-workspace.js';
import { baseEnv, runVerificationCommand } from '../src/verification/runner.js';
import { hashVerificationSpec, type VerificationSpec } from '../src/verification/spec.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function spec(script: string, shell: 'bash' | 'sh' = 'bash'): VerificationSpec {
  return { shell, script, sha256: hashVerificationSpec(shell, script) };
}

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() ?? '', { recursive: true, force: true });
  }
});

describe('checkoutExactSha', () => {
  function seedRepo(): { remote: string; shaA: string; shaB: string } {
    const remote = tempDir('verify-remote-');
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: remote, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(remote, 'file.txt'), 'one');
    git(['add', 'file.txt']);
    git(['commit', '-m', 'first']);
    const shaA = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(remote, 'file.txt'), 'two');
    git(['commit', '-am', 'second']);
    const shaB = git(['rev-parse', 'HEAD']);
    return { remote, shaA, shaB };
  }

  it('clones, checks out the exact sha, and switches between shas', async () => {
    const { remote, shaA, shaB } = seedRepo();
    const workspace = path.join(tempDir('verify-ws-'), 'ws');
    const cloneUrl = `file://${remote}`;
    const opts = { cloneUrl, workspaceDir: workspace, timeoutMs: 30_000, logger };

    await checkoutExactSha({ ...opts, headSha: shaA });
    expect(
      execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    ).toBe(shaA);
    expect(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf8')).toBe('one');

    await checkoutExactSha({ ...opts, headSha: shaB });
    expect(fs.readFileSync(path.join(workspace, 'file.txt'), 'utf8')).toBe('two');
  });

  it('cleans untracked files but keeps .venv', async () => {
    const { remote, shaA } = seedRepo();
    const workspace = path.join(tempDir('verify-ws-'), 'ws');
    const cloneUrl = `file://${remote}`;
    const opts = { cloneUrl, workspaceDir: workspace, timeoutMs: 30_000, logger, headSha: shaA };
    await checkoutExactSha(opts);

    fs.writeFileSync(path.join(workspace, 'stray.txt'), 'stray');
    fs.mkdirSync(path.join(workspace, '.venv'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.venv', 'keep'), 'env');
    await checkoutExactSha(opts);

    expect(fs.existsSync(path.join(workspace, 'stray.txt'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, '.venv', 'keep'))).toBe(true);
  });

  it('rejects a sha that cannot be checked out and exposes CheckoutMismatchError', async () => {
    const { remote, shaA } = seedRepo();
    const workspace = path.join(tempDir('verify-ws-'), 'ws');
    await expect(
      checkoutExactSha({
        cloneUrl: `file://${remote}`,
        workspaceDir: workspace,
        timeoutMs: 30_000,
        logger,
        headSha: 'a'.repeat(40),
      })
    ).rejects.toThrow();
    expect(new CheckoutMismatchError('a'.repeat(40), shaA).name).toBe('CheckoutMismatchError');
  });
});

describe('runVerificationCommand', () => {
  const workspace = () => ({ cwd: os.tmpdir(), env: baseEnv() });

  it('reports passed for a zero exit code', async () => {
    const result = await runVerificationCommand(spec('echo ok'), workspace(), {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(result.output).toContain('ok');
  });

  it('reports failed with the exit code', async () => {
    const result = await runVerificationCommand(spec('exit 3'), workspace(), {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({ status: 'failed', exitCode: 3 });
  });

  it('kills the process group on timeout', async () => {
    const result = await runVerificationCommand(spec('sleep 30'), workspace(), {
      timeoutMs: 200,
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({ status: 'error', reason: 'timeout', exitCode: null });
  });

  it('truncates output to the last maxOutputBytes', async () => {
    const result = await runVerificationCommand(
      spec('for i in $(seq 1 5000); do echo line-$i; done'),
      workspace(),
      { timeoutMs: 30_000, maxOutputBytes: 500 }
    );
    expect(result.status).toBe('passed');
    expect(result.output.startsWith('[truncated ')).toBe(true);
    expect(result.output).toContain('line-5000');
  });

  it('does not leak process.env secrets into the child environment', async () => {
    process.env['DEVIN_API_KEY'] = 'sentinel-secret';
    try {
      const result = await runVerificationCommand(
        spec('echo "KEY=${DEVIN_API_KEY:-unset}"', 'sh'),
        workspace(),
        { timeoutMs: 10_000, maxOutputBytes: 1024 }
      );
      expect(result.output).toContain('KEY=unset');
      expect(result.output).not.toContain('sentinel-secret');
      expect(baseEnv()['DEVIN_API_KEY']).toBeUndefined();
      expect(baseEnv()['CI']).toBe('1');
      expect(baseEnv()['GIT_TERMINAL_PROMPT']).toBe('0');
    } finally {
      delete process.env['DEVIN_API_KEY'];
    }
  });

  it('enforces pipefail under bash but not sh', async () => {
    const bashResult = await runVerificationCommand(
      spec('set -o pipefail 2>/dev/null; false | true'),
      workspace(),
      { timeoutMs: 10_000, maxOutputBytes: 1024 }
    );
    expect(bashResult.status).toBe('failed');
    const shResult = await runVerificationCommand(spec('false | true', 'sh'), workspace(), {
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    expect(shResult.status).toBe('passed');
  });
});
