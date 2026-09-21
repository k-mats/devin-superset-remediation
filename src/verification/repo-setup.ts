import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import type { Task } from '../db/schema.js';
import { baseEnv } from './runner.js';

const execFileAsync = promisify(execFile);
const OUTPUT_TAIL_BYTES = 4096;

export class SetupError extends Error {
  constructor(
    public readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'SetupError';
  }
}

export interface RepoSetupAdapter {
  name: string;
  setup(
    workspace: { cwd: string },
    opts: {
      timeoutMs: number;
      logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
    }
  ): Promise<Record<string, string>>;
}

export const noopSetupAdapter: RepoSetupAdapter = {
  name: 'noop',
  setup: () => Promise.resolve({}),
};

function tail(output: string): string {
  return output.length > OUTPUT_TAIL_BYTES ? output.slice(-OUTPUT_TAIL_BYTES) : output;
}

async function runSetupCommand(
  argv: [string, ...string[]],
  cwd: string,
  timeoutMs: number,
  reason: string
): Promise<void> {
  try {
    await execFileAsync(argv[0], argv.slice(1), {
      cwd,
      env: baseEnv(),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error: unknown) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    const detail =
      stderr !== '' ? tail(stderr) : error instanceof Error ? error.message : String(error);
    throw new SetupError(reason, `${argv.join(' ')} failed: ${detail}`);
  }
}

async function requireBinary(binary: string, cwd: string, timeoutMs: number): Promise<void> {
  try {
    await execFileAsync(binary, ['--version'], { cwd, env: baseEnv(), timeout: timeoutMs });
  } catch (error: unknown) {
    throw new SetupError(
      `${binary}_not_found`,
      `Required setup tool '${binary}' is not available: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

const REQUIREMENTS_FILE = 'requirements/development.txt';
const REQUIREMENTS_MARKER = '.requirements-sha256';

function requirementsSha256(cwd: string): string {
  try {
    return createHash('sha256')
      .update(fs.readFileSync(path.join(cwd, REQUIREMENTS_FILE)))
      .digest('hex');
  } catch (error: unknown) {
    throw new SetupError(
      'install_failed',
      `Cannot read ${REQUIREMENTS_FILE}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export const supersetSetupAdapter: RepoSetupAdapter = {
  name: 'superset',
  async setup(workspace, opts) {
    await requireBinary('uv', workspace.cwd, opts.timeoutMs);
    const venvDir = path.join(workspace.cwd, '.venv');
    const markerPath = path.join(venvDir, REQUIREMENTS_MARKER);
    const requirementsSha = requirementsSha256(workspace.cwd);
    if (fs.existsSync(venvDir)) {
      const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : null;
      if (marker !== requirementsSha) {
        opts.logger.info(
          { reason: 'requirements_changed', cwd: workspace.cwd },
          'Recreating the verification virtualenv'
        );
        fs.rmSync(venvDir, { recursive: true, force: true });
      }
    }
    if (!fs.existsSync(venvDir)) {
      await runSetupCommand(
        ['uv', 'venv', '.venv', '--python', '3.12'],
        workspace.cwd,
        opts.timeoutMs,
        'venv_failed'
      );
    }
    await runSetupCommand(
      ['uv', 'pip', 'install', '-r', REQUIREMENTS_FILE],
      workspace.cwd,
      opts.timeoutMs,
      'install_failed'
    );
    fs.writeFileSync(markerPath, `${requirementsSha}\n`);
    return {
      PATH: `${venvDir}/bin:${baseEnv()['PATH'] ?? ''}`,
      VIRTUAL_ENV: venvDir,
      PYTHONDONTWRITEBYTECODE: '1',
    };
  },
};

export function resolveSetupAdapter(task: Pick<Task, 'repoName'>): RepoSetupAdapter {
  return task.repoName.toLowerCase() === 'superset' ? supersetSetupAdapter : noopSetupAdapter;
}
