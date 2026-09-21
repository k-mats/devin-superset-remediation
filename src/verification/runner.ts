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

function truncateTail(output: Buffer, maxBytes: number): string {
  if (output.length <= maxBytes) {
    return output.toString('utf8');
  }
  const tail = output.subarray(output.length - maxBytes);
  return `[truncated ${String(output.length - maxBytes)} bytes]\n${tail.toString('utf8')}`;
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

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: Omit<CommandRunResult, 'startedAt' | 'finishedAt' | 'output'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        output: truncateTail(Buffer.concat(chunks), opts.maxOutputBytes),
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

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
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
