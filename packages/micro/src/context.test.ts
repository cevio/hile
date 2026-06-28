import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { getContext, runWithContext } from '@hile/context';
import { Application } from './application';
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
    const unregister = provider.register('/inspect-context', async () => getContext<ShopContext>());

    try {
      const result = await runWithContext<ShopContext>({
        shopId: 'shop-1',
        memberId: 'member-1',
        channel: 'wechat',
      }, () => consumer.call<Partial<ShopContext>>('context-provider', '/inspect-context', {}));

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
    const unregister = provider.register('/stream-context', async function* () {
      yield { shopId: getContext<ShopContext>().shopId };
      await new Promise(resolve => setTimeout(resolve, 1));
      yield { channel: getContext<ShopContext>().channel };
    });

    try {
      const stream = await runWithContext<ShopContext>({
        shopId: 'shop-2',
        memberId: 'member-2',
        channel: 'web',
      }, () => consumer.stream('context-stream-provider', '/stream-context', {}));

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
