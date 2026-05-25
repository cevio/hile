import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Scheduler, defineJob } from './index'

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

  /* ============ Scheduler.add ============ */

  it('add with cron expression stores the job', () => {
    const scheduler = new Scheduler()
    scheduler.add('cron-test', '0 8 * * *', vi.fn())
    expect(scheduler.getJobs()).toHaveLength(1)
    expect(scheduler.getJobs()[0]).toMatchObject({ id: 'cron-test', type: 'cron', expression: '0 8 * * *' })
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

  it('add 数字 id 与字符串 id 不冲突', () => {
    const scheduler = new Scheduler()
    scheduler.add('42', { delay: 100 }, vi.fn())
    expect(() => scheduler.add(42, { delay: 200 }, vi.fn())).toThrow('already exists')
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
