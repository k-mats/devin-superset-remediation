import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashVerificationSpec, parseVerificationSpec } from '../src/verification/spec.js';

const body = (section: string) => `# Issue\n\nSome description.\n\n${section}\n`;

describe('parseVerificationSpec', () => {
  it('returns verification_section_missing without a heading', () => {
    expect(parseVerificationSpec(null)).toEqual({
      ok: false,
      reason: 'verification_section_missing',
    });
    expect(parseVerificationSpec('no heading here')).toEqual({
      ok: false,
      reason: 'verification_section_missing',
    });
    expect(parseVerificationSpec('## Verify\n```\nx\n```')).toEqual({
      ok: false,
      reason: 'verification_section_missing',
    });
  });

  it('parses a bash block under a # or ## heading', () => {
    for (const heading of ['# Verification', '## Verification', '### verification']) {
      const result = parseVerificationSpec(body(`${heading}\n\n\`\`\`bash\npytest -k x\n\`\`\`\n`));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.shell).toBe('bash');
        expect(result.spec.script).toBe('pytest -k x');
      }
    }
  });

  it('maps sh, shell, and empty tags to the sh shell', () => {
    for (const tag of ['sh', 'shell', '']) {
      const result = parseVerificationSpec(
        body(`## Verification\n\n\`\`\`${tag}\nexit 0\n\`\`\`\n`)
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.spec.shell).toBe('sh');
    }
  });

  it('uses the first fenced block after the heading', () => {
    const result = parseVerificationSpec(
      body('## Verification\n\n```bash\nfirst\n```\n\n```bash\nsecond\n```\n')
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.script).toBe('first');
  });

  it('stops scanning at the next heading', () => {
    const result = parseVerificationSpec(
      body('## Verification\n\n## Other\n\n```bash\ntoo late\n```\n')
    );
    expect(result).toEqual({ ok: false, reason: 'verification_block_missing' });
  });

  it('rejects an unterminated backtick fence', () => {
    const result = parseVerificationSpec('## Verification\n\n```bash\necho ok\n');
    expect(result).toEqual({ ok: false, reason: 'verification_block_unterminated' });
  });

  it('rejects an unterminated tilde fence', () => {
    const result = parseVerificationSpec('# Verification\n\n~~~\necho ok\n');
    expect(result).toEqual({ ok: false, reason: 'verification_block_unterminated' });
  });

  it('accepts tilde fences', () => {
    const result = parseVerificationSpec(body('## Verification\n\n~~~sh\necho hi\n~~~\n'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.shell).toBe('sh');
      expect(result.spec.script).toBe('echo hi');
    }
  });

  it('rejects unsupported languages', () => {
    const result = parseVerificationSpec(body('## Verification\n\n```python\nprint(1)\n```\n'));
    expect(result).toEqual({ ok: false, reason: 'verification_language_unsupported' });
  });

  it('rejects an empty script', () => {
    const result = parseVerificationSpec(body('## Verification\n\n```bash\n\n```\n'));
    expect(result).toEqual({ ok: false, reason: 'verification_script_empty' });
  });

  it('normalizes CRLF and trims trailing whitespace', () => {
    const result = parseVerificationSpec(
      'Intro\r\n\r\n## Verification\r\n\r\n```bash\r\npytest -k x\r\n\r\n```\r\n'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.script).toBe('pytest -k x');
  });

  it('produces a deterministic sha256 of shell and script', () => {
    const script = 'echo ok';
    const expected = createHash('sha256').update(`bash\n${script}`).digest('hex');
    expect(hashVerificationSpec('bash', script)).toBe(expected);
    const result = parseVerificationSpec(
      body(`## Verification\n\n\`\`\`bash\n${script}\n\`\`\`\n`)
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.sha256).toBe(expected);
  });
});
