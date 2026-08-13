import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { RscPluginManifest } from './protocol';
import { RscHostRuntime } from './host/runtime';
import { createHileRscPluginClient } from './transport/hile';
import { RscPluginService } from './plugin/service';
import { attachRscPluginService } from './transport/registrar';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function manifest(): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'org.hile.fixture',
    buildId: 'build-a',
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: {
      entry: 'server-rsc/index.js',
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
    serverFunctions: [],
    clients: [],
    styles: [],
    routes: [{ path: '/fixture', entry: 'default' }],
  };
}

describe('RSC architecture composition', () => {
  it('attaches a plugin runtime to any registrar with configurable operation names', async () => {
    const handlers = new Map<string, (input: { data: unknown; signal?: AbortSignal }) => unknown>();
    const registrar = {
      register: vi.fn((operation: string, handler: (input: { data: unknown; signal?: AbortSignal }) => unknown) => {
        handlers.set(operation, handler);
        return () => { handlers.delete(operation); };
      }),
    };
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () { yield new Uint8Array([1, 2, 3]); },
    });

    const detach = attachRscPluginService(service, registrar, {
      describe: 'contract.describe',
      render: 'contract.render',
      action: 'contract.action',
      serverFunction: 'contract.server-function',
    });

    expect([...handlers.keys()]).toEqual([
      'contract.describe',
      'contract.render',
      'contract.action',
      'contract.server-function',
    ]);
    expect(await handlers.get('contract.describe')!({ data: null })).toMatchObject({ buildId: 'build-a' });
    const stream = handlers.get('contract.render')!({
      data: { buildId: 'build-a', path: '/fixture' },
    }) as AsyncIterable<Uint8Array>;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);

    detach();
    expect(handlers.size).toBe(0);
  });

  it('rolls back earlier operations when a generic registrar rejects a later operation', () => {
    const handlers = new Map<string, unknown>();
    const registrar = {
      register(operation: string, handler: unknown) {
        if (operation === 'contract.render') throw new Error('operation conflict');
        handlers.set(operation, handler);
        return () => { handlers.delete(operation); };
      },
    };
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
    });

    expect(() => attachRscPluginService(service, registrar, {
      describe: 'contract.describe', render: 'contract.render', action: 'contract.action',
      serverFunction: 'contract.server-function',
    })).toThrow('operation conflict');
    expect(handlers.size).toBe(0);
  });

  it('attempts every unregister operation even when one cleanup callback fails', () => {
    const handlers = new Map<string, unknown>();
    const registrar = {
      register(operation: string, handler: unknown) {
        handlers.set(operation, handler);
        return () => {
          handlers.delete(operation);
          if (operation === 'contract.render') throw new Error('cleanup failed');
        };
      },
    };
    const service = new RscPluginService({ manifest: manifest(), renderer: async function* () {} });
    const detach = attachRscPluginService(service, registrar, {
      describe: 'contract.describe', render: 'contract.render', action: 'contract.action',
      serverFunction: 'contract.server-function',
    });

    expect(detach).toThrow('unregister');
    expect(handlers.size).toBe(0);
    expect(() => attachRscPluginService(service, registrar)).not.toThrow();
  });

  it('does not leave routes attached when an inactive service is attached', () => {
    const handlers = new Map<string, unknown>();
    const registrar = {
      register(operation: string, handler: unknown) {
        handlers.set(operation, handler);
        return () => { handlers.delete(operation); };
      },
    };
    const service = new RscPluginService({
      manifest: manifest(), renderer: async function* () {},
    });
    service.deactivate();

    expect(() => attachRscPluginService(service, registrar)).toThrow('inactive');
    expect(handlers.size).toBe(0);
  });

  it('adapts an application-like transport without requiring a concrete micro runtime', async () => {
    const application = {
      call: vi.fn(async (_namespace: string, operation: string) =>
        operation === 'manifest.read' ? manifest() : { accepted: true }),
      stream: vi.fn(async () => Readable.from([new Uint8Array([4, 5])])),
    };
    const client = createHileRscPluginClient(application, 'plugin.runtime', {
      describe: 'manifest.read',
      render: 'tree.render',
      action: 'function.invoke',
      serverFunction: 'server-function.invoke',
    });
    const signal = new AbortController().signal;

    await expect(client.describe({ signal })).resolves.toMatchObject({ pluginId: 'org.hile.fixture' });
    await expect(client.render({ buildId: 'build-a', path: '/fixture' }, { signal }))
      .resolves.toBeInstanceOf(Readable);
    await expect(client.action({ buildId: 'build-a', actionId: 'fixture', input: {} }, { signal }))
      .resolves.toEqual({ accepted: true });
    await expect(client.serverFunction({
      buildId: 'build-a', referenceId: 'org.hile.fixture/build-a/src/actions#run',
      args: { type: 'array', value: [] },
    }, { signal })).resolves.toEqual({ accepted: true });

    expect(application.call).toHaveBeenNthCalledWith(
      1, 'plugin.runtime', 'manifest.read', {}, { signal },
    );
    expect(application.stream).toHaveBeenCalledWith(
      'plugin.runtime', 'tree.render', { buildId: 'build-a', path: '/fixture' }, { signal },
    );
    expect(application.call).toHaveBeenNthCalledWith(
      2,
      'plugin.runtime',
      'function.invoke',
      { buildId: 'build-a', actionId: 'fixture', input: {} },
      { signal },
    );
    expect(application.call).toHaveBeenNthCalledWith(
      3,
      'plugin.runtime',
      'server-function.invoke',
      {
        buildId: 'build-a', referenceId: 'org.hile.fixture/build-a/src/actions#run',
        args: { type: 'array', value: [] },
      },
      { signal },
    );
  });

  it('composes locator, transport and decoder without knowing Hile or Next', async () => {
    const flight = Readable.from([new Uint8Array([8, 9])]);
    const client = {
      describe: vi.fn(async () => manifest()),
      render: vi.fn(async () => flight),
      action: vi.fn(async () => undefined),
    };
    const release = vi.fn();
    const locator = { resolve: vi.fn(async () => ({ client, release })) };
    const decoded = { type: 'section', props: { children: 'decoded' } } as unknown as ReactNode;
    const decoder = { decode: vi.fn(async (source: AsyncIterable<Uint8Array>) => {
      for await (const _chunk of source) { /* consume the owned Flight source */ }
      return decoded;
    }) };
    const runtime = new RscHostRuntime({ locator, decoder });
    const signal = new AbortController().signal;

    await expect(runtime.render({
      pluginId: 'org.hile.fixture',
      request: { buildId: 'build-a', path: '/fixture' },
      signal,
    })).resolves.toBe(decoded);

    expect(locator.resolve).toHaveBeenCalledWith(
      { pluginId: 'org.hile.fixture', buildId: 'build-a' },
      { signal },
    );
    expect(client.render).toHaveBeenCalledWith(
      { buildId: 'build-a', path: '/fixture' },
      { signal },
    );
    expect(decoder.decode).toHaveBeenCalledWith(expect.any(Object), {
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      signal,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('holds the exact build lease until a decoder finishes consuming streamed Flight', async () => {
    const finish = deferred<void>();
    const stream = (async function* () {
      yield new Uint8Array([1]);
      await finish.promise;
      yield new Uint8Array([2]);
    })();
    const client = {
      describe: vi.fn(async () => manifest()),
      render: vi.fn(async () => stream),
      action: vi.fn(async () => undefined),
    };
    const release = vi.fn();
    let consumption!: Promise<void>;
    const runtime = new RscHostRuntime({
      locator: { resolve: vi.fn(async () => ({ client, release })) },
      decoder: {
        async decode(source) {
          const iterator = source[Symbol.asyncIterator]();
          await iterator.next();
          consumption = (async () => {
            while (!(await iterator.next()).done) { /* drain remaining Flight chunks */ }
          })();
          return null;
        },
      },
    });

    await runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    });
    expect(release).not.toHaveBeenCalled();
    finish.resolve();
    await consumption;
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects a resolved plugin whose declared identity does not match the requested identity', async () => {
    const client = {
      describe: vi.fn(async () => ({ ...manifest(), pluginId: 'org.hile.other' })),
      render: vi.fn(async () => Readable.from([])),
      action: vi.fn(async () => undefined),
    };
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({ client, release: () => undefined }) },
      decoder: { decode: async () => null },
      verifyManifest: true,
    });

    await expect(runtime.render({
      pluginId: 'org.hile.fixture',
      request: { buildId: 'build-a', path: '/fixture' },
    })).rejects.toThrow('identity mismatch');
    expect(client.render).not.toHaveBeenCalled();
  });
});
