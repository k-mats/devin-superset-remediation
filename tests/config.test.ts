import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  const originalPollInterval = process.env['GITHUB_POLL_INTERVAL_MS'];

  afterEach(() => {
    if (originalPollInterval === undefined) {
      delete process.env['GITHUB_POLL_INTERVAL_MS'];
    } else {
      process.env['GITHUB_POLL_INTERVAL_MS'] = originalPollInterval;
    }
  });

  it('rejects a poll interval above the Node setInterval maximum', () => {
    process.env['GITHUB_POLL_INTERVAL_MS'] = '2147483648';

    expect(() => loadConfig()).toThrow();
  });

  describe('Devin dispatch configuration', () => {
    const originalDispatchInterval = process.env['DEVIN_DISPATCH_INTERVAL_MS'];
    const originalMaxAcu = process.env['DEVIN_MAX_ACU_PER_SESSION'];

    afterEach(() => {
      if (originalDispatchInterval === undefined) {
        delete process.env['DEVIN_DISPATCH_INTERVAL_MS'];
      } else {
        process.env['DEVIN_DISPATCH_INTERVAL_MS'] = originalDispatchInterval;
      }
      if (originalMaxAcu === undefined) {
        delete process.env['DEVIN_MAX_ACU_PER_SESSION'];
      } else {
        process.env['DEVIN_MAX_ACU_PER_SESSION'] = originalMaxAcu;
      }
    });

    it('defaults to 60s polling and 5 ACUs', () => {
      delete process.env['DEVIN_DISPATCH_INTERVAL_MS'];
      delete process.env['DEVIN_MAX_ACU_PER_SESSION'];

      const config = loadConfig();
      expect(config.devinDispatchIntervalMs).toBe(60_000);
      expect(config.devinMaxAcuPerSession).toBe(5);
    });

    it('accepts a zero dispatch interval to disable polling', () => {
      process.env['DEVIN_DISPATCH_INTERVAL_MS'] = '0';
      process.env['DEVIN_MAX_ACU_PER_SESSION'] = '12.5';

      const config = loadConfig();
      expect(config.devinDispatchIntervalMs).toBe(0);
      expect(config.devinMaxAcuPerSession).toBe(12.5);
    });

    it('rejects invalid dispatch configuration', () => {
      process.env['DEVIN_DISPATCH_INTERVAL_MS'] = '-1';
      expect(() => loadConfig()).toThrow();
      process.env['DEVIN_DISPATCH_INTERVAL_MS'] = '2147483648';
      expect(() => loadConfig()).toThrow();
      process.env['DEVIN_DISPATCH_INTERVAL_MS'] = '0';
      process.env['DEVIN_MAX_ACU_PER_SESSION'] = '0';
      expect(() => loadConfig()).toThrow();
      process.env['DEVIN_MAX_ACU_PER_SESSION'] = 'not-a-number';
      expect(() => loadConfig()).toThrow();
    });
  });

  it('defaults tracking polling and stale warnings', () => {
    delete process.env['DEVIN_TRACKING_INTERVAL_MS'];
    delete process.env['DEVIN_SESSION_STALE_WARN_MS'];
    const config = loadConfig();
    expect(config.devinTrackingIntervalMs).toBe(60_000);
    expect(config.devinSessionStaleWarnMs).toBe(21_600_000);
  });

  it('accepts zero tracking and stale warning intervals', () => {
    process.env['DEVIN_TRACKING_INTERVAL_MS'] = '0';
    process.env['DEVIN_SESSION_STALE_WARN_MS'] = '0';
    const config = loadConfig();
    expect(config.devinTrackingIntervalMs).toBe(0);
    expect(config.devinSessionStaleWarnMs).toBe(0);
    delete process.env['DEVIN_TRACKING_INTERVAL_MS'];
    delete process.env['DEVIN_SESSION_STALE_WARN_MS'];
  });
});

describe('verification configuration', () => {
  const keys = [
    'VERIFICATION_ENABLED',
    'VERIFICATION_WORKSPACE_ROOT',
    'VERIFICATION_COMMAND_TIMEOUT_MS',
    'VERIFICATION_SETUP_TIMEOUT_MS',
    'VERIFICATION_CHECKOUT_TIMEOUT_MS',
    'VERIFICATION_MAX_OUTPUT_BYTES',
  ] as const;

  afterEach(() => {
    for (const key of keys) Reflect.deleteProperty(process.env, key);
  });

  it('defaults to enabled with documented timeouts', () => {
    for (const key of keys) Reflect.deleteProperty(process.env, key);
    const config = loadConfig();
    expect(config.verificationEnabled).toBe(true);
    expect(config.verificationWorkspaceRoot).toBe('./data/verification');
    expect(config.verificationCommandTimeoutMs).toBe(900_000);
    expect(config.verificationSetupTimeoutMs).toBe(1_800_000);
    expect(config.verificationCheckoutTimeoutMs).toBe(300_000);
    expect(config.verificationMaxOutputBytes).toBe(16_384);
  });

  it.each(['false', '0'])('treats VERIFICATION_ENABLED=%s as disabled', (value) => {
    process.env['VERIFICATION_ENABLED'] = value;
    expect(loadConfig().verificationEnabled).toBe(false);
  });
});
