import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const shutdownMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@hile/core', () => ({
  container: {
    shutdown: (...args: unknown[]) => shutdownMock(...args),
  },
}));

import { registerExitHook } from './exitHook.js';

// 捕获 exitHook 注册的回调
let capturedExitCallback: ((exit: () => void) => void) | null = null;

// forceExitTimeout 不存在（非 function），覆盖分支 0[1]
vi.mock('async-exit-hook', () => ({
  default: Object.assign(
    (callback: (exit: () => void) => void) => {
      capturedExitCallback = callback;
    },
    { forceExitTimeout: undefined },
  ),
}));

describe('exitHook without forceExitTimeout', () => {
  beforeEach(() => {
    capturedExitCallback = null;
    shutdownMock.mockReset();
    shutdownMock.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forceExitTimeout 不是 function 时不调用，不报错', async () => {
    const offEvent = vi.fn();

    registerExitHook(offEvent);

    expect(capturedExitCallback).not.toBeNull();

    const exit = vi.fn();
    capturedExitCallback!(exit);

    await vi.waitFor(() => {
      expect(shutdownMock).toHaveBeenCalledTimes(1);
      expect(offEvent).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });
});
