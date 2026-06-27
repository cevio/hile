import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Scheduler, defineJob } from './index'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeout = 500) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(5)
  }
  throw new Error('Timed out waiting for condition')
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class MemoryRedis {
  public readonly values = new Map<string, string>()

  async eval(script: string, keyCount: number, ...keysAndArgs: Array<string | number>) {
    if (script.includes('TRY_ACQUIRE_LOCK')) {
      const key = String(keysAndArgs[0])
      const maybeFenceKey = keyCount === 2 ? String(keysAndArgs[1]) : ''
      const token = String(keyCount === 2 ? keysAndArgs[2] : keysAndArgs[1])
      const ttl = Number(keyCount === 2 ? keysAndArgs[3] : keysAndArgs[2])
      const fencing = String(keyCount === 2 ? keysAndArgs[4] : keysAndArgs[3])
      if (this.values.has(key)) return ['LOCKED']
      if (ttl <= 0) throw new Error('ttl must be positive')
      this.values.set(key, token)
      if (fencing === '1') {
        const next = Number(this.values.get(maybeFenceKey) ?? '0') + 1
        this.values.set(maybeFenceKey, String(next))
        return ['ACQUIRED', String(next)]
      }
      return ['ACQUIRED']
    }

    if (script.includes('RELEASE_LOCK_IF_OWNER')) {
      const [key, token] = keysAndArgs as [string, string]
      if (this.values.get(key) !== token) return 0
      this.values.delete(key)
      return 1
    }

    if (script.includes('RENEW_LOCK_IF_OWNER')) {
      const [key, token, ttl] = keysAndArgs as [string, string, number]
      if (ttl <= 0) throw new Error('ttl must be positive')
      return this.values.get(key) === token ? 1 : 0
    }

    if (script.includes('ASSERT_LOCK_OWNER')) {
      const [key, token] = keysAndArgs as [string, string]
      return this.values.get(key) === token ? 1 : 0
    }

    throw new Error(`unknown script: ${script}`)
  }
}

