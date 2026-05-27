import exitHook from 'async-exit-hook';
import { container } from '@hile/core';

/** shutdown 未在该时间内完成时强制退出 */
const FORCE_EXIT_AFTER_MS = 10_000;

/**
 * 注册进程退出钩子。
 * 进程退出时先执行 container.shutdown()，完成后调用 exit() 调度 process.exit()。
 * 若 process.exit() 被 pino/thread-stream 的 Atomics.wait() 阻塞，1s 后 process.abort() 兜底。
 */
export function registerExitHook(offEvent: () => void): void {
  const hook = exitHook as typeof exitHook & { forceExitTimeout?(ms: number): void };
  if (typeof hook.forceExitTimeout === 'function') {
    hook.forceExitTimeout(FORCE_EXIT_AFTER_MS);
  }

  exitHook(async exit => {
    try {
      await container.shutdown();
      if (process.stdin.isTTY) {
        process.stdin.unref();
      }
    } catch (e) {
      console.error(e);
    } finally {
      offEvent();
      exit();
      // process.exit() can hang due to pino/thread-stream exit handlers
      // that use Atomics.wait() to block on worker threads.
      // If we're still running after 1s, force kill.
      setTimeout(() => process.abort(), 1000).unref();
    }
  });
}

export async function useExit(fn: () => void | Promise<void>) {
  exitHook(async exit => {
    try {
      await Promise.resolve(fn());
      if (process.stdin.isTTY) {
        process.stdin.unref();
      }
    } catch (e) {
      console.error(e);
    } finally {
      exit();
      setTimeout(() => process.abort(), 1000).unref();
    }
  });
}