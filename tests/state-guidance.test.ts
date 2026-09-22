import { describe, expect, it } from 'vitest';
import { NORMALIZED_TASK_STATES } from '../src/tracking/normalized-task-state.js';
import { stateGuidance } from '../src/reporting/state-guidance.js';

describe('stateGuidance', () => {
  it('has a fallback for every normalized state', () => {
    for (const state of NORMALIZED_TASK_STATES) {
      const guidance = stateGuidance(state, 'unknown_reason');
      expect(guidance.text.length).toBeGreaterThan(0);
    }
  });

  it('prefers reason-specific guidance and marks operator steps', () => {
    expect(stateGuidance('VERIFYING', 'spec_pending_approval').next).toBe('operator');
    expect(stateGuidance('VERIFYING', 'approved_spec_awaiting_run').next).toBe('wait');
    expect(stateGuidance('PR_OPEN', 'no_verification_spec').next).toBe('operator');
    expect(stateGuidance('RUNNING', 'attempt_running').next).toBe('wait');
    expect(stateGuidance('NEEDS_HUMAN', 'pr_closed_without_merge').next).toBe('human');
    expect(stateGuidance('VERIFIED', 'command_verification_passed').next).toBe('done');
  });
});
