import exitHook from 'async-exit-hook';
import { container } from '@hile/core';

/** 强制退出超时：仅当 shutdown 未在该时间内完成时才强制退出，默认约 24 天，等效于「等 shutdown 完成再退出」 */
const FORCE_EXIT_AFTER_MS = 2 ** 31 - 1;

/**
 * 注册进程退出钩子：进程退出时先执行 container.shutdown()，**仅在其完成后**才执行 offEvent 并 exit。
 * 若 shutdown() 未完成，进程会挂起，不会被关闭（受 FORCE_EXIT_AFTER_MS 上限保护）。
 */
export function registerExitHook(offEvent: () => void): void {
  const hook = exitHook as typeof exitHook & { forceExitTimeout?(ms: number): void };
  if (typeof hook.forceExitTimeout === 'function') {
    hook.forceExitTimeout(FORCE_EXIT_AFTER_MS);
  }

  exitHook(async exit => {
    try {
      await container.shutdown();
      await new Promise<void>((resolve, reject) => {
        try {
          if (process.stdin.isTTY) {
            process.stdin.unref();
          }
          resolve();
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      console.error(e);
    } finally {
      offEvent();
      exit();
    }
  });
}

export async function useExit(fn: () => void | Promise<void>) {
  exitHook(async exit => {
    try {
      await Promise.resolve(fn());
      await new Promise<void>((resolve, reject) => {
        try {
          if (process.stdin.isTTY) {
            process.stdin.unref();
          }
          resolve();
        } catch (e) {
          reject(e)
        }
      })
    } catch (e) {
      console.error(e);
    } finally {
      exit();
    }
  });
}