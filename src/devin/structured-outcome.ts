import { z } from 'zod';

export const STRUCTURED_OUTCOME_SCHEMA_VERSION = 1;

export const AGENT_OUTCOMES = ['remediated', 'needs_human', 'no_action'] as const;
export const TEST_RESULTS = ['passed', 'failed'] as const;

export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

const PR_URL_PATTERN = '^https://github\\.com/[^/]+/[^/]+/pull/\\d+$';

export const structuredOutcomeJsonSchema: Record<string, unknown> = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'outcome',
    'pr_url',
    'diagnosis',
    'tests_run',
    'risks',
    'needs_human_reason',
  ],
  properties: {
    schema_version: {
      const: STRUCTURED_OUTCOME_SCHEMA_VERSION,
      description: 'Structured outcome contract version; always 1.',
    },
    outcome: {
      enum: [...AGENT_OUTCOMES],
      description:
        '"remediated" when a PR was opened, "needs_human" when a human decision is required, "no_action" when the issue should not be acted on.',
    },
    pr_url: {
      type: ['string', 'null'],
      format: 'uri',
      pattern: PR_URL_PATTERN,
      description: 'URL of the pull request opened this session; null when no PR was opened.',
    },
    diagnosis: {
      type: 'string',
      minLength: 1,
      description: 'Root-cause summary of what was found.',
    },
    tests_run: {
      type: 'array',
      description: 'Only tests actually executed in this session; empty array if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'result'],
        properties: {
          command: {
            type: 'string',
            minLength: 1,
            description: 'The exact command that was run.',
          },
          result: {
            enum: [...TEST_RESULTS],
            description: 'The observed result of the command.',
          },
          notes: {
            type: 'string',
            description: 'Optional details about the result.',
          },
        },
      },
    },
    risks: {
      type: 'array',
      description: 'Known risks or follow-ups; empty array if none.',
      items: { type: 'string', minLength: 1 },
    },
    needs_human_reason: {
      type: ['string', 'null'],
      minLength: 1,
      description:
        'Why a human decision is required; must be a non-empty string when outcome is "needs_human", must be null otherwise.',
    },
  },
  allOf: [
    {
      if: { properties: { outcome: { const: 'remediated' } } },
      then: { properties: { pr_url: { type: 'string' } } },
    },
    {
      if: { properties: { outcome: { const: 'needs_human' } } },
      then: { properties: { needs_human_reason: { type: 'string', minLength: 1 } } },
    },
    {
      if: { properties: { outcome: { const: 'no_action' } } },
      then: { properties: { pr_url: { type: 'null' } } },
    },
    {
      if: { properties: { outcome: { enum: ['remediated', 'no_action'] } } },
      then: { properties: { needs_human_reason: { type: 'null' } } },
    },
  ],
};

export const structuredOutcomeSchema = z
  .strictObject({
    schema_version: z.literal(STRUCTURED_OUTCOME_SCHEMA_VERSION),
    outcome: z.enum(AGENT_OUTCOMES),
    pr_url: z.url().regex(new RegExp(PR_URL_PATTERN)).nullable(),
    diagnosis: z.string().min(1),
    tests_run: z.array(
      z.strictObject({
        command: z.string().min(1),
        result: z.enum(TEST_RESULTS),
        notes: z.string().optional(),
      })
    ),
    risks: z.array(z.string().min(1)),
    needs_human_reason: z.string().min(1).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === 'remediated' && value.pr_url === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['pr_url'],
        message: 'pr_url must be set when outcome is "remediated"',
      });
    }
    if (value.outcome === 'needs_human' && value.needs_human_reason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['needs_human_reason'],
        message: 'needs_human_reason must be set when outcome is "needs_human"',
      });
    }
    if (value.outcome === 'no_action' && value.pr_url !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['pr_url'],
        message: 'pr_url must be null when outcome is "no_action"',
      });
    }
    if (value.outcome !== 'needs_human' && value.needs_human_reason !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['needs_human_reason'],
        message: 'needs_human_reason must be null unless outcome is "needs_human"',
      });
    }
  });

export type StructuredOutcome = z.infer<typeof structuredOutcomeSchema>;

export type ParseStructuredOutcomeResult =
  | { ok: true; value: StructuredOutcome }
  | {
      ok: false;
      reason: 'structured_output_missing' | 'structured_output_invalid';
      message: string;
    };

export function parseStructuredOutcome(raw: unknown): ParseStructuredOutcomeResult {
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      reason: 'structured_output_missing',
      message: 'session finished without structured output',
    };
  }
  const parsed = structuredOutcomeSchema.safeParse(raw);
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    const message = JSON.stringify({
      formErrors: flattened.formErrors,
      fieldErrors: flattened.fieldErrors,
    }).slice(0, 500);
    return { ok: false, reason: 'structured_output_invalid', message };
  }
  return { ok: true, value: parsed.data };
}
