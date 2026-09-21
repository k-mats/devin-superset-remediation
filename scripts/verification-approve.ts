import 'dotenv/config';
import { parseArgs } from 'node:util';
import { closeDb, getDb, runMigrations } from '../src/db/client.js';
import {
  approveVerificationSpec,
  getAttempt,
  VerificationSpecMismatchError,
} from '../src/db/task-state.js';

function main(): number {
  const { values } = parseArgs({
    options: {
      attempt: { type: 'string' },
      'spec-hash': { type: 'string' },
    },
  });
  if (!values.attempt || !values['spec-hash']) {
    console.error('Usage: pnpm verification:approve --attempt <id> --spec-hash <sha256>');
    return 1;
  }
  runMigrations();
  try {
    const db = getDb();
    const attemptId = Number(values.attempt);
    const before = getAttempt(attemptId, db);
    if (!before) {
      console.error(`Attempt ${values.attempt} not found`);
      return 1;
    }
    console.log(`Current candidate sha256: ${before.verificationCandidateSha256 ?? '(none)'}`);
    console.log(`Current approved sha256:  ${before.verificationApprovedSha256 ?? '(none)'}`);
    try {
      const after = approveVerificationSpec(attemptId, values['spec-hash'], 'operator', db);
      console.log(`New approved sha256:      ${after.verificationApprovedSha256 ?? '(none)'}`);
      console.log(`Approved by:              ${after.verificationApprovedBy ?? '(none)'}`);
    } catch (error: unknown) {
      if (error instanceof VerificationSpecMismatchError) {
        console.error(
          `Refusing to approve: ${values['spec-hash']} does not match the current candidate.`
        );
        return 1;
      }
      throw error;
    }
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
