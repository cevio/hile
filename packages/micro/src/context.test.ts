import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createExecutionContext,
  createInvocationContext,
  MissingExecutionContextError,
  UnsupportedExecutionContextVersionError,
} from '@hile/context';
import { Application } from './application';
import { defineMicroMessage } from './message';
import { Registry } from './registry';

const testAdvertise = { advertiseHost: '127.0.0.1' as const };

type ShopContext = {
  shopId: string;
  memberId: string;
  channel: 'web' | 'wechat';
};

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate test port');
  }
  return address.port;
}

async function collectStream<T>(readable: Readable): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of readable) {
    chunks.push(chunk as T);
  }
  return chunks;
}

describe('@hile/micro context propagation', () => {
  it('gives file-loaded business handlers a typed explicit invocation context', async () => {
    const handler = defineMicroMessage(async ({ invocation }) => invocation.context.values.requestId);
    const invocation = createInvocationContext(
      createExecutionContext({ requestId: 'file-handler' }),
      new AbortController().signal,
    );

    await expect(handler.fn({ data: {}, url: '/typed-context', client: {} as never, invocation }))
      .resolves.toBe('file-handler');
  });

  it('fails before transport when a business call omits execution context', async () => {
    const consumer = new Application({
      namespace: 'context-required-consumer',
      registry: { host: '127.0.0.1', port: 1 },
      ...testAdvertise,
    });

    await expect((consumer.call as any)('provider', '/inspect-context', {})).rejects.toThrow(
      MissingExecutionContextError,
    );
  });

  it('rejects an unsupported execution context version before registry lookup', async () => {
    const consumer = new Application({
      namespace: 'context-version-consumer',
      registry: { host: '127.0.0.1', port: 1 },
      ...testAdvertise,
    });

    await expect(consumer.call('provider', '/inspect-context', {}, {
      context: { version: 2, values: {} } as never,
    })).rejects.toThrow(UnsupportedExecutionContextVersionError);
  });

  it('rejects retries for a non-replayable streamed request before registry lookup', async () => {
    const consumer = new Application({
      namespace: 'request-stream-retry-consumer',
      registry: { host: '127.0.0.1', port: 1 },
      ...testAdvertise,
    });

    await expect(consumer.call(
      'provider',
      '/upload',
      Readable.from(['body']),
      {
        context: createExecutionContext({ requestId: 'stream-retry' }),
        retries: 1,
      },
    )).rejects.toThrow('non-replayable');
  });

  it('rejects competing streamed inputs before registry lookup', async () => {
    const consumer = new Application({
      namespace: 'request-stream-conflict-consumer',
      registry: { host: '127.0.0.1', port: 1 },
      ...testAdvertise,
    });

    await expect(consumer.call(
      'provider',
      '/upload',
      Readable.from(['data-stream']),
      {
        context: createExecutionContext({ requestId: 'stream-conflict' }),
        input: Readable.from(['option-stream']),
      },
    )).rejects.toThrow('only one request input stream');
  });

  it('rejects an invalid streamed input before registry lookup', async () => {
    const consumer = new Application({
      namespace: 'request-stream-invalid-consumer',
      registry: { host: '127.0.0.1', port: 1 },
      ...testAdvertise,
    });

    await expect(consumer.call(
      'provider',
      '/upload',
      { filename: 'invalid.bin' },
      {
        context: createExecutionContext({ requestId: 'stream-invalid' }),
        input: {} as never,
      },
    )).rejects.toThrow('AsyncIterable, Uint8Array, or ArrayBuffer');
  });

  it('propagates user-defined context through Application.call', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const provider = new Application({
      namespace: 'context-provider',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'context-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    const unregister = provider.register('/inspect-context', async ({ invocation }) => invocation.context.values);

    try {
      const context = createExecutionContext<ShopContext>({
        shopId: 'shop-1',
        memberId: 'member-1',
        channel: 'wechat',
      });
      const result = await consumer.call<Partial<ShopContext>>(
        'context-provider',
        '/inspect-context',
        {},
        { context },
      );

      expect(result).toEqual({
        shopId: 'shop-1',
        memberId: 'member-1',
        channel: 'wechat',
      });
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('propagates a streamed request input through Application.call', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const provider = new Application({
      namespace: 'request-stream-provider',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'request-stream-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    const unregister = provider.register('/upload', async ({ data, input, invocation }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input ?? []) chunks.push(Buffer.from(chunk));
      return {
        data,
        body: Buffer.concat(chunks).toString('utf8'),
        requestId: invocation.context.values.requestId,
      };
    });

    try {
      const result = await consumer.call(
        'request-stream-provider',
        '/upload',
        { filename: 'hello.txt' },
        {
          context: createExecutionContext({ requestId: 'stream-upload' }),
          input: Readable.from([Buffer.from('hello'), Buffer.from(' world')]),
          retries: 0,
        },
      );

      expect(result).toEqual({
        data: { filename: 'hello.txt' },
        body: 'hello world',
        requestId: 'stream-upload',
      });

      const inferred = await consumer.call(
        'request-stream-provider',
        '/upload',
        Readable.from([Buffer.from('automatic')]),
        { context: createExecutionContext({ requestId: 'stream-inferred' }) },
      );
      expect(inferred).toEqual({
        data: undefined,
        body: 'automatic',
        requestId: 'stream-inferred',
      });
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('streams request input and response output through Application.stream', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const provider = new Application({
      namespace: 'duplex-stream-provider',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'duplex-stream-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    const unregister = provider.register('/uppercase', async function* ({ input, invocation }) {
      for await (const chunk of input ?? []) {
        yield {
          value: Buffer.from(chunk).toString('utf8').toUpperCase(),
          requestId: invocation.context.values.requestId,
        };
      }
    });

    try {
      const stream = await consumer.stream(
        'duplex-stream-provider',
        '/uppercase',
        { operation: 'uppercase' },
        {
          context: createExecutionContext({ requestId: 'duplex-stream' }),
          input: Readable.from([Buffer.from('one'), Buffer.from('two')]),
        },
      );

      await expect(collectStream(stream)).resolves.toEqual([
        { value: 'ONE', requestId: 'duplex-stream' },
        { value: 'TWO', requestId: 'duplex-stream' },
      ]);
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('keeps user-defined context active while a remote stream is iterated', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const provider = new Application({
      namespace: 'context-stream-provider',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'context-stream-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    const unregister = provider.register('/stream-context', async function* ({ invocation }) {
      yield { shopId: invocation.context.values.shopId };
      await new Promise(resolve => setTimeout(resolve, 1));
      yield { channel: invocation.context.values.channel };
    });

    try {
      const context = createExecutionContext<ShopContext>({
        shopId: 'shop-2',
        memberId: 'member-2',
        channel: 'web',
      });
      const stream = await consumer.stream(
        'context-stream-provider',
        '/stream-context',
        {},
        { context },
      );

      await expect(collectStream(stream)).resolves.toEqual([
        { shopId: 'shop-2' },
        { channel: 'web' },
      ]);
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });
});
