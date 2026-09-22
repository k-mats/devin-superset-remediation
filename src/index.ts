import 'dotenv/config';
import Fastify from 'fastify';

import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { reportRoutes } from './routes/report.js';
import type { WorkerAvailability } from './reporting/state-guidance.js';
import { operatorVerificationRoutes } from './routes/operator-verification.js';
import { githubWebhookRoutes } from './routes/github-webhook.js';
import { closeDb, runMigrations } from './db/client.js';
import { createGitHubClientFromConfig, type GitHubClient } from './github/client.js';
import { createDevinClientFromConfig } from './devin/client.js';
import { startIntakePoller } from './intake/github-intake.js';
import { startDispatchPoller } from './dispatch/devin-dispatcher.js';
import { startTrackingPoller } from './tracking/session-tracker.js';
import { startReconciliationPoller } from './dispatch/reconcile-uncertain-dispatch.js';
import { verificationOptionsFromConfig } from './verification/rerun.js';

export async function buildServer() {
  // Bring the schema up to date before the server can accept traffic.
  runMigrations();

  const server = Fastify({
    logger: {
      level: config.logLevel,
    },
    forceCloseConnections: true,
  });

  let githubClient: GitHubClient | undefined;
  const getGitHubClient = () => {
    githubClient ??= createGitHubClientFromConfig(config);
    return githubClient;
  };

  await server.register(healthRoutes);
  // Flipped to true only when the corresponding poller actually starts below;
  // the dashboard reads this object per request.
  const workers: WorkerAvailability = {
    intake: false,
    dispatch: false,
    tracking: false,
    reconcile: false,
    verification: false,
  };
  await server.register(reportRoutes, { workers });
  await server.register(operatorVerificationRoutes, {
    getGitHubClient: () => (config.githubToken ? getGitHubClient() : undefined),
    verification: config.verificationEnabled ? verificationOptionsFromConfig(config) : undefined,
    logger: server.log,
  });

  if (!config.githubWebhookSecret) {
    server.log.info('GitHub webhook intake disabled (GITHUB_WEBHOOK_SECRET not set)');
  } else if (!config.githubRepoOwner || !config.githubRepoName) {
    const missing: string[] = [];
    if (!config.githubRepoOwner) missing.push('GITHUB_REPO_OWNER');
    if (!config.githubRepoName) missing.push('GITHUB_REPO_NAME');
    server.log.warn(
      { missing },
      'GitHub webhook intake skipped because configuration is incomplete'
    );
  } else {
    await server.register(githubWebhookRoutes, {
      secret: config.githubWebhookSecret,
      repoOwner: config.githubRepoOwner,
      repoName: config.githubRepoName,
      label: config.githubIntakeLabel,
      logger: server.log,
    });
    server.log.info({ path: '/webhooks/github' }, 'GitHub webhook intake enabled');
  }

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
      workers.intake = true;
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
      workers.dispatch = true;
    }
  }

  let stopTrackingPoller: (() => Promise<void>) | undefined;
  if (config.devinTrackingIntervalMs === 0) {
    server.log.info('Devin session tracking polling disabled');
  } else {
    const missing: string[] = [];
    if (!config.githubToken) missing.push('GITHUB_TOKEN');
    if (!config.devinApiKey) missing.push('DEVIN_API_KEY');
    if (!config.devinOrgId) missing.push('DEVIN_ORG_ID');
    if (missing.length > 0) {
      server.log.warn(
        { missing },
        'Devin session tracking polling skipped because configuration is incomplete'
      );
    } else {
      const poller = startTrackingPoller({
        github: getGitHubClient(),
        devin: createDevinClientFromConfig(config),
        staleWarnMs: config.devinSessionStaleWarnMs,
        verifiedLabel: config.githubVerifiedLabel,
        intervalMs: config.devinTrackingIntervalMs,
        logger: server.log,
        verification: config.verificationEnabled
          ? {
              workspaceRoot: config.verificationWorkspaceRoot,
              commandTimeoutMs: config.verificationCommandTimeoutMs,
              setupTimeoutMs: config.verificationSetupTimeoutMs,
              checkoutTimeoutMs: config.verificationCheckoutTimeoutMs,
              maxOutputBytes: config.verificationMaxOutputBytes,
            }
          : undefined,
      });
      stopTrackingPoller = () => poller.stop();
      workers.tracking = true;
      workers.verification = config.verificationEnabled;
    }
  }

  let stopReconciliationPoller: (() => Promise<void>) | undefined;
  if (config.devinReconcileIntervalMs === 0) {
    server.log.info('Devin uncertain-dispatch reconciliation disabled');
  } else {
    const missing: string[] = [];
    if (!config.devinApiKey) missing.push('DEVIN_API_KEY');
    if (!config.devinOrgId) missing.push('DEVIN_ORG_ID');
    if (missing.length > 0) {
      server.log.warn(
        { missing },
        'Devin uncertain-dispatch reconciliation skipped because configuration is incomplete'
      );
    } else {
      const poller = startReconciliationPoller({
        devin: createDevinClientFromConfig(config),
        graceMs: config.devinDispatchGraceMs,
        intervalMs: config.devinReconcileIntervalMs,
        logger: server.log,
      });
      stopReconciliationPoller = () => poller.stop();
      workers.reconcile = true;
    }
  }

  server.addHook('preClose', async () => {
    await Promise.all([
      stopIntakePoller?.(),
      stopDispatchPoller?.(),
      stopTrackingPoller?.(),
      stopReconciliationPoller?.(),
    ]);
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
