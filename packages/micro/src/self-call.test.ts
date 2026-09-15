import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createExecutionContext } from '@hile/context';
import { Application } from './application';
import { Registry } from './registry';
import { Server } from './server';

const testAdvertise = { advertiseHost: '127.0.0.1' as const };

async function getAvailablePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');

    const verify = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        verify.on('error', reject);
        verify.listen(address.port, resolve);
      });
      await new Promise<void>((resolve, reject) => verify.close((error) => error ? reject(error) : resolve()));
      return address.port;
    } catch {
      verify.close();
    }
  }
  throw new Error('Unable to allocate test port after 20 attempts');
}

async function listenOnAvailablePort(server: Server | Registry) {
  for (let attempt = 0; ; attempt++) {
    const port = await getAvailablePort();
    try {
      return { port, close: await server.listen(port) };
    } catch (error) {
      if (attempt >= 9 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function collectStream<T>(stream: Readable): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value as T);
  return values;
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function startSelfApplication(namespace: string) {
  const registry = new Registry(testAdvertise);
  const registryListener = await listenOnAvailablePort(registry);
  const application = new Application({
    namespace,
    registry: { host: '127.0.0.1', port: registryListener.port },
    ...testAdvertise,
  });
  try {
    const applicationListener = await listenOnAvailablePort(application);
    return {
      application,
      applicationPort: applicationListener.port,
      disposeApplication: applicationListener.close,
      disposeRegistry: registryListener.close,
    };
  } catch (error) {
    await registryListener.close();
    throw error;
  }
}

class PeerServer extends Server {
  public async callPeer(host: string, port: number, url: string, data: unknown) {
    const client = await this.connect(host, port);
    return client.request(url, data, {
      context: createExecutionContext({ caller: this.namespace }),
    });
  }
}

describe('@hile/micro same-namespace self calls', () => {
  it('keeps the external inbound request connected while a handler calls its own namespace', async () => {
    const registry = new Registry(testAdvertise);
    const registryListener = await listenOnAvailablePort(registry);
    const application = new Application({
      namespace: 'self-call-service',
      registry: { host: '127.0.0.1', port: registryListener.port },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'self-call-consumer',
      registry: { host: '127.0.0.1', port: registryListener.port },
      ...testAdvertise,
    });
    const applicationListener = await listenOnAvailablePort(application);
    const consumerListener = await listenOnAvailablePort(consumer);
    const unregisterInner = application.register('/inner', async ({ data, invocation }) => ({
      value: data.value,
      requestId: invocation.context.values.requestId,
    }));
    const unregisterOuter = application.register('/outer', async ({ data, invocation }) => {
      return application.call('self-call-service', '/inner', data, {
        context: invocation.context,
        timeout: 1_000,
        retries: 0,
      });
    });

    try {
      await expect(consumer.call(
        'self-call-service',
        '/outer',
        { value: 'ok' },
        {
          context: createExecutionContext({ requestId: 'same-namespace-json' }),
          timeout: 2_000,
          retries: 0,
        },
      )).resolves.toEqual({ value: 'ok', requestId: 'same-namespace-json' });
    } finally {
      unregisterOuter();
      unregisterInner();
      await consumerListener.close();
      await applicationListener.close();
      await registryListener.close();
    }
  });

  it('does not interrupt simultaneous calls when both peers connect to each other', async () => {
    const peerA = new PeerServer('peer-a', testAdvertise);
    const peerB = new PeerServer('peer-b', testAdvertise);
    const listenerA = await listenOnAvailablePort(peerA);
    const listenerB = await listenOnAvailablePort(peerB);
    const unregisterA = peerA.register('/echo', async ({ data }) => ({ from: 'a', data }));
    const unregisterB = peerB.register('/echo', async ({ data }) => ({ from: 'b', data }));

    try {
      await expect(Promise.all([
        peerA.callPeer('127.0.0.1', listenerB.port, '/echo', 'from-a'),
        peerB.callPeer('127.0.0.1', listenerA.port, '/echo', 'from-b'),
      ])).resolves.toEqual([
        { from: 'b', data: 'from-a' },
        { from: 'a', data: 'from-b' },
      ]);
    } finally {
      unregisterB();
      unregisterA();
      await listenerB.close();
      await listenerA.close();
    }
  });

  it('preserves request input, response streaming, and Context through a self connection', async () => {
    const fixture = await startSelfApplication('self-duplex-service');
    const unregister = fixture.application.register('/duplex', async function* ({ data, input, invocation }) {
      for await (const chunk of input ?? []) {
        yield {
          operation: data.operation,
          value: Buffer.from(chunk).toString('utf8').toUpperCase(),
          requestId: invocation.context.values.requestId,
        };
      }
    });

    try {
      const stream = await fixture.application.stream(
        'self-duplex-service',
        '/duplex',
        { operation: 'uppercase' },
        {
          context: createExecutionContext({ requestId: 'same-namespace-duplex' }),
          input: Readable.from([Buffer.from('one'), Buffer.from('two')]),
          window: 1,
        },
      );
      await expect(collectStream(stream)).resolves.toEqual([
        { operation: 'uppercase', value: 'ONE', requestId: 'same-namespace-duplex' },
        { operation: 'uppercase', value: 'TWO', requestId: 'same-namespace-duplex' },
      ]);
    } finally {
      unregister();
      await fixture.disposeApplication();
      await fixture.disposeRegistry();
    }
  });

  it('preserves response backpressure when streamPeer targets the same application', async () => {
    const fixture = await startSelfApplication('self-stream-peer-service');
    let produced = 0;
    const unregister = fixture.application.register('/numbers', async function* () {
      for (let value = 1; value <= 3; value++) {
        produced++;
        yield value;
      }
    });

    try {
      const stream = await fixture.application.streamPeer(
        { host: '127.0.0.1', port: fixture.applicationPort },
        '/numbers',
        {},
        {
          context: createExecutionContext({ requestId: 'same-namespace-stream-peer' }),
          window: 1,
        },
      );
      await waitForCondition(() => produced === 1, 'self stream did not produce its first chunk');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(produced).toBe(1);

      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
      await waitForCondition(() => produced === 2, 'self stream did not resume after credit');
      await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
      await expect(iterator.next()).resolves.toEqual({ value: 3, done: false });
      await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    } finally {
      unregister();
      await fixture.disposeApplication();
      await fixture.disposeRegistry();
    }
  });

  it('propagates AbortSignal through a self call and keeps the connection reusable', async () => {
    const fixture = await startSelfApplication('self-abort-service');
    const started = createDeferred();
    const handlerAborted = createDeferred();
    const unregisterAbort = fixture.application.register('/wait', async ({ invocation }) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        invocation.signal.addEventListener('abort', () => {
          handlerAborted.resolve();
          resolve();
        }, { once: true });
      });
      return 'too-late';
    });
    const unregisterEcho = fixture.application.register('/echo', async ({ data }) => data);

    try {
      const controller = new AbortController();
      const request = fixture.application.call('self-abort-service', '/wait', {}, {
        context: createExecutionContext({ requestId: 'same-namespace-abort' }),
        signal: controller.signal,
        timeout: 1_000,
        retries: 0,
      });
      await started.promise;
      controller.abort();
      await expect(request).rejects.toMatchObject({ status: 'ECONNABORTED' });
      await handlerAborted.promise;
      await expect(fixture.application.call('self-abort-service', '/echo', 'reused', {
        context: createExecutionContext({ requestId: 'same-namespace-after-abort' }),
        retries: 0,
      })).resolves.toBe('reused');
    } finally {
      unregisterEcho();
      unregisterAbort();
      await fixture.disposeApplication();
      await fixture.disposeRegistry();
    }
  });

  it('keeps retry and circuit-breaker accounting on the normal self-call path', async () => {
    const fixture = await startSelfApplication('self-retry-service');
    let attempts = 0;
    const unregister = fixture.application.register('/flaky', async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient failure');
      return 'recovered';
    });

    try {
      await expect(fixture.application.call('self-retry-service', '/flaky', {}, {
        context: createExecutionContext({ requestId: 'same-namespace-retry' }),
        retries: 1,
      })).resolves.toBe('recovered');
      expect(attempts).toBe(2);
    } finally {
      unregister();
      await fixture.disposeApplication();
      await fixture.disposeRegistry();
    }
  });

  it('preserves timeout and cleanup semantics for a self call', async () => {
    const fixture = await startSelfApplication('self-timeout-service');
    const handlerAborted = createDeferred();
    const unregister = fixture.application.register('/wait', async ({ invocation }) => {
      await new Promise<void>((resolve) => {
        invocation.signal.addEventListener('abort', () => {
          handlerAborted.resolve();
          resolve();
        }, { once: true });
      });
      return 'too-late';
    });

    try {
      await expect(fixture.application.call('self-timeout-service', '/wait', {}, {
        context: createExecutionContext({ requestId: 'same-namespace-timeout' }),
        timeout: 30,
        retries: 0,
      })).rejects.toMatchObject({ status: 'ETIMEDOUT' });
      await handlerAborted.promise;
    } finally {
      unregister();
      await fixture.disposeApplication();
      expect((fixture.application as any).clients.size).toBe(0);
      expect((fixture.application as any).connections.size).toBe(0);
      await fixture.disposeRegistry();
    }
  });

  it('propagates stream cancellation through a self connection', async () => {
    const fixture = await startSelfApplication('self-stream-abort-service');
    const finalized = createDeferred();
    const unregister = fixture.application.register('/wait-stream', async function* ({ invocation }) {
      try {
        yield 'first';
        await new Promise<void>((resolve) => invocation.signal.addEventListener('abort', () => resolve(), { once: true }));
      } finally {
        finalized.resolve();
      }
    });

    try {
      const controller = new AbortController();
      const stream = await fixture.application.stream('self-stream-abort-service', '/wait-stream', {}, {
        context: createExecutionContext({ requestId: 'same-namespace-stream-abort' }),
        signal: controller.signal,
        timeout: 1_000,
      });
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({ value: 'first', done: false });
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ status: 'ECONNABORTED' });
      await finalized.promise;
    } finally {
      unregister();
      await fixture.disposeApplication();
      await fixture.disposeRegistry();
    }
  });
});
