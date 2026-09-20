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
});
