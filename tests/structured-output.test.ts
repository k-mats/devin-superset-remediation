import { Ajv } from 'ajv';
import addFormatsImport from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  parseStructuredOutput,
  structuredOutputJsonSchema,
} from '../src/devin/structured-output.js';

// ajv-formats' CommonJS build exposes the plugin as both module.exports and
// exports.default, which NodeNext typing cannot express; assert the shape.
const addFormats = addFormatsImport as unknown as FormatsPlugin;
const ajv = addFormats(new Ajv({ strict: true }));
const validate = ajv.compile(structuredOutputJsonSchema);

const base = {
  schema_version: 1,
  diagnosis: 'Root cause summary',
  tests_run: [{ command: 'pnpm test', result: 'passed' }],
  risks: ['May regress'],
  needs_human_reason: null,
};

const fixtures: Array<{ name: string; valid: boolean; value: unknown }> = [
  {
    name: 'valid remediated',
    valid: true,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/o/r/pull/1',
    },
  },
  {
    name: 'valid needs_human',
    valid: true,
    value: {
      ...base,
      outcome: 'needs_human',
      pr_url: null,
      needs_human_reason: 'Product decision required',
    },
  },
  {
    name: 'valid no_action',
    valid: true,
    value: { ...base, outcome: 'no_action', pr_url: null, tests_run: [], risks: [] },
  },
  {
    name: 'remediated without pr_url',
    valid: false,
    value: { ...base, outcome: 'remediated', pr_url: null },
  },
  {
    name: 'needs_human with null reason',
    valid: false,
    value: { ...base, outcome: 'needs_human', pr_url: null, needs_human_reason: null },
  },
  {
    name: 'needs_human with empty reason',
    valid: false,
    value: { ...base, outcome: 'needs_human', pr_url: null, needs_human_reason: '' },
  },
  {
    name: 'no_action with pr_url',
    valid: false,
    value: { ...base, outcome: 'no_action', pr_url: 'https://github.com/o/r/pull/1' },
  },
  {
    name: 'unknown extra key',
    valid: false,
    value: { ...base, outcome: 'no_action', pr_url: null, extra: 'x' },
  },
  {
    name: 'tests_run result not_run',
    valid: false,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/o/r/pull/1',
      tests_run: [{ command: 'pnpm test', result: 'not_run' }],
    },
  },
  {
    name: 'schema_version 2',
    valid: false,
    value: { ...base, schema_version: 2, outcome: 'no_action', pr_url: null },
  },
  {
    name: 'pr_url not a github PR url',
    valid: false,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/o/r/issues/1',
    },
  },
  {
    name: 'valid remediated with dotted/dashed repo name',
    valid: true,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/k-mats/super-set.js/pull/12',
    },
  },
  {
    name: 'pr_url with ? in owner segment',
    valid: false,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/o?x/r/pull/1',
    },
  },
  {
    name: 'pr_url with # in repo segment',
    valid: false,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/o/r#x/pull/1',
    },
  },
  {
    name: 'pr_url with pull number 0',
    valid: false,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/o/r/pull/0',
    },
  },
  {
    name: 'pr_url with extra path segment',
    valid: false,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/owner/repo/issues/7/pull/9',
    },
  },
  {
    name: 'no_action with needs_human_reason',
    valid: false,
    value: {
      ...base,
      outcome: 'no_action',
      pr_url: null,
      needs_human_reason: 'Approval needed',
    },
  },
  {
    name: 'remediated with needs_human_reason',
    valid: false,
    value: {
      ...base,
      outcome: 'remediated',
      pr_url: 'https://github.com/o/r/pull/1',
      needs_human_reason: 'Approval needed',
    },
  },
  {
    name: 'missing diagnosis',
    valid: false,
    value: {
      schema_version: 1,
      outcome: 'no_action',
      pr_url: null,
      tests_run: [],
      risks: [],
      needs_human_reason: null,
    },
  },
];

describe('structured output contract', () => {
  it('JSON schema compiles under Ajv strict mode and stays under 64 KiB', () => {
    expect(typeof validate).toBe('function');
    expect(JSON.stringify(structuredOutputJsonSchema).length).toBeLessThan(64 * 1024);
  });

  it.each(fixtures)('Ajv and zod agree on $name (valid=$valid)', ({ valid, value }) => {
    const ajvValid = validate(value);
    const zodResult = parseStructuredOutput(value);
    expect(ajvValid).toBe(valid);
    expect(zodResult.ok).toBe(valid);
  });

  it.each([null, undefined])('missing structured output (%s) is reported as missing', (raw) => {
    const result = parseStructuredOutput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('structured_output_missing');
    }
  });

  it('a non-object value is reported as invalid', () => {
    const result = parseStructuredOutput('not an object');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('structured_output_invalid');
      expect(result.message.length).toBeLessThanOrEqual(500);
    }
  });
});
