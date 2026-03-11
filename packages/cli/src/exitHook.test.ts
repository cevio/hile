import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerExitHook } from './exitHook.js';

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
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('注册后，进程退出时应调用 container.shutdown()', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const container = { shutdown };
    const offEvent = vi.fn();

    registerExitHook(container, offEvent);

    expect(capturedExitCallback).not.toBeNull();

    const exit = vi.fn();
    capturedExitCallback!(exit);

    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(offEvent).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });

  it('进程退出时应在 shutdown 完成后再调用 offEvent 和 exit', async () => {
    let resolveShutdown!: () => void;
    const shutdown = vi.fn().mockReturnValue(new Promise<void>(r => { resolveShutdown = r; }));
    const container = { shutdown };
    const offEvent = vi.fn();
    const exit = vi.fn();

    registerExitHook(container, offEvent);
    capturedExitCallback!(exit);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(offEvent).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    resolveShutdown();

    await vi.waitFor(() => {
      expect(offEvent).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });

  it('shutdown 失败时仍应调用 offEvent 和 exit（错误被 catch 并打印）', async () => {
    const shutdown = vi.fn().mockRejectedValue(new Error('shutdown failed'));
    const container = { shutdown };
    const offEvent = vi.fn();
    const exit = vi.fn();

    registerExitHook(container, offEvent);
    capturedExitCallback!(exit);

    await vi.waitFor(() => {
      expect(offEvent).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    });

    expect(console.error).toHaveBeenCalled();
  });

  it('shutdown() 未完成前，exit() 不会被调用（进程应挂起）', async () => {
    let resolveShutdown!: () => void;
    const shutdown = vi.fn().mockReturnValue(new Promise<void>(r => { resolveShutdown = r; }));
    const container = { shutdown };
    const offEvent = vi.fn();
    const exit = vi.fn();

    registerExitHook(container, offEvent);
    capturedExitCallback!(exit);

    expect(shutdown).toHaveBeenCalledTimes(1);

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
    const shutdown = vi.fn().mockImplementation(() => {
      order.push('shutdown:start');
      return new Promise<void>(r => {
        resolveShutdown = () => {
          order.push('shutdown:done');
          r();
        };
      });
    });
    const container = { shutdown };
    const offEvent = vi.fn(() => order.push('offEvent'));
    const exit = vi.fn(() => order.push('exit'));

    registerExitHook(container, offEvent);
    capturedExitCallback!(exit);

    expect(order).toEqual(['shutdown:start']);

    resolveShutdown();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });

    expect(order).toEqual(['shutdown:start', 'shutdown:done', 'offEvent', 'exit']);
  });
});
