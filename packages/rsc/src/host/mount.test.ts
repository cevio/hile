import { describe, expect, it, vi } from 'vitest';
import { mountRscHostAdapters } from './mount';

describe('mountRscHostAdapters', () => {
  it('mounts configured adapters in order and returns the same host', () => {
    const host = { use: vi.fn(function (this: unknown) { return this; }) };
    const asset = vi.fn();
    const action = vi.fn();
    const custom = vi.fn();

    expect(mountRscHostAdapters(host, { asset, action, middleware: [custom] })).toBe(host);
    expect(host.use.mock.calls.map(([middleware]) => middleware)).toEqual([asset, action, custom]);
  });

  it('supports partial composition without manufacturing hidden middleware', () => {
    const host = { use: vi.fn() };
    mountRscHostAdapters(host, {});
    expect(host.use).not.toHaveBeenCalled();
  });
});
