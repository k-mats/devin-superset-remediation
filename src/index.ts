import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';

import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { closeDb, runMigrations } from './db/client.js';

export async function buildServer() {
  // Bring the schema up to date before the server can accept traffic.
  runMigrations();

  const server = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  await server.register(cors, {
    origin: config.corsAllowedOrigins.length > 0 ? config.corsAllowedOrigins : false,
  });
  await server.register(healthRoutes);

  // Clean up resources whenever the Fastify instance is closed.
  server.addHook('onClose', () => {
    closeDb();
  });

  return server;
}

async function start() {
  const server = await buildServer();

  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'Shutting down');

    try {
      await server.close();
      process.exit(0);
    } catch (error: unknown) {
      server.log.error(error, 'Failed to shut down cleanly');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await server.listen({
    port: config.port,
    host: config.host,
  });
}

if (import.meta.main) {
  start().catch((error: unknown) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
