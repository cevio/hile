import NextServer from 'next'
import { Http } from '@hile/http'
import type { Middleware } from 'koa'
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'

type NextApplication = ReturnType<typeof NextServer>
type NextRequestHandler = ReturnType<NextApplication['getRequestHandler']>

const requestSignalStorageKey = Symbol.for('@hile/http-next/request-signals')
const requestSignals = (
  globalThis as typeof globalThis & {
    [requestSignalStorageKey]?: AsyncLocalStorage<AbortSignal>
  }
)[requestSignalStorageKey] ??= new AsyncLocalStorage<AbortSignal>()

/** 返回当前 HttpNext 请求的取消信号；仅在请求异步上下文内有值。 */
export function getHttpNextRequestSignal(): AbortSignal | undefined {
  return requestSignals.getStore()
}

export type HttpNextProps = {
  /** 共享的 Hile 与 Next.js HTTP 端口。 */
  port: number
  /** Next.js 项目根目录，默认使用 `process.cwd()`。 */
  cwd?: string
}

export class HttpNext {
  private readonly isDevelopment: boolean
  private readonly cwd: string
  private readonly http: Http
  private nextApp?: NextApplication
  private nextHandler?: NextRequestHandler
  private started = false
  private stopPromise?: Promise<void>

  constructor(options: HttpNextProps) {
    const { cwd, port } = options
    this.isDevelopment = process.env.NODE_ENV === 'development'
    this.cwd = cwd || process.cwd()
    this.http = new Http({ port })
  }

  private createForwardToNextMiddleware(): Middleware {
    return async (ctx) => {
      if (!this.nextHandler) {
        ctx.throw(503, 'Next.js is not ready')
        return
      }
      ctx.respond = false
      ctx.status = 200
      const controller = new AbortController()
      const abort = () => {
        if (!controller.signal.aborted && !ctx.res.writableEnded) {
          controller.abort(new Error('HTTP client disconnected'))
        }
      }
      const cleanup = () => {
        ctx.req.off?.('aborted', abort)
        ctx.res.off?.('close', abort)
        ctx.res.off?.('finish', cleanup)
      }
      ctx.req.once?.('aborted', abort)
      ctx.res.once?.('close', abort)
      ctx.res.once?.('finish', cleanup)
      try {
        await requestSignals.run(
          controller.signal,
          () => this.nextHandler!(ctx.req, ctx.res),
        )
        if (ctx.res.writableEnded) cleanup()
      } catch (error) {
        cleanup()
        throw error
      }
    }
  }

  private assertCanConfigure() {
    if (this.started) throw new Error('HttpNext has already started')
  }

  private loadControllers(directory: string) {
    return this.http.load(directory, {
      suffix: 'controller',
      defaultSuffix: '/index',
      prefix: '/-',
      conflict: 'error',
    })
  }

  /** 注册在 Hile 控制器与 Next fallback 之前执行的 Koa 中间件。 */
  public use(middleware: Middleware) {
    this.assertCanConfigure()
    this.http.use(middleware)
    return this
  }

  /** 使用固定的 `/-`、`controller` 与 `/index` 约定加载额外控制器目录。 */
  public load(directory: string) {
    this.assertCanConfigure()
    return this.loadControllers(directory)
  }

  public async start(onReady?: (server: Server) => void | Promise<void>) {
    if (this.started) throw new Error('HttpNext has already started')
    this.started = true

    const controllersPath = resolve(
      this.cwd,
      this.isDevelopment ? 'src' : 'dist',
      'controllers',
    )

    let stopHttp: (() => Promise<void>) | undefined
    try {
      await this.loadControllers(controllersPath)
      let serverRef: Server | undefined
      const stopServer = await this.http.listen(async (server) => {
        serverRef = server
        const app = NextServer({
          dev: this.isDevelopment,
          httpServer: server,
          dir: this.cwd,
        })
        this.nextApp = app
        await app.prepare()
        this.nextHandler = app.getRequestHandler()
        this.http.use(this.createForwardToNextMiddleware())
      })
      stopHttp = stopServer

      if (onReady) await onReady(serverRef!)

      return () => {
        if (this.stopPromise) return this.stopPromise
        this.stopPromise = (async () => {
          let stopError: unknown
          try {
            await stopServer()
          } catch (error) {
            stopError = error
          }
          try {
            await this.nextApp?.close()
          } catch (error) {
            stopError ??= error
          }
          if (stopError) throw stopError
        })()
        return this.stopPromise
      }
    } catch (error) {
      try {
        await stopHttp?.()
      } catch {
        // Preserve the startup error while continuing Next runtime cleanup.
      }
      try {
        await this.nextApp?.close()
      } catch {
        // Preserve the startup error reported to the caller.
      }
      this.nextApp = undefined
      this.nextHandler = undefined
      this.started = false
      throw error
    }
  }
}

export default HttpNext
