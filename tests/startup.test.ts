import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import net from 'node:net';

const databasePath = './test-startup.db';

function removeDatabaseFiles() {
  for (const suffix of ['', '-shm', '-wal']) {
    const file = `${databasePath}${suffix}`;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

describe('Startup on a fresh database', () => {
  afterAll(() => {
    removeDatabaseFiles();
  });

  it('creates the schema and reports ready', async () => {
    process.env['DATABASE_PATH'] = databasePath;
    removeDatabaseFiles();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { buildServer } = await import('../src/index.js');
    const { getRawDb } = await import('../src/db/client.js');

    const server = await buildServer();
    await server.ready();

    try {
      const table = getRawDb()
        ?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
        .get();
      expect(table).toBeDefined();

      const response = await server.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
      fetchSpy.mockRestore();
    }
  });

  it('warns and skips intake when polling is enabled without a token', async () => {
    process.env['DATABASE_PATH'] = databasePath;
    process.env['GITHUB_POLL_INTERVAL_MS'] = '1000';
    delete process.env['GITHUB_TOKEN'];
    delete process.env['GITHUB_REPO_OWNER'];
    delete process.env['GITHUB_REPO_NAME'];
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { buildServer } = await import('../src/index.js');
    const server = await buildServer();

    try {
      await server.ready();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
      fetchSpy.mockRestore();
      process.env['GITHUB_POLL_INTERVAL_MS'] = '0';
    }
  });

  it('leaves the webhook route unregistered when no secret is configured', async () => {
    process.env['DATABASE_PATH'] = databasePath;
    process.env['GITHUB_WEBHOOK_SECRET'] = '';
    process.env['GITHUB_REPO_OWNER'] = 'owner';
    process.env['GITHUB_REPO_NAME'] = 'repo';
    vi.resetModules();
    const { buildServer } = await import('../src/index.js');
    const server = await buildServer();

    try {
      await server.ready();
      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
      delete process.env['GITHUB_WEBHOOK_SECRET'];
      delete process.env['GITHUB_REPO_OWNER'];
      delete process.env['GITHUB_REPO_NAME'];
    }
  });

  it('skips the webhook route when the secret is set but the repository is not', async () => {
    process.env['DATABASE_PATH'] = databasePath;
    process.env['GITHUB_WEBHOOK_SECRET'] = 'secret';
    delete process.env['GITHUB_REPO_OWNER'];
    delete process.env['GITHUB_REPO_NAME'];
    vi.resetModules();
    const { buildServer } = await import('../src/index.js');
    const server = await buildServer();

    try {
      await server.ready();
      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
      delete process.env['GITHUB_WEBHOOK_SECRET'];
    }
  });

  it('registers the signed webhook route without a GitHub token and keeps other routes intact', async () => {
    process.env['DATABASE_PATH'] = databasePath;
    process.env['GITHUB_WEBHOOK_SECRET'] = 'secret';
    process.env['GITHUB_REPO_OWNER'] = 'owner';
    process.env['GITHUB_REPO_NAME'] = 'repo';
    delete process.env['GITHUB_TOKEN'];
    vi.resetModules();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { buildServer } = await import('../src/index.js');
    const server = await buildServer();

    try {
      await server.ready();
      const unsigned = await server.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
        payload: '{}',
      });
      expect(unsigned.statusCode).toBe(401);
      const report = await server.inject({ method: 'GET', url: '/api/report' });
      expect(report.statusCode).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
      fetchSpy.mockRestore();
      delete process.env['GITHUB_WEBHOOK_SECRET'];
      delete process.env['GITHUB_REPO_OWNER'];
      delete process.env['GITHUB_REPO_NAME'];
    }
  });

  it('stops polling before closing an idle connection', async () => {
    process.env['DATABASE_PATH'] = databasePath;
    process.env['GITHUB_POLL_INTERVAL_MS'] = '25';
    process.env['GITHUB_TOKEN'] = 'test-token';
    process.env['GITHUB_REPO_OWNER'] = 'owner';
    process.env['GITHUB_REPO_NAME'] = 'repo';
    removeDatabaseFiles();
    vi.resetModules();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('[]', { status: 200 })));
    const { buildServer } = await import('../src/index.js');
    const server = await buildServer();
    let socket: net.Socket | undefined;

    try {
      await server.listen({ port: 0, host: '127.0.0.1' });
      const address = server.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Server address was not available');
      }
      socket = net.createConnection({ port: address.port, host: '127.0.0.1' });
      await new Promise<void>((resolve, reject) => {
        socket?.once('connect', resolve);
        socket?.once('error', reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      const fetchCountBeforeClose = fetchSpy.mock.calls.length;

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const closeResult = await Promise.race([
        server.close().then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => {
          timeoutHandle = setTimeout(() => {
            resolve('timeout');
          }, 2_000);
        }),
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      expect(closeResult).toBe('closed');
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(fetchSpy).toHaveBeenCalledTimes(fetchCountBeforeClose);
    } finally {
      socket?.destroy();
      if (server.server.listening) {
        await server.close();
      }
      fetchSpy.mockRestore();
      process.env['GITHUB_POLL_INTERVAL_MS'] = '0';
      delete process.env['GITHUB_TOKEN'];
      delete process.env['GITHUB_REPO_OWNER'];
      delete process.env['GITHUB_REPO_NAME'];
    }
  });
});
