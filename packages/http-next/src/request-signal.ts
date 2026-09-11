import { requestSignals } from './request-signal-storage'

/** 返回当前 HttpNext 请求的取消信号；仅在请求异步上下文内有值。 */
export function getHttpNextRequestSignal(): AbortSignal | undefined {
  return requestSignals.getStore()
}
