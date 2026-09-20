import 'dotenv/config';
import Fastify from 'fastify';

import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { closeDb, runMigrations } from './db/client.js';
import { createGitHubClientFromConfig } from './github/client.js';
import { startIntakePoller } from './intake/github-intake.js';

export async function buildServer() {
  // Bring the schema up to date before the server can accept traffic.
  runMigrations();

  const server = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  await server.register(healthRoutes);

  let stopIntakePoller: (() => void) | undefined;
  if (config.githubPollIntervalMs === 0) {
    server.log.info('GitHub intake polling disabled');
  } else {
    const repoOwner = config.githubRepoOwner;
    const repoName = config.githubRepoName;
    const token = config.githubToken;
    const missing: string[] = [];
    if (!token) missing.push('GITHUB_TOKEN');
    if (!repoOwner) missing.push('GITHUB_REPO_OWNER');
    if (!repoName) missing.push('GITHUB_REPO_NAME');
    if (!token || !repoOwner || !repoName) {
      server.log.warn(
        { missing },
        'GitHub intake polling skipped because configuration is incomplete'
      );
    } else {
      const client = createGitHubClientFromConfig(config);
      const poller = startIntakePoller({
        client,
        repoOwner,
        repoName,
        label: config.githubIntakeLabel,
        intervalMs: config.githubPollIntervalMs,
        logger: server.log,
      });
      stopIntakePoller = () => {
        poller.stop();
      };
    }
  }

  // Clean up resources whenever the Fastify instance is closed.
  server.addHook('onClose', () => {
    stopIntakePoller?.();
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
