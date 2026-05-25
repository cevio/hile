import { describe, it, expect } from 'vitest';
import { getLocalIPv4 } from './utils';

describe('getLocalIPv4', () => {
  it('返回字符串或 undefined', () => {
    const result = getLocalIPv4();
    // On a machine with a network interface, this should return a string.
    // In containerized environments, it could be undefined.
    if (result !== undefined) {
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
  });
});
