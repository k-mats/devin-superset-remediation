export interface WorkspaceLock {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createWorkspaceLock(): WorkspaceLock {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const tail = previous.then(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
      tails.set(key, tail);

      return previous.then(fn).finally(() => {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      });
    },
  };
}

export const defaultWorkspaceLock = createWorkspaceLock();
