import type { Attempt } from '../db/schema.js';
import type { VerificationSpec } from './spec.js';

export type ApprovalStatus = 'no_candidate' | 'pending_approval' | 'approved';

export function approvalStatus(
  attempt: Pick<Attempt, 'verificationCandidateSha256' | 'verificationApprovedSha256'>
): ApprovalStatus {
  if (attempt.verificationCandidateSha256 === null) {
    return 'no_candidate';
  }
  return attempt.verificationApprovedSha256 === attempt.verificationCandidateSha256
    ? 'approved'
    : 'pending_approval';
}

export function approvedSpec(
  attempt: Pick<
    Attempt,
    | 'verificationCandidateSha256'
    | 'verificationApprovedSha256'
    | 'verificationApprovedShell'
    | 'verificationApprovedScript'
  >
): VerificationSpec | undefined {
  if (approvalStatus(attempt) !== 'approved') {
    return undefined;
  }
  if (
    attempt.verificationApprovedShell === null ||
    attempt.verificationApprovedScript === null ||
    attempt.verificationApprovedSha256 === null
  ) {
    return undefined;
  }
  return {
    shell: attempt.verificationApprovedShell,
    script: attempt.verificationApprovedScript,
    sha256: attempt.verificationApprovedSha256,
  };
}
