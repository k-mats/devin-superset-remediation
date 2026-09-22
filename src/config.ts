import { z } from 'zod';
import { DEVIN_REQUEST_TIMEOUT_MS } from './devin/client.js';

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  databasePath: z.string().default('./data/orchestrator.db'),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  githubWebhookSecret: z.string().optional(),
  githubToken: z.string().optional(),
  githubRepoOwner: z.string().optional(),
  githubRepoName: z.string().optional(),
  githubIntakeLabel: z.string().default('devin-ready'),
  githubVerifiedLabel: z.string().default('devin-verified'),
  githubPollIntervalMs: z.coerce.number().int().min(0).max(2_147_483_647).default(60_000),
  devinApiKey: z.string().optional(),
  devinOrgId: z.string().optional(),
  devinApiUrl: z.url().default('https://api.devin.ai/v3'),
  devinDispatchIntervalMs: z.coerce.number().int().min(0).max(2_147_483_647).default(60_000),
  devinTrackingIntervalMs: z.coerce.number().int().min(0).max(2_147_483_647).default(60_000),
  devinReconcileIntervalMs: z.coerce.number().int().min(0).max(2_147_483_647).default(60_000),
  // Must exceed the create-session request timeout so a timed-out dispatch is
  // never reconciled while its request may still be in flight.
  devinDispatchGraceMs: z.coerce
    .number()
    .int()
    .gt(DEVIN_REQUEST_TIMEOUT_MS)
    .max(2_147_483_647)
    .default(300_000),
  devinSessionStaleWarnMs: z.coerce.number().int().min(0).max(2_147_483_647).default(21_600_000),
  devinMaxAcuPerSession: z.coerce.number().positive().default(5),
  verificationEnabled: z
    .preprocess((value) => (value === 'false' || value === '0' ? false : value), z.coerce.boolean())
    .default(true),
  verificationWorkspaceRoot: z.string().default('./data/verification'),
  verificationCommandTimeoutMs: z.coerce.number().int().min(0).default(900_000),
  verificationSetupTimeoutMs: z.coerce.number().int().min(0).default(1_800_000),
  verificationCheckoutTimeoutMs: z.coerce.number().int().min(0).default(300_000),
  verificationMaxOutputBytes: z.coerce.number().int().positive().default(16_384),
});

// Treat blank env vars (e.g. `DEVIN_API_URL=` in .env) as unset so defaults apply.
function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    port: process.env['PORT'],
    host: process.env['HOST'],
    nodeEnv: process.env['NODE_ENV'],
    databasePath: process.env['DATABASE_PATH'],
    logLevel: process.env['LOG_LEVEL'],
    githubWebhookSecret: envValue('GITHUB_WEBHOOK_SECRET'),
    githubToken: envValue('GITHUB_TOKEN'),
    githubRepoOwner: envValue('GITHUB_REPO_OWNER'),
    githubRepoName: envValue('GITHUB_REPO_NAME'),
    githubIntakeLabel: envValue('GITHUB_INTAKE_LABEL'),
    // Not envValue(): an empty GITHUB_VERIFIED_LABEL disables verified labelling.
    githubVerifiedLabel: process.env['GITHUB_VERIFIED_LABEL'],
    githubPollIntervalMs: envValue('GITHUB_POLL_INTERVAL_MS'),
    devinApiKey: envValue('DEVIN_API_KEY'),
    devinOrgId: envValue('DEVIN_ORG_ID'),
    devinApiUrl: envValue('DEVIN_API_URL'),
    devinDispatchIntervalMs: envValue('DEVIN_DISPATCH_INTERVAL_MS'),
    devinTrackingIntervalMs: envValue('DEVIN_TRACKING_INTERVAL_MS'),
    devinReconcileIntervalMs: envValue('DEVIN_RECONCILE_INTERVAL_MS'),
    devinDispatchGraceMs: envValue('DEVIN_DISPATCH_GRACE_MS'),
    devinSessionStaleWarnMs: envValue('DEVIN_SESSION_STALE_WARN_MS'),
    devinMaxAcuPerSession: envValue('DEVIN_MAX_ACU_PER_SESSION'),
    verificationEnabled: envValue('VERIFICATION_ENABLED'),
    verificationWorkspaceRoot: envValue('VERIFICATION_WORKSPACE_ROOT'),
    verificationCommandTimeoutMs: envValue('VERIFICATION_COMMAND_TIMEOUT_MS'),
    verificationSetupTimeoutMs: envValue('VERIFICATION_SETUP_TIMEOUT_MS'),
    verificationCheckoutTimeoutMs: envValue('VERIFICATION_CHECKOUT_TIMEOUT_MS'),
    verificationMaxOutputBytes: envValue('VERIFICATION_MAX_OUTPUT_BYTES'),
  });
}

export const config = loadConfig();
