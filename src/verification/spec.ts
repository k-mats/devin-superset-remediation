import { createHash } from 'node:crypto';

export type VerificationShell = 'bash' | 'sh';

export interface VerificationSpec {
  shell: VerificationShell;
  script: string;
  sha256: string;
}

export type ParseVerificationSpecResult =
  | { ok: true; spec: VerificationSpec }
  | {
      ok: false;
      reason:
        | 'verification_section_missing'
        | 'verification_block_missing'
        | 'verification_language_unsupported'
        | 'verification_block_unterminated'
        | 'verification_script_empty';
    };

const HEADING_PATTERN = /^#{1,3}\s+Verification\s*$/im;
const NEXT_HEADING_PATTERN = /^#{1,6}\s/m;
const FENCE_PATTERN = /^(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/;

export function hashVerificationSpec(shell: VerificationShell, script: string): string {
  return createHash('sha256').update(`${shell}\n${script}`).digest('hex');
}

function shellForLanguageTag(tag: string): VerificationShell | 'unsupported' {
  if (tag === 'bash') return 'bash';
  if (tag === '' || tag === 'sh' || tag === 'shell') return 'sh';
  return 'unsupported';
}

export function parseVerificationSpec(
  body: string | null | undefined
): ParseVerificationSpecResult {
  if (!body) {
    return { ok: false, reason: 'verification_section_missing' };
  }
  const normalized = body.replaceAll('\r\n', '\n');
  const heading = HEADING_PATTERN.exec(normalized);
  if (!heading) {
    return { ok: false, reason: 'verification_section_missing' };
  }

  const sectionStart = heading.index + heading[0].length;
  const lines = normalized.slice(sectionStart).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (NEXT_HEADING_PATTERN.test(line)) {
      return { ok: false, reason: 'verification_block_missing' };
    }
    const fence = FENCE_PATTERN.exec(line);
    if (!fence) continue;
    const marker = fence[1] ?? '';
    const languageTag = (fence[2] ?? '').toLowerCase();
    const shell = shellForLanguageTag(languageTag);
    if (shell === 'unsupported') {
      return { ok: false, reason: 'verification_language_unsupported' };
    }
    const fenceChar = marker[0];
    const closing = new RegExp(`^${fenceChar === '`' ? '`' : '~'}{${String(marker.length)},}\\s*$`);
    const content: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !closing.test(lines[cursor] ?? '')) {
      content.push(lines[cursor] ?? '');
      cursor += 1;
    }
    if (cursor >= lines.length) {
      return { ok: false, reason: 'verification_block_unterminated' };
    }
    const script = content.join('\n').replace(/\s+$/, '');
    if (script === '') {
      return { ok: false, reason: 'verification_script_empty' };
    }
    return { ok: true, spec: { shell, script, sha256: hashVerificationSpec(shell, script) } };
  }

  return { ok: false, reason: 'verification_block_missing' };
}
