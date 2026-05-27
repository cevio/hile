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
  shutdown(() => {
    // 在 event loop 还活跃时主动 end pino transport stream，
    // 这样 pino 注册的 process.on('exit') handler 会被移除，
    // 避免后续 process.exit() 时 thread-stream 的 Atomics.wait() 阻塞。
    const stream = (logger as any)[pino.symbols.streamSym];
    stream?.end?.();
    logger.flush()
  })
  return logger
})
