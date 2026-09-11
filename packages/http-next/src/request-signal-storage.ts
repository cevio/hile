import { AsyncLocalStorage } from 'node:async_hooks'

// The custom server and compiled Next modules can evaluate different copies of
// this package in one JavaScript realm. A stable global key keeps those copies
// on the same storage while AsyncLocalStorage still isolates concurrent requests.
const requestSignalStorageKey = Symbol.for('@hile/http-next/request-signals')
export const requestSignals = (
  globalThis as typeof globalThis & {
    [requestSignalStorageKey]?: AsyncLocalStorage<AbortSignal>
  }
)[requestSignalStorageKey] ??= new AsyncLocalStorage<AbortSignal>()
