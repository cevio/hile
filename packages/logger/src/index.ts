import { defineService } from '@hile/core'
import pino from 'pino'
import type { Logger as PinoLogger } from 'pino'

export type { PinoLogger as Logger }

export type LoggerOptions = {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  pretty?: boolean
  redact?: string[]
}

export function createLogger(options: LoggerOptions = {}): PinoLogger {
  const pretty = options.pretty ?? process.env['NODE_ENV'] !== 'production'
  const level = options.level ?? process.env['LOG_LEVEL'] ?? 'info'

  return pino({
    level,
    ...(options.redact ? { redact: options.redact } : {}),
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
  })
}

export default defineService(Symbol.for('@hile/logger'), async (shutdown) => {
  const logger = createLogger()
  shutdown(() => { logger.flush() })
  return logger
})
