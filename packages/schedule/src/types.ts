export type JobHandler = () => Promise<void> | void

export type JobDefinition = {
  id: number
  type: 'job'
  expression: string | { delay: number }
  handler: JobHandler
}
