import { scheduleJob, Job as NSJob } from 'node-schedule'
import { glob } from 'glob'
import { resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { JobHandler, JobDefinition } from './types.js'

export type JobInfo = {
  id: string
  type: 'cron' | 'delay'
  expression: string
}

export class Scheduler {
  private jobs = new Map<string, NSJob>()
  private meta = new Map<string, { type: 'cron' | 'delay'; expression: string }>()

  add(id: string | number, expression: string, handler: JobHandler): void
  add(id: string | number, options: { delay: number }, handler: JobHandler): void
  add(id: string | number, exprOrOpts: string | { delay: number }, handler: JobHandler): void {
    const key = String(id)
    if (this.jobs.has(key)) throw new Error(`Job "${key}" already exists`)

    // 包装 handler，捕获异步错误防止 node-schedule 未捕获 rejection
    const safeHandler = () => {
      try {
        const result = handler()
        if (result && typeof result.catch === 'function') {
          result.catch(() => {})
        }
      } catch {
        // handler 同步错误也不应影响调度器
      }
    }

    if (typeof exprOrOpts === 'string') {
      this.jobs.set(key, scheduleJob(exprOrOpts, safeHandler))
      this.meta.set(key, { type: 'cron', expression: exprOrOpts })
    } else {
      const date = new Date(Date.now() + exprOrOpts.delay)
      this.jobs.set(key, scheduleJob(date, safeHandler))
      this.meta.set(key, { type: 'delay', expression: `delay:${exprOrOpts.delay}` })
    }
  }

  remove(id: string | number): void {
    const key = String(id)
    const job = this.jobs.get(key)
    if (job) {
      job.cancel()
      this.jobs.delete(key)
      this.meta.delete(key)
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.cancel()
    }
    this.jobs.clear()
    this.meta.clear()
  }

  getJobs(): JobInfo[] {
    return Array.from(this.meta.entries()).map(([id, m]) => ({
      id,
      type: m.type,
      expression: m.expression,
    }))
  }

  /**
   * 从目录自动加载 schedule 任务文件
   * 文件后缀: {suffix}.ts/.js，default export 须为 defineJob 返回值
   * @param directory 目录路径
   * @param options.suffix 文件后缀标记，默认 'schedule'
   * @returns 注销函数
   */
  async load(directory: string, options?: { suffix?: string }): Promise<() => void> {
    const suffix = options?.suffix || 'schedule'
    const files = await glob(`**/*.${suffix}.{ts,js,tsx,jsx,mjs}`, { cwd: directory })
    const offFns: (() => void)[] = []

    for (const file of files) {
      const filePath = resolve(directory, file)
      const mod: { default?: JobDefinition } = await import(pathToFileURL(filePath).href)
      const jobDef = mod.default
      if (!jobDef || jobDef.type !== 'job') continue

      const key = String(jobDef.id)
      if (typeof jobDef.expression === 'string') {
        this.add(key, jobDef.expression, jobDef.handler)
      } else {
        this.add(key, jobDef.expression, jobDef.handler)
      }
      offFns.push(() => this.remove(key))
    }

    return () => {
      for (const off of offFns) off()
    }
  }
}
