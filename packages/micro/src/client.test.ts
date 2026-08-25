import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { MessageWs } from '@hile/message-ws';
import { createExecutionContext, MissingExecutionContextError } from '@hile/context';
import { Client, type MicroMessage } from './client';
import type { Server } from './server';

const testContext = createExecutionContext({ requestId: 'client-test' });

type Dispatch = (
  path: string,
  data: any,
  extras: Record<string, any>,
) => Promise<any>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class RequestWs extends MessageWs {
  protected exec(data: any): Promise<any> {
    return Promise.resolve(data);
  }

  public request<T = any>(
    url: string,
    data: any,
    options?: { timeout?: number; signal?: AbortSignal },
  ) {
    return this._send<T>({ url, data, metadata: { context: testContext } }, options);
  }

  public stream(url: string, data: any, options?: { signal?: AbortSignal }) {
    return this._stream({ url, data, metadata: { context: testContext } }, options);
  }

  public push(url: string, data: any, options?: { signal?: AbortSignal }) {
    return this._push({ url, data, metadata: { context: testContext } }, options);
  }
}

class ExposedClient extends Client {
  public invoke(data: MicroMessage, signal?: AbortSignal): Promise<any> {
    return this.exec(data, signal);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function createFakeSocket(): WebSocket {
  const socket = new EventEmitter() as EventEmitter & Partial<WebSocket> & {
    OPEN: number;
  };
  socket.OPEN = WebSocket.OPEN;
  socket.readyState = WebSocket.OPEN;
  socket.send = vi.fn();
  socket.close = vi.fn();
  return socket as WebSocket;
}

function createServer(dispatch: Dispatch): Server {
  return {
    dispatch,
  } as unknown as Server;
}

async function connectPair(dispatch: Dispatch) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const address = wss.address();
  if (!address || typeof address === 'string') {
    throw new Error('WebSocket test server did not allocate a port');
  }

  const serviceConnected = deferred<Client>();
  wss.once('connection', (socket) => {
    serviceConnected.resolve(new Client({
      server: createServer(dispatch),
      ws: socket,
      host: '127.0.0.1',
      port: address.port,
    }));
  });

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const caller = new RequestWs(socket);
  const service = await serviceConnected.promise;

  cleanups.push(async () => {
    caller.dispose();
    service.dispose();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  return { caller, service };
}

describe('@hile/micro Client AbortSignal propagation', () => {
  it('passes the exact modem signal to Server.dispatch extras', async () => {
    const socket = createFakeSocket();
    const controller = new AbortController();
    const dispatch = vi.fn<Dispatch>(async (_path, data, extras) => {
      expect(extras.signal).toBe(controller.signal);
      expect(extras.signal.aborted).toBe(false);
      return data;
    });
    const client = new ExposedClient({
      server: createServer(dispatch),
      ws: socket,
      host: '127.0.0.1',
      port: 3000,
    });
    cleanups.push(() => client.dispose());

    await expect(client.invoke({
      url: '/render',
      data: { id: 1 },
      metadata: { context: testContext },
    }, controller.signal))
      .resolves.toEqual({ id: 1 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps client and metadata extras while adding signal', async () => {
    const socket = createFakeSocket();
    const controller = new AbortController();
    const dispatch = vi.fn<Dispatch>(async (_path, _data, extras) => extras);
    const client = new ExposedClient({
      server: createServer(dispatch),
      ws: socket,
      host: '127.0.0.1',
      port: 3000,
    });
    cleanups.push(() => client.dispose());
    const metadata = { traceId: 'trace-1', context: testContext };

    const extras = await client.invoke({ url: '/render', data: null, metadata }, controller.signal);

    expect(extras).toMatchObject({ client, metadata, signal: controller.signal });
  });

  it('does not dispatch heartbeat envelopes', async () => {
    const socket = createFakeSocket();
    const dispatch = vi.fn<Dispatch>();
    const client = new ExposedClient({
      server: createServer(dispatch),
      ws: socket,
      host: '127.0.0.1',
      port: 3000,
    });
    cleanups.push(() => client.dispose());

    await expect(client.invoke({ url: '/-/heartbeat', data: {} }, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not let an arbitrary business route spoof framework control metadata', async () => {
    const socket = createFakeSocket();
    const dispatch = vi.fn<Dispatch>();
    const client = new ExposedClient({
      server: createServer(dispatch),
      ws: socket,
      host: '127.0.0.1',
      port: 3000,
    });
    cleanups.push(() => client.dispose());

    await expect(client.invoke({
      url: '/business/charge',
      data: {},
      metadata: { control: true },
    })).rejects.toBeInstanceOf(MissingExecutionContextError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects unknown routes from the framework control sender API', () => {
    const socket = createFakeSocket();
    const client = new ExposedClient({
      server: createServer(vi.fn<Dispatch>()),
      ws: socket,
      host: '127.0.0.1',
      port: 3000,
    });
    cleanups.push(() => client.dispose());

    expect(() => client.requestControl('/business/charge', {})).toThrow(/control route/i);
  });

  it('aborts a request handler when the remote caller aborts', async () => {
    const handlerStarted = deferred<AbortSignal>();
    const handlerAborted = deferred<void>();
    const { caller } = await connectPair(async (_path, _data, extras) => {
      const signal = extras.signal as AbortSignal;
      handlerStarted.resolve(signal);
      return new Promise((_resolve) => {
        signal.addEventListener('abort', () => handlerAborted.resolve(), { once: true });
      });
    });
    const controller = new AbortController();
    const request = caller.request('/render', {}, { signal: controller.signal });

    const serviceSignal = await handlerStarted.promise;
    expect(serviceSignal.aborted).toBe(false);
    controller.abort();

    await expect(request).rejects.toThrow('Abort');
    await handlerAborted.promise;
    expect(serviceSignal.aborted).toBe(true);
  });

  it('aborts a streaming handler and stops later chunks', async () => {
    const handlerStarted = deferred<AbortSignal>();
    const handlerAborted = deferred<void>();
    const { caller } = await connectPair(async (_path, _data, extras) => {
      const signal = extras.signal as AbortSignal;
      handlerStarted.resolve(signal);
      signal.addEventListener('abort', () => handlerAborted.resolve(), { once: true });
      return {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('first');
          if (signal.aborted) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          if (!signal.aborted) yield Buffer.from('late');
        },
      };
    });
    const controller = new AbortController();
    const stream = caller.stream('/render', {}, { signal: controller.signal });
    const streamClosed = new Promise<void>((resolve) => stream.once('close', resolve));
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      controller.abort();
    });
    stream.on('error', () => {});

    const serviceSignal = await handlerStarted.promise;
    await handlerAborted.promise;
    await streamClosed;

    expect(serviceSignal.aborted).toBe(true);
    expect(chunks).toHaveLength(1);
  });

  it('isolates abort state between concurrent requests', async () => {
    const signals = new Map<string, AbortSignal>();
    const bothStarted = deferred<void>();
    const releaseSecond = deferred<void>();
    const firstAborted = deferred<void>();
    const { caller } = await connectPair(async (_path, data, extras) => {
      const signal = extras.signal as AbortSignal;
      signals.set(data.id, signal);
      if (signals.size === 2) bothStarted.resolve();
      if (data.id === 'first') {
        return new Promise((_resolve) => {
          signal.addEventListener('abort', () => firstAborted.resolve(), { once: true });
        });
      }
      await releaseSecond.promise;
      return 'second-ok';
    });
    const firstController = new AbortController();
    const first = caller.request('/render', { id: 'first' }, { signal: firstController.signal });
    const second = caller.request('/render', { id: 'second' });

    await bothStarted.promise;
    firstController.abort();
    await expect(first).rejects.toThrow('Abort');
    await firstAborted.promise;
    expect(signals.get('first')?.aborted).toBe(true);
    expect(signals.get('second')?.aborted).toBe(false);

    releaseSecond.resolve();
    await expect(second).resolves.toBe('second-ok');
    expect(signals.get('second')?.aborted).toBe(false);
  });

  it('removes the caller abort listener after a normal response', async () => {
    let serviceSignal: AbortSignal | undefined;
    const { caller } = await connectPair(async (_path, _data, extras) => {
      serviceSignal = extras.signal;
      return 'ok';
    });
    const controller = new AbortController();

    await expect(caller.request('/render', {}, { signal: controller.signal })).resolves.toBe('ok');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(serviceSignal?.aborted).toBe(false);
  });
});
