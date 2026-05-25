import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const shutdownMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@hile/core', () => ({
  container: {
    shutdown: (...args: unknown[]) => shutdownMock(...args),
  },
}));

import { registerExitHook, useExit } from './exitHook.js';

// 捕获 exitHook 注册的回调，便于测试时模拟进程退出
let capturedExitCallback: ((exit: () => void) => void) | null = null;

vi.mock('async-exit-hook', () => ({
  default: (callback: (exit: () => void) => void) => {
    capturedExitCallback = callback;
  },
}));

describe('exitHook', () => {
  // 保证进程结束（SIGINT/SIGTERM/process.exit）时一定会调用 container.shutdown，以便优雅关闭所有服务

  beforeEach(() => {
    capturedExitCallback = null;
    shutdownMock.mockReset();
    shutdownMock.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('注册后，进程退出时应调用 container.shutdown()', async () => {
    const offEvent = vi.fn();

    registerExitHook(offEvent);

    expect(capturedExitCallback).not.toBeNull();

    const exit = vi.fn();
    capturedExitCallback!(exit);

    await vi.waitFor(() => {
      expect(shutdownMock).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(offEvent).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });

  it('进程退出时应在 shutdown 完成后再调用 offEvent 和 exit', async () => {
    let resolveShutdown!: () => void;
    shutdownMock.mockReturnValue(new Promise<void>(r => { resolveShutdown = r; }));
    const offEvent = vi.fn();
    const exit = vi.fn();

    registerExitHook(offEvent);
    capturedExitCallback!(exit);

    expect(shutdownMock).toHaveBeenCalledTimes(1);
    expect(offEvent).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    resolveShutdown();

    await vi.waitFor(() => {
      expect(offEvent).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });

  it('shutdown 失败时仍应调用 offEvent 和 exit（错误被 catch 并打印）', async () => {
    shutdownMock.mockRejectedValue(new Error('shutdown failed'));
    const offEvent = vi.fn();
    const exit = vi.fn();

    registerExitHook(offEvent);
    capturedExitCallback!(exit);

    await vi.waitFor(() => {
      expect(offEvent).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    expect(console.error).toHaveBeenCalled();
  });

  it('shutdown() 未完成前，exit() 不会被调用（进程应挂起）', async () => {
    let resolveShutdown!: () => void;
    shutdownMock.mockReturnValue(new Promise<void>(r => { resolveShutdown = r; }));
    const offEvent = vi.fn();
    const exit = vi.fn();

    registerExitHook(offEvent);
    capturedExitCallback!(exit);

    expect(shutdownMock).toHaveBeenCalledTimes(1);

    // 在一小段时间内不 resolve：exit 必须未被调用
    await new Promise(r => setTimeout(r, 30));
    expect(exit).not.toHaveBeenCalled();
    expect(offEvent).not.toHaveBeenCalled();

    resolveShutdown();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
      expect(offEvent).toHaveBeenCalledTimes(1);
    });
  });

  it('调用顺序必须为：先 await shutdown 完成，再 offEvent，再 exit', async () => {
    const order: string[] = [];
    let resolveShutdown!: () => void;
    shutdownMock.mockImplementation(() => {
      order.push('shutdown:start');
      return new Promise<void>(r => {
        resolveShutdown = () => {
          order.push('shutdown:done');
          r();
        };
      });
    });
    const offEvent = vi.fn(() => order.push('offEvent'));
    const exit = vi.fn(() => order.push('exit'));

    registerExitHook(offEvent);
    capturedExitCallback!(exit);

    expect(order).toEqual(['shutdown:start']);

    resolveShutdown();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });

    expect(order).toEqual(['shutdown:start', 'shutdown:done', 'offEvent', 'exit']);
  });

  it('stdin 为 TTY 时应对 process.stdin 调用 unref', async () => {
    const unref = vi.fn();
    const stub = { isTTY: true, unref } as unknown as NodeJS.ReadStream;
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stub, configurable: true });
    try {
      registerExitHook(vi.fn());
      capturedExitCallback!(vi.fn());
      await vi.waitFor(() => {
        expect(unref).toHaveBeenCalledTimes(1);
      });
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true });
    }
  });

  it('stdin 非 TTY 时不应调用 unref', async () => {
    const unref = vi.fn();
    const stub = { isTTY: false, unref } as unknown as NodeJS.ReadStream;
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stub, configurable: true });
    try {
      registerExitHook(vi.fn());
      capturedExitCallback!(vi.fn());
      await vi.waitFor(() => {
        expect(shutdownMock).toHaveBeenCalled();
      });
      expect(unref).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'stdin', { value: original, configurable: true });
    }
  });

  describe('useExit - 简单进程退出钩子', () => {
    it('useExit 注册后退出时执行清理函数', async () => {
      capturedExitCallback = null;
      const fn = vi.fn();
      useExit(fn);

      expect(capturedExitCallback).not.toBeNull();

      const exit = vi.fn();
      capturedExitCallback!(exit);

      await vi.waitFor(() => {
        expect(fn).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledTimes(1);
      });
    });

    it('useExit 的清理函数抛错时仍调用 exit', async () => {
      capturedExitCallback = null;
      const fn = vi.fn(() => { throw new Error('useExit error') });
      useExit(fn);

      const exit = vi.fn();
      capturedExitCallback!(exit);

      await vi.waitFor(() => {
        expect(exit).toHaveBeenCalledTimes(1);
      });
    });

    it('useExit 支持异步清理函数', async () => {
      capturedExitCallback = null;
      const fn = vi.fn().mockResolvedValue(undefined);
      useExit(fn);

      const exit = vi.fn();
      capturedExitCallback!(exit);

      await vi.waitFor(() => {
        expect(fn).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledTimes(1);
      });
    });
  });
});
