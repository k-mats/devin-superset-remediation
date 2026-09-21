import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supersetSetupAdapter } from '../src/verification/repo-setup.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const originalPath = process.env['PATH'];
afterEach(() => {
  process.env['PATH'] = originalPath;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() ?? '', { recursive: true, force: true });
  }
});

function fakeUvDir(): string {
  const dir = tempDir('fake-uv-');
  const uv = path.join(dir, 'uv');
  fs.writeFileSync(
    uv,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "uv 0.0.0"; exit 0;;',
      '  venv) mkdir -p "$2/bin"; exit 0;;',
      '  pip) exit 0;;',
      '  *) exit 1;;',
      'esac',
    ].join('\n')
  );
  fs.chmodSync(uv, 0o755);
  process.env['PATH'] = `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`;
  return dir;
}

function workspaceDir(requirementsContent = 'dep-a==1\n'): string {
  const dir = tempDir('setup-ws-');
  fs.mkdirSync(path.join(dir, 'requirements'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'requirements', 'development.txt'), requirementsContent);
  return dir;
}

function requirementsSha(cwd: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(cwd, 'requirements', 'development.txt')))
    .digest('hex');
}

describe('supersetSetupAdapter', () => {
  it('creates a missing venv and records the requirements hash', async () => {
    fakeUvDir();
    const cwd = workspaceDir();

    const env = await supersetSetupAdapter.setup({ cwd }, { timeoutMs: 10_000, logger });

    expect(fs.existsSync(path.join(cwd, '.venv', 'bin'))).toBe(true);
    expect(fs.readFileSync(path.join(cwd, '.venv', '.requirements-sha256'), 'utf8').trim()).toBe(
      requirementsSha(cwd)
    );
    expect(env['VIRTUAL_ENV']).toBe(path.join(cwd, '.venv'));
    expect(env['PATH']).toContain(path.join(cwd, '.venv', 'bin'));
  });

  it('removes and recreates the venv when the requirements hash changed', async () => {
    fakeUvDir();
    const cwd = workspaceDir();
    const venv = path.join(cwd, '.venv');
    fs.mkdirSync(venv, { recursive: true });
    fs.writeFileSync(path.join(venv, 'sentinel'), 'stale');
    fs.writeFileSync(path.join(venv, '.requirements-sha256'), 'deadbeef\n');

    await supersetSetupAdapter.setup({ cwd }, { timeoutMs: 10_000, logger });

    expect(fs.existsSync(path.join(venv, 'sentinel'))).toBe(false);
    expect(fs.existsSync(path.join(venv, 'bin'))).toBe(true);
    expect(fs.readFileSync(path.join(venv, '.requirements-sha256'), 'utf8').trim()).toBe(
      requirementsSha(cwd)
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'requirements_changed' }),
      expect.any(String)
    );
  });

  it('keeps the venv when the recorded requirements hash matches', async () => {
    fakeUvDir();
    const cwd = workspaceDir();
    const venv = path.join(cwd, '.venv');
    fs.mkdirSync(venv, { recursive: true });
    fs.writeFileSync(path.join(venv, 'sentinel'), 'keep');
    fs.writeFileSync(path.join(venv, '.requirements-sha256'), `${requirementsSha(cwd)}\n`);

    await supersetSetupAdapter.setup({ cwd }, { timeoutMs: 10_000, logger });

    expect(fs.existsSync(path.join(venv, 'sentinel'))).toBe(true);
  });
});
