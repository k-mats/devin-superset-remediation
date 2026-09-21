import { spawn } from 'node:child_process';
import type { VerificationSpec } from './spec.js';

export interface VerificationWorkspace {
  cwd: string;
  env: Record<string, string>;
}

export interface CommandRunResult {
  status: 'passed' | 'failed' | 'error';
  reason?: 'timeout' | 'spawn_failed';
  exitCode: number | null;
  output: string;
  startedAt: number;
  finishedAt: number;
}

const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'] as const;

export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env['CI'] = '1';
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

export async function runVerificationCommand(
  spec: VerificationSpec,
  workspace: VerificationWorkspace,
  opts: { timeoutMs: number; maxOutputBytes: number }
): Promise<CommandRunResult> {
  const startedAt = Date.now();
  const argv: [string, string[]] =
    spec.shell === 'bash'
      ? ['bash', ['-euo', 'pipefail', '-c', spec.script]]
      : ['sh', ['-eu', '-c', spec.script]];

  return new Promise<CommandRunResult>((resolve) => {
    const child = spawn(argv[0], argv[1], {
      cwd: workspace.cwd,
      env: workspace.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const buffers: Buffer[] = [];
    let retainedBytes = 0;
    let droppedBytes = 0;
    const pushChunk = (chunk: Buffer) => {
      buffers.push(chunk);
      retainedBytes += chunk.length;
      while (retainedBytes > opts.maxOutputBytes) {
        const head = buffers[0];
        if (head === undefined) break;
        const excess = retainedBytes - opts.maxOutputBytes;
        if (head.length <= excess) {
          buffers.shift();
          retainedBytes -= head.length;
          droppedBytes += head.length;
        } else {
          buffers[0] = head.subarray(excess);
          retainedBytes -= excess;
          droppedBytes += excess;
        }
      }
    };
    const capturedOutput = () =>
      (droppedBytes > 0 ? `[truncated ${String(droppedBytes)} bytes]\n` : '') +
      Buffer.concat(buffers).toString('utf8');
    let settled = false;
    const finish = (result: Omit<CommandRunResult, 'startedAt' | 'finishedAt' | 'output'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        output: capturedOutput(),
        startedAt,
        finishedAt: Date.now(),
      });
    };

    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already exited.
        }
      }
      finish({ status: 'error', reason: 'timeout', exitCode: null });
    }, opts.timeoutMs);

    child.stdout.on('data', pushChunk);
    child.stderr.on('data', pushChunk);
    child.on('error', () => {
      finish({ status: 'error', reason: 'spawn_failed', exitCode: null });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        finish({ status: 'passed', exitCode: 0 });
      } else {
        finish({ status: 'failed', exitCode: code });
      }
    });
  });
}
