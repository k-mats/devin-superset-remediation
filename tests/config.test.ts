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
});
