import { describe, it, expect, vi, afterEach } from 'vitest'

const mockParentPort = vi.hoisted(() => ({
  on: vi.fn(),
  postMessage: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('node:worker_threads', () => ({
  parentPort: mockParentPort,
  Worker: class {},
  MessagePort: class {},
  MessageChannel: class {},
}))

import { MessageWorkerThread } from './index'

class EchoWorkerThread extends MessageWorkerThread {
  protected exec(data: any): Promise<any> {
    return Promise.resolve(data)
  }

  public request<T = any>(data: any, _options?: any) {
    return this._send<T>(data)
  }
}

describe('parentPort available', () => {
  const disposables: MessageWorkerThread[] = []

  afterEach(() => {
    disposables.forEach(d => d.dispose())
    disposables.length = 0
  })

  it('uses parentPort when no port provided', () => {
    const modem = new EchoWorkerThread()
    disposables.push(modem)

    expect(mockParentPort.on).toHaveBeenCalledWith('message', expect.any(Function))
  })
})
