import {
  LockConflictError,
  LockTimeoutError,
  RedisLock,
} from '@hile/redis-lock'
import type {
  DistributedJobOptions,
  JobHandler,
  JobOptions,
  JobRunInfo,
} from './types.js'

function isLockUnavailableError(error: unknown): boolean {
  return error instanceof LockConflictError || error instanceof LockTimeoutError
}

export class ScheduleJobRunner {
  private readonly locks?: RedisLock

  constructor(private readonly options: JobOptions = {}) {
    if (options.distributed) {
      this.locks = new RedisLock(options.distributed.redis)
    }
  }

  createHandler(handler: JobHandler, info: JobRunInfo): () => void {
    return () => {
      void this.run(handler, info).catch(error => {
        this.reportError(error, info)
      })
    }
  }

  private async run(handler: JobHandler, info: JobRunInfo): Promise<void> {
    const distributed = this.options.distributed
    if (!distributed) {
      await handler(info)
      return
    }

    try {
      await this.runDistributed(handler, info, distributed)
    } catch (error) {
      if (isLockUnavailableError(error)) {
        await this.options.onSkip?.(info)
        return
      }
      throw error
    }
  }

  private async runDistributed(
    handler: JobHandler,
    info: JobRunInfo,
    distributed: DistributedJobOptions,
  ): Promise<void> {
    if (!this.locks) throw new Error('Distributed schedule runner was not initialized')

    const lockKey = this.resolveLockKey(info, distributed)
    const wait = distributed.policy === 'wait' ? distributed.wait ?? distributed.ttl : 0
    await this.locks.withLock(lockKey, {
      ttl: distributed.ttl,
      wait,
      pollInterval: distributed.pollInterval,
      maxPollInterval: distributed.maxPollInterval,
      renew: distributed.renew,
    }, async () => {
      await handler(info)
    })
  }

  private resolveLockKey(info: JobRunInfo, distributed: DistributedJobOptions): string {
    if (typeof distributed.lockKey === 'function') return distributed.lockKey(info)
    if (distributed.lockKey !== undefined) return distributed.lockKey
    return `schedule:${distributed.namespace ?? 'default'}:${info.id}`
  }

  private reportError(error: unknown, info: JobRunInfo): void {
    try {
      const reported = this.options.onError?.(error, info)
      if (reported) void reported.catch(() => {})
    } catch {
      // Error reporters should not turn handled job failures into unhandled rejections.
    }
  }
}
