import 'dotenv/config';
import { parseArgs } from 'node:util';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import { getAttempt, setVerificationCandidate } from '../src/db/task-state.js';
import { hashVerificationSpec, type VerificationShell } from '../src/verification/spec.js';

function main(): number {
  const { values } = parseArgs({
    options: {
      attempt: { type: 'string' },
      command: { type: 'string', multiple: true },
      shell: { type: 'string', default: 'sh' },
    },
  });
  const commands = values.command ?? [];
  if (!values.attempt || commands.length === 0) {
    console.error(
      'Usage: pnpm verification:propose --attempt <id> --command "<cmd>" [--command "<cmd2>"] [--shell bash|sh]'
    );
    return 1;
  }
  if (values.shell !== 'bash' && values.shell !== 'sh') {
    console.error(`Unsupported shell '${values.shell}'; expected bash or sh`);
    return 1;
  }
  const shell: VerificationShell = values.shell;
  runMigrations();
  try {
    const db = getDb();
    const attemptId = Number(values.attempt);
    const attempt = getAttempt(attemptId, db);
    if (!attempt) {
      console.error(`Attempt ${values.attempt} not found`);
      return 1;
    }
    const script = commands.join('\n');
    const spec = { shell, script, sha256: hashVerificationSpec(shell, script) };
    const updated = setVerificationCandidate(attemptId, spec, 'operator', db);
    console.log(`Candidate sha256: ${updated.verificationCandidateSha256 ?? '(none)'}`);
    console.log(`Candidate source: ${updated.verificationCandidateSource ?? '(none)'}`);
    console.log('Script:');
    console.log(script);
    console.log(
      `Approve with: pnpm verification:approve --attempt ${values.attempt} --spec-hash ${spec.sha256}`
    );
    return 0;
  } finally {
    closeDb();
  }
}

try {
  process.exitCode = main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
