import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  databasePath: z.string().default('./data/orchestrator.db'),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  // Future configurations
  githubWebhookSecret: z.string().optional(),
  githubToken: z.string().optional(),
  githubRepoOwner: z.string().optional(),
  githubRepoName: z.string().optional(),
  devinApiKey: z.string().optional(),
  devinOrgId: z.string().optional(),
  devinApiUrl: z.string().default('https://api.devin.ai/v3'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    port: process.env['PORT'],
    host: process.env['HOST'],
    nodeEnv: process.env['NODE_ENV'],
    databasePath: process.env['DATABASE_PATH'],
    logLevel: process.env['LOG_LEVEL'],
    githubWebhookSecret: process.env['GITHUB_WEBHOOK_SECRET'],
    githubToken: process.env['GITHUB_TOKEN'],
    githubRepoOwner: process.env['GITHUB_REPO_OWNER'],
    githubRepoName: process.env['GITHUB_REPO_NAME'],
    devinApiKey: process.env['DEVIN_API_KEY'],
    devinOrgId: process.env['DEVIN_ORG_ID'],
    devinApiUrl: process.env['DEVIN_API_URL'],
  });
}

export const config = loadConfig();