describe('@hile/schedule', () => {
  /* ============ defineJob ============ */

  it('defineJob with cron expression', () => {
    const handler = vi.fn()
    const result = defineJob('0 8 * * *', handler)
    expect(result).toMatchObject({
      type: 'job',
      expression: '0 8 * * *',
      handler,
    })
    expect(typeof result.id).toBe('number')
  })

  it('defineJob with delay', () => {
    const handler = vi.fn()
    const result = defineJob({ delay: 5000 }, handler)
    expect(result).toMatchObject({
      type: 'job',
      expression: { delay: 5000 },
      handler,
    })
    expect(typeof result.id).toBe('number')
  })

  it('defineJob 每次调用返回自增 id', () => {
    const a = defineJob('0 1 * * *', vi.fn())
    const b = defineJob('0 2 * * *', vi.fn())
    expect(b.id).toBe(a.id + 1)
  })

  it('defineJob accepts an explicit stable id', () => {
    const handler = vi.fn()
    const result = defineJob('daily-report', '0 8 * * *', handler)

    expect(result).toMatchObject({
      id: 'daily-report',
      type: 'job',
      expression: '0 8 * * *',
      handler,
    })
  })

  /* ============ Scheduler.add ============ */

  it('add with cron expression stores the job', () => {
    const scheduler = new Scheduler()
    scheduler.add('cron-test', '0 8 * * *', vi.fn())
    expect(scheduler.getJobs()).toHaveLength(1)
    expect(scheduler.getJobs()[0]).toMatchObject({ id: 'cron-test', type: 'cron', expression: '0 8 * * *' })
  })

  it('add rejects invalid cron expressions without recording a job', () => {
    const scheduler = new Scheduler()

    expect(() => scheduler.add('bad-cron', 'not a cron', vi.fn())).toThrow(/schedule/i)
    expect(scheduler.getJobs()).toHaveLength(0)
  })

  it('add with delay creates a job that fires after the delay', async () => {
    const handler = vi.fn()
    const scheduler = new Scheduler()
    scheduler.add('delay-test', { delay: 30 }, handler)

    expect(scheduler.getJobs()).toHaveLength(1)
    expect(scheduler.getJobs()[0]).toMatchObject({ id: 'delay-test', type: 'delay' })

    await new Promise(resolve => setTimeout(resolve, 60))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('add duplicate id throws', () => {
    const scheduler = new Scheduler()
    scheduler.add('dup', { delay: 1000 }, vi.fn())
    expect(() => scheduler.add('dup', { delay: 2000 }, vi.fn())).toThrow('already exists')
  })

  it('add 接受 number 类型 id', () => {
    const scheduler = new Scheduler()
    scheduler.add(42, { delay: 100 }, vi.fn())
    expect(scheduler.getJobs()[0].id).toBe('42')
  })

  it('add 数字 id 与字符串 id 会按同一个 key 处理', () => {
    const scheduler = new Scheduler()
    scheduler.add('42', { delay: 100 }, vi.fn())
    expect(() => scheduler.add(42, { delay: 200 }, vi.fn())).toThrow('already exists')
  })

  it('distributed add skips another scheduler while the same job lock is held', async () => {
    const redis = new MemoryRedis()
    const gate = createDeferred()
    const first = vi.fn(() => gate.promise)
    const second = vi.fn()
    const skipped = vi.fn()
    const schedulerA = new Scheduler()
    const schedulerB = new Scheduler()

    schedulerA.add('daily', { delay: 10 }, first, {
      distributed: { redis, ttl: 1000 },
    })

    await waitUntil(() => first.mock.calls.length === 1)
    expect(redis.values.has('schedule:default:daily')).toBe(true)

    schedulerB.add('daily', { delay: 10 }, second, {
      distributed: { redis, ttl: 1000 },
      onSkip: skipped,
    })

    await waitUntil(() => skipped.mock.calls.length === 1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(skipped).toHaveBeenCalledTimes(1)

    gate.resolve()
    await sleep(20)
    schedulerA.stop()
    schedulerB.stop()
  })

  it('distributed add separates default lock keys by namespace', async () => {
    const redis = new MemoryRedis()
    const gate = createDeferred()
    const first = vi.fn(() => gate.promise)
    const second = vi.fn()
    const schedulerA = new Scheduler()
    const schedulerB = new Scheduler()

    schedulerA.add('daily', { delay: 10 }, first, {
      distributed: { redis, ttl: 1000, namespace: 'billing' },
    })

    await waitUntil(() => first.mock.calls.length === 1)
    expect(redis.values.has('schedule:billing:daily')).toBe(true)

    schedulerB.add('daily', { delay: 10 }, second, {
      distributed: { redis, ttl: 1000, namespace: 'analytics' },
    })

    await waitUntil(() => second.mock.calls.length === 1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    gate.resolve()
    await sleep(20)
    schedulerA.stop()
    schedulerB.stop()
  })

  /* ============ Scheduler.remove ============ */

  it('remove cancels a pending job', async () => {
    const handler = vi.fn()
    const scheduler = new Scheduler()
    scheduler.add('cancel', { delay: 30 }, handler)

    scheduler.remove('cancel')
    expect(scheduler.getJobs()).toHaveLength(0)

    await new Promise(resolve => setTimeout(resolve, 60))
    expect(handler).not.toHaveBeenCalled()
  })

  it('remove non-existent id does nothing', () => {
    const scheduler = new Scheduler()
    expect(() => scheduler.remove('nonexistent')).not.toThrow()
  })

  it('remove 接受 number 类型 id', () => {
    const scheduler = new Scheduler()
    scheduler.add(7, { delay: 100 }, vi.fn())
    scheduler.remove(7)
    expect(scheduler.getJobs()).toHaveLength(0)
  })

  /* ============ Scheduler.stop ============ */

  it('stop cancels all jobs', async () => {
    const handler = vi.fn()
    const scheduler = new Scheduler()
    scheduler.add('a', { delay: 30 }, handler)
    scheduler.add('b', { delay: 30 }, handler)

    scheduler.stop()
    expect(scheduler.getJobs()).toHaveLength(0)

    await new Promise(resolve => setTimeout(resolve, 60))
    expect(handler).not.toHaveBeenCalled()
  })

  it('stop with no jobs is a no-op', () => {
    const scheduler = new Scheduler()
    expect(() => scheduler.stop()).not.toThrow()
  })

  /* ============ Scheduler.getJobs ============ */

  it('getJobs returns correct count after multiple adds and removes', () => {
    const scheduler = new Scheduler()
    scheduler.add('a', { delay: 100 }, vi.fn())
    scheduler.add('b', '0 8 * * *', vi.fn())
    expect(scheduler.getJobs()).toHaveLength(2)

    scheduler.remove('a')
    expect(scheduler.getJobs()).toHaveLength(1)
    expect(scheduler.getJobs()[0].id).toBe('b')
  })

  /* ============ handler error handling ============ */

  it('handler error does not crash scheduler', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('job error'))
    const scheduler = new Scheduler()
    scheduler.add('crash', { delay: 30 }, handler)

    await new Promise(resolve => setTimeout(resolve, 60))
    expect(handler).toHaveBeenCalledTimes(1)

    // 调度器不应因 handler 报错而崩溃，仍可添加新任务
    const handler2 = vi.fn()
    scheduler.add('still-ok', { delay: 10 }, handler2)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(handler2).toHaveBeenCalledTimes(1)
  })

  it('onError failures do not create unhandled rejections', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('job error'))
    const onError = vi.fn(() => {
      throw new Error('reporter error')
    })
    const scheduler = new Scheduler()

    scheduler.add('reporter-fails', { delay: 10 }, handler, { onError })

    await waitUntil(() => onError.mock.calls.length === 1)

    const handler2 = vi.fn()
    scheduler.add('after-reporter-fails', { delay: 10 }, handler2)
    await waitUntil(() => handler2.mock.calls.length === 1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('async onError rejections do not create unhandled rejections', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('job error'))
    const onError = vi.fn(async () => {
      throw new Error('async reporter error')
    })
    const scheduler = new Scheduler()

    scheduler.add('async-reporter-fails', { delay: 10 }, handler, { onError })

    await waitUntil(() => onError.mock.calls.length === 1)

    const handler2 = vi.fn()
    scheduler.add('after-async-reporter-fails', { delay: 10 }, handler2)
    await waitUntil(() => handler2.mock.calls.length === 1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  /* ============ cron job execution ============ */

  it('cron job fires on schedule', async () => {
    const handler = vi.fn()
    const scheduler = new Scheduler()

    scheduler.add('every-sec', '*/1 * * * * *', handler)

    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(handler).toHaveBeenCalled()

    scheduler.stop()
  })

  /* ============ Scheduler.load ============ */

  describe('load', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'schedule-test-'))
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
      vi.restoreAllMocks()
    })

    it('从目录加载 .schedule.mjs 文件', async () => {
      writeFileSync(join(tmpDir, 'hello.schedule.mjs'), `
        export default {
          id: 1,
          type: 'job',
          expression: '0 8 * * *',
          handler: () => {}
        }
      `)

      const scheduler = new Scheduler()
      const off = await scheduler.load(tmpDir)

      expect(scheduler.getJobs()).toHaveLength(1)
      expect(scheduler.getJobs()[0].id).toBe('1')

      off()
      expect(scheduler.getJobs()).toHaveLength(0)
    })

    it('用文件路径作为 defineJob 自动 id 的实际加载 id', async () => {
      writeFileSync(join(tmpDir, 'daily.schedule.mjs'), `
        export default {
          id: 1,
          idAutoGenerated: true,
          type: 'job',
          expression: '0 8 * * *',
          handler: () => {}
        }
      `)
      writeFileSync(join(tmpDir, 'weekly.schedule.mjs'), `
        export default {
          id: 1,
          idAutoGenerated: true,
          type: 'job',
          expression: '0 0 * * 0',
          handler: () => {}
        }
      `)

      const scheduler = new Scheduler()
      const off = await scheduler.load(tmpDir)

      expect(scheduler.getJobs().map(job => job.id).sort()).toEqual(['/daily', '/weekly'])

      off()
      expect(scheduler.getJobs()).toHaveLength(0)
    })

    it('加载过程中失败会回滚已经注册的任务', async () => {
      writeFileSync(join(tmpDir, 'a.schedule.mjs'), `
        export default {
          id: 'same-id',
          type: 'job',
          expression: '0 8 * * *',
          handler: () => {}
        }
      `)
      writeFileSync(join(tmpDir, 'b.schedule.mjs'), `
        export default {
          id: 'same-id',
          type: 'job',
          expression: '0 9 * * *',
          handler: () => {}
        }
      `)

      const scheduler = new Scheduler()

      await expect(scheduler.load(tmpDir)).rejects.toThrow('already exists')
      expect(scheduler.getJobs()).toHaveLength(0)
    })

    it('支持自定义 suffix', async () => {
      writeFileSync(join(tmpDir, 'daily.job.mjs'), `
        export default {
          id: 2,
          type: 'job',
          expression: '0 8 * * *',
          handler: () => {}
        }
      `)

      const scheduler = new Scheduler()
      await scheduler.load(tmpDir, { suffix: 'job' })

      expect(scheduler.getJobs()).toHaveLength(1)
    })

    it('跳过非 job 的默认导出', async () => {
      writeFileSync(join(tmpDir, 'invalid.schedule.mjs'), `
        export default { not: 'a job' }
      `)

      const scheduler = new Scheduler()
      await scheduler.load(tmpDir)
      expect(scheduler.getJobs()).toHaveLength(0)
    })

    it('teardown 函数取消已注册的任务', async () => {
      writeFileSync(join(tmpDir, 'task.schedule.mjs'), `
        export default {
          id: 3,
          type: 'job',
          expression: '0 8 * * *',
          handler: () => {}
        }
      `)

      const scheduler = new Scheduler()
      const off = await scheduler.load(tmpDir)
      expect(scheduler.getJobs()).toHaveLength(1)

      off()
      expect(scheduler.getJobs()).toHaveLength(0)
    })

    it('加载 delay 类型的 job', async () => {
      writeFileSync(join(tmpDir, 'delay.schedule.mjs'), `
        export default {
          id: 10,
          type: 'job',
          expression: { delay: 100 },
          handler: () => {}
        }
      `)

      const scheduler = new Scheduler()
      const off = await scheduler.load(tmpDir)

      expect(scheduler.getJobs()).toHaveLength(1)
      expect(scheduler.getJobs()[0].type).toBe('delay')

      off()
      expect(scheduler.getJobs()).toHaveLength(0)
    })

    it('无匹配文件时不报错', async () => {
      const scheduler = new Scheduler()
      const off = await scheduler.load(tmpDir)
      expect(scheduler.getJobs()).toHaveLength(0)
      off()
    })
  })

})
