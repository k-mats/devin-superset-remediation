import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { runMigrations } from '../src/db/client.js';

describe('Health Endpoint', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    runMigrations();
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('should return 200 and health status', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload) as { status: string; timestamp: string };
    expect(payload).toHaveProperty('status', 'ok');
    expect(payload).toHaveProperty('timestamp');
  });

  it('should return 200 and ready status with database connectivity', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload) as {
      status: string;
      database: string;
      timestamp: string;
    };
    expect(payload).toHaveProperty('status', 'ready');
    expect(payload).toHaveProperty('database', 'connected');
    expect(payload).toHaveProperty('timestamp');
  });
});
