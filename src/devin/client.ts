import { z } from 'zod';
import type { Config } from '../config.js';

const DEFAULT_BASE_URL = 'https://api.devin.ai/v3';
const MAX_ERROR_BODY_LENGTH = 500;

export const sessionResponseSchema = z
  .object({
    session_id: z.string(),
    url: z.string(),
    status: z.string(),
    status_detail: z.string().nullish(),
    title: z.string().nullish(),
    tags: z.array(z.string()).default([]),
    origin: z.string().nullish(),
    service_user_id: z.string().nullish(),
    user_id: z.string().nullish(),
    org_id: z.string(),
    created_at: z.number(),
    updated_at: z.number(),
    acus_consumed: z.number().nullish(),
    is_archived: z.boolean().optional(),
  })
  .loose();

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export interface CreateSessionRequest {
  prompt: string;
  title?: string;
  tags?: string[];
  max_acu_limit?: number;
  resumable?: boolean;
}

export interface DevinClientOptions {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
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

  constructor(opts: DevinClientOptions) {
    this.apiKey = opts.apiKey;
    this.orgId = opts.orgId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    return parsed.data as T;
  }

  createSession(req: CreateSessionRequest): Promise<SessionResponse> {
    return this.request<SessionResponse>('POST', `/organizations/${this.orgId}/sessions`, req);
  }

  getSession(sessionId: string): Promise<SessionResponse> {
    return this.request<SessionResponse>(
      'GET',
      `/organizations/${this.orgId}/sessions/${sessionId}`
    );
  }
}

export function createDevinClientFromConfig(config: Config): DevinClient {
  const missing: string[] = [];
  if (!config.devinApiKey) missing.push('DEVIN_API_KEY');
  if (!config.devinOrgId) missing.push('DEVIN_ORG_ID');
  if (missing.length > 0) {
    throw new Error(
      `Cannot create Devin API client: missing required configuration ${missing.join(', ')}`
    );
  }
  return new DevinClient({
    apiKey: config.devinApiKey as string,
    orgId: config.devinOrgId as string,
    baseUrl: config.devinApiUrl,
  });
}
