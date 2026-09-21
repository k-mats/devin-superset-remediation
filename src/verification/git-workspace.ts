import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { baseEnv } from './runner.js';

const execFileAsync = promisify(execFile);

export class CheckoutMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(`Checkout mismatch: expected ${expected} but HEAD is ${actual}`);
    this.name = 'CheckoutMismatchError';
  }
}

export interface CheckoutInput {
  cloneUrl: string;
  headSha: string;
  workspaceDir: string;
  timeoutMs: number;
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
}

async function git(args: string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: baseEnv(),
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function checkoutExactSha(input: CheckoutInput): Promise<void> {
  const gitDir = path.join(input.workspaceDir, '.git');
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(path.dirname(input.workspaceDir), { recursive: true });
    await git(
      ['clone', '--filter=blob:none', '--no-checkout', input.cloneUrl, input.workspaceDir],
      undefined,
      input.timeoutMs
    );
  } else {
    try {
      await git(['fetch', 'origin', input.headSha], input.workspaceDir, input.timeoutMs);
    } catch (error: unknown) {
      input.logger.warn(
        { err: error, head_sha: input.headSha },
        'Fetching the exact commit failed; falling back to a full origin fetch'
      );
      await git(['fetch', 'origin'], input.workspaceDir, input.timeoutMs);
    }
  }

  await git(
    ['checkout', '--detach', '--force', input.headSha],
    input.workspaceDir,
    input.timeoutMs
  );
  await git(['clean', '-fdx', '-e', '.venv'], input.workspaceDir, input.timeoutMs);
  const head = await git(['rev-parse', 'HEAD'], input.workspaceDir, input.timeoutMs);
  if (head !== input.headSha) {
    throw new CheckoutMismatchError(input.headSha, head);
  }
}
