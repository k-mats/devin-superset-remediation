import { z } from 'zod';

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
  githubPollIntervalMs: z.coerce.number().int().min(0).max(2_147_483_647).default(60_000),
  devinApiKey: z.string().optional(),
  devinOrgId: z.string().optional(),
  devinApiUrl: z.url().default('https://api.devin.ai/v3'),
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
    githubWebhookSecret: process.env['GITHUB_WEBHOOK_SECRET'],
    githubToken: envValue('GITHUB_TOKEN'),
    githubRepoOwner: envValue('GITHUB_REPO_OWNER'),
    githubRepoName: envValue('GITHUB_REPO_NAME'),
    githubIntakeLabel: envValue('GITHUB_INTAKE_LABEL'),
    githubPollIntervalMs: envValue('GITHUB_POLL_INTERVAL_MS'),
    devinApiKey: envValue('DEVIN_API_KEY'),
    devinOrgId: envValue('DEVIN_ORG_ID'),
    devinApiUrl: envValue('DEVIN_API_URL'),
  });
}

export const config = loadConfig();
