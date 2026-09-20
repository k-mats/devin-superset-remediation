import { z } from 'zod';
import type { Config } from '../config.js';

const DEFAULT_BASE_URL = 'https://api.devin.ai/v3';
const MAX_ERROR_BODY_LENGTH = 500;

// Enums per the v3 OpenAPI spec (SessionResponse).
export const SESSION_STATUSES = [
  'new',
  'claimed',
  'running',
  'exit',
  'error',
  'suspended',
  'resuming',
] as const;
export const SESSION_STATUS_DETAILS = [
  'working',
  'waiting_for_user',
  'waiting_for_approval',
  'finished',
  'inactivity',
  'user_request',
  'usage_limit_exceeded',
  'out_of_credits',
  'out_of_quota',
  'no_quota_allocation',
  'payment_declined',
  'org_usage_limit_exceeded',
  'user_usage_limit_exceeded',
  'total_session_limit_exceeded',
  'error',
] as const;
export const SESSION_ORIGINS = [
  'webapp',
  'slack',
  'teams',
  'api',
  'linear',
  'jira',
  'automation',
  'cli',
  'desktop',
  'code_scan',
  'other',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type SessionStatusDetail = (typeof SESSION_STATUS_DETAILS)[number];
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

export const sessionResponseSchema = z
  .object({
    session_id: z.string(),
    url: z.string(),
    status: z.enum(SESSION_STATUSES),
    status_detail: z.enum(SESSION_STATUS_DETAILS).nullish(),
    title: z.string().nullish(),
    tags: z.array(z.string()).default([]),
    origin: z.enum(SESSION_ORIGINS).nullish(),
    service_user_id: z.string().nullish(),
    user_id: z.string().nullish(),
    org_id: z.string(),
    created_at: z.number(),
    updated_at: z.number(),
    acus_consumed: z.number().nullish(),
    is_archived: z.boolean().optional(),
    structured_output: z.unknown().nullish(),
  })
  .loose();

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export interface CreateSessionRequest {
  prompt: string;
  title?: string;
  tags?: string[];
  max_acu_limit?: number;
  resumable?: boolean;
  structured_output_schema?: Record<string, unknown>;
  structured_output_required?: boolean;
}

export interface DevinClientOptions {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

export class DevinApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string
  ) {
    super(`Devin API ${method} ${path} failed with status ${String(status)}: ${body}`);
    this.name = 'DevinApiError';
  }
}

export class DevinClient {
  private readonly apiKey: string;
  private readonly orgId: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(opts: DevinClientOptions) {
    this.apiKey = opts.apiKey;
    this.orgId = opts.orgId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  private async request(method: string, path: string, body?: unknown): Promise<SessionResponse> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
      throw new DevinApiError(response.status, method, path, text);
    }

    const json: unknown = await response.json();
    const parsed = sessionResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `Devin API ${method} ${path} returned an unexpected response: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  createSession(req: CreateSessionRequest): Promise<SessionResponse> {
    return this.request('POST', `/organizations/${this.orgId}/sessions`, req);
  }

  getSession(sessionId: string): Promise<SessionResponse> {
    return this.request('GET', `/organizations/${this.orgId}/sessions/${sessionId}`);
  }
}

const FINISHED_STATUSES: readonly SessionStatus[] = ['exit', 'error', 'suspended'];
const FINISHED_STATUS_DETAILS: readonly SessionStatusDetail[] = ['finished', 'waiting_for_user'];

export function isSessionTurnComplete(session: SessionResponse): boolean {
  return (
    FINISHED_STATUSES.includes(session.status) ||
    (session.status_detail !== null &&
      session.status_detail !== undefined &&
      FINISHED_STATUS_DETAILS.includes(session.status_detail))
  );
}

export function createDevinClientFromConfig(config: Config): DevinClient {
  const { devinApiKey: apiKey, devinOrgId: orgId, devinApiUrl: baseUrl } = config;
  const missing: string[] = [];
  if (!apiKey) missing.push('DEVIN_API_KEY');
  if (!orgId) missing.push('DEVIN_ORG_ID');
  if (!apiKey || !orgId) {
    throw new Error(
      `Cannot create Devin API client: missing required configuration ${missing.join(', ')}`
    );
  }
  return new DevinClient({ apiKey, orgId, baseUrl });
}
