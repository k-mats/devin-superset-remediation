import { describe, expect, it } from 'vitest';
import { NORMALIZED_TASK_STATES } from '../src/tracking/normalized-task-state.js';
import { ALL_WORKERS_ENABLED, stateGuidance } from '../src/reporting/state-guidance.js';

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

  it('turns wait into an operator step when the required worker is disabled', () => {
    const noVerification = { ...ALL_WORKERS_ENABLED, verification: false };
    const guidance = stateGuidance('VERIFYING', 'approved_spec_awaiting_run', noVerification);
    expect(guidance.next).toBe('operator');
    expect(guidance.text).toContain('VERIFICATION_ENABLED');

    const noTracking = { ...ALL_WORKERS_ENABLED, tracking: false };
    expect(stateGuidance('RUNNING', 'attempt_running', noTracking).next).toBe('operator');
    expect(stateGuidance('RUNNING', 'attempt_running', noTracking).text).toContain(
      'DEVIN_TRACKING_INTERVAL_MS'
    );
    expect(stateGuidance('QUEUED', 'attempt_pending', noTracking).next).toBe('wait');

    expect(stateGuidance('CI_PENDING', 'github_checks_pending', noVerification).next).toBe(
      'operator'
    );
    expect(stateGuidance('QUEUED', 'task_without_attempt').next).toBe('wait');
    const noIntake = { ...ALL_WORKERS_ENABLED, intake: false };
    expect(stateGuidance('QUEUED', 'task_without_attempt', noIntake).next).toBe('operator');
    expect(stateGuidance('QUEUED', 'attempt_pending', noIntake).next).toBe('wait');

    const noDispatch = { ...ALL_WORKERS_ENABLED, dispatch: false };
    expect(stateGuidance('QUEUED', 'attempt_pending', noDispatch).next).toBe('operator');
    expect(stateGuidance('VERIFYING', 'spec_pending_approval', noDispatch).next).toBe('operator');
    expect(stateGuidance('VERIFIED', 'command_verification_passed', noDispatch).next).toBe('done');
  });
});
