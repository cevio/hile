import { Scheduler } from './scheduler.js'
import type { JobDefinition, JobHandler } from './types.js'

export { Scheduler }
export type { JobInfo } from './scheduler.js'
export type { JobDefinition, JobHandler }

let _jobId = 1

export function defineJob(
  expression: string | { delay: number },
  handler: () => Promise<void> | void,
): JobDefinition {
  return { id: _jobId++, type: 'job', expression, handler }
}