import 'dotenv/config';
import Fastify from 'fastify';

import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { closeDb, runMigrations } from './db/client.js';
import { createGitHubClientFromConfig, type GitHubClient } from './github/client.js';
import { createDevinClientFromConfig } from './devin/client.js';
import { startIntakePoller } from './intake/github-intake.js';
import { startDispatchPoller } from './dispatch/devin-dispatcher.js';

export async function buildServer() {
  // Bring the schema up to date before the server can accept traffic.
  runMigrations();

  const server = Fastify({
    logger: {
      level: config.logLevel,
    },
    forceCloseConnections: true,
  });

  await server.register(healthRoutes);

  let githubClient: GitHubClient | undefined;
  const getGitHubClient = () => {
    githubClient ??= createGitHubClientFromConfig(config);
    return githubClient;
  };

  let stopIntakePoller: (() => Promise<void>) | undefined;
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
      const poller = startIntakePoller({
        client: getGitHubClient(),
        repoOwner,
        repoName,
        label: config.githubIntakeLabel,
        intervalMs: config.githubPollIntervalMs,
        logger: server.log,
      });
      stopIntakePoller = () => {
        return poller.stop();
      };
    }
  }

  let stopDispatchPoller: (() => Promise<void>) | undefined;
  if (config.devinDispatchIntervalMs === 0) {
    server.log.info('Devin dispatch polling disabled');
  } else {
    const missing: string[] = [];
    if (!config.githubToken) missing.push('GITHUB_TOKEN');
    if (!config.githubRepoOwner) missing.push('GITHUB_REPO_OWNER');
    if (!config.githubRepoName) missing.push('GITHUB_REPO_NAME');
    if (!config.devinApiKey) missing.push('DEVIN_API_KEY');
    if (!config.devinOrgId) missing.push('DEVIN_ORG_ID');
    if (missing.length > 0) {
      server.log.warn(
        { missing },
        'Devin dispatch polling skipped because configuration is incomplete'
      );
    } else {
      const poller = startDispatchPoller({
        github: getGitHubClient(),
        devin: createDevinClientFromConfig(config),
        label: config.githubIntakeLabel,
        maxAcuPerSession: config.devinMaxAcuPerSession,
        intervalMs: config.devinDispatchIntervalMs,
        logger: server.log,
      });
      stopDispatchPoller = () => {
        return poller.stop();
      };
    }
  }

  server.addHook('preClose', async () => {
    await stopIntakePoller?.();
    await stopDispatchPoller?.();
  });

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
