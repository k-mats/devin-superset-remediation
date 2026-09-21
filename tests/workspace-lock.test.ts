import { describe, expect, it } from 'vitest';
import { createWorkspaceLock } from '../src/verification/workspace-lock.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('WorkspaceLock', () => {
  it('serializes runs for the same key', async () => {
    const lock = createWorkspaceLock();
    const firstRelease = deferred<string>();
    const firstStarted = deferred<string>();
    const events: string[] = [];

    const first = lock.run('repo', async () => {
      events.push('first:start');
      firstStarted.resolve('started');
      await firstRelease.promise;
      events.push('first:end');
    });
    await firstStarted.promise;
    const second = lock.run('repo', () => {
      events.push('second:start');
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    firstRelease.resolve('released');
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('allows different keys to interleave', async () => {
    const lock = createWorkspaceLock();
    const firstRelease = deferred<string>();
    const firstStarted = deferred<string>();
    const events: string[] = [];

    const first = lock.run('repo-a', async () => {
      events.push('first:start');
      firstStarted.resolve('started');
      await firstRelease.promise;
      events.push('first:end');
    });
    await firstStarted.promise;
    const second = lock.run('repo-b', () => {
      events.push('second:start');
      events.push('second:end');
      return Promise.resolve();
    });

    await second;
    expect(events).toEqual(['first:start', 'second:start', 'second:end']);
    firstRelease.resolve('released');
    await first;
    expect(events).toEqual(['first:start', 'second:start', 'second:end', 'first:end']);
  });

  it('releases the lock when a run rejects', async () => {
    const lock = createWorkspaceLock();
    const firstError = new Error('first failed');
    const first = lock.run('repo', () => Promise.reject(firstError));
    await expect(first).rejects.toBe(firstError);

    const second = await lock.run('repo', () => Promise.resolve('second'));
    expect(second).toBe('second');
  });
});
