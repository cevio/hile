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
    const streamOptions = { signal, timeout: 1_000, idleTimeout: 250, window: 8 };

    await expect(client.describe({ signal })).resolves.toMatchObject({ pluginId: 'org.hile.fixture' });
    await expect(client.render({ buildId: 'build-a', path: '/fixture' }, streamOptions))
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
      'plugin.runtime', 'tree.render', { buildId: 'build-a', path: '/fixture' }, streamOptions,
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
      timeout: 10_000,
      idleTimeout: 2_000,
      window: 8,
    })).resolves.toBe(decoded);

    expect(locator.resolve).toHaveBeenCalledWith(
      { pluginId: 'org.hile.fixture', buildId: 'build-a' },
      { signal },
    );
    expect(client.render).toHaveBeenCalledWith(
      { buildId: 'build-a', path: '/fixture' },
      { signal, timeout: 10_000, idleTimeout: 2_000, window: 8 },
    );
    expect(decoder.decode).toHaveBeenCalledWith(expect.any(Object), {
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      signal,
    });
    expect(release).toHaveBeenCalledTimes(2);
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
    const observe = vi.fn();
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
      observe,
    });

    await runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    finish.resolve();
    await consumption;
    expect(release).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', bytes: 2 }));
  });

  it('rejects a resolved plugin whose declared identity does not match the requested identity', async () => {
    const client = {
      describe: vi.fn(async () => ({ ...manifest(), pluginId: 'org.hile.other' })),
      render: vi.fn(async () => Readable.from([])),
      action: vi.fn(async () => undefined),
    };
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({ client, verificationKey: 'fixture.v1', release: () => undefined }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
      verifyManifest: true,
    });

    await expect(runtime.render({
      pluginId: 'org.hile.fixture',
      request: { buildId: 'build-a', path: '/fixture' },
    })).rejects.toThrow('identity mismatch');
    expect(client.render).not.toHaveBeenCalled();
  });

  it('verifies one immutable plugin build only once across render leases', async () => {
    const client = {
      describe: vi.fn(async () => manifest()),
      render: vi.fn(async () => Readable.from([new Uint8Array([1])])),
      action: vi.fn(async () => undefined),
      serverFunction: vi.fn(async () => ({ type: 'null' as const })),
    };
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({
        client, verificationKey: 'fixture.v1', release: () => undefined,
      }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
    });

    await runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    });
    await runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    });

    expect(client.describe).toHaveBeenCalledOnce();
  });

  it('retries immutable manifest verification after a failed attempt', async () => {
    const client = {
      describe: vi.fn()
        .mockRejectedValueOnce(new Error('temporary describe failure'))
        .mockResolvedValueOnce(manifest()),
      render: vi.fn(async () => Readable.from([])),
      action: vi.fn(async () => undefined),
      serverFunction: vi.fn(async () => ({ type: 'null' as const })),
    };
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({ client, release: () => undefined }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
    });

    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    })).rejects.toThrow('temporary describe failure');
    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    })).resolves.toBeNull();
    expect(client.describe).toHaveBeenCalledTimes(2);
  });

  it('lets one caller abort a shared manifest verification without poisoning the cache', async () => {
    const verification = deferred<ReturnType<typeof manifest>>();
    const release = vi.fn();
    const client = {
      describe: vi.fn(() => verification.promise),
      render: vi.fn(async () => Readable.from([])),
      action: vi.fn(async () => undefined),
    };
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({ client, verificationKey: 'fixture.v1', release }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
    });
    const controller = new AbortController();
    const rendering = runtime.render({
      pluginId: 'org.hile.fixture',
      request: { buildId: 'build-a', path: '/fixture' },
      signal: controller.signal,
    });
    controller.abort(new Error('caller left'));
    await expect(rendering).rejects.toThrow('caller left');
    expect(release).toHaveBeenCalledOnce();
    verification.resolve(manifest());
    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    })).resolves.toBeNull();
    expect(client.describe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('bounds the externally shared immutable verification cache', async () => {
    const cache = new Map<string, Promise<void>>();
    const runtime = new RscHostRuntime({
      locator: { resolve: async ({ buildId }) => ({
        client: {
          describe: async () => ({ ...manifest(), buildId }),
          render: async () => Readable.from([]),
          action: async () => undefined,
        },
        verificationKey: `fixture/${buildId}`,
        release: () => undefined,
      }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* drain */ }
        return null;
      } },
      verificationCache: cache,
      verificationCacheSize: 2,
    });
    for (const buildId of ['build-a', 'build-b', 'build-c']) {
      await runtime.render({ pluginId: 'org.hile.fixture', request: { buildId, path: '/' } });
    }
    expect(cache.size).toBe(2);
  });

  it('observes completed Flight streams with immutable identity, bytes, duration, and outcome', async () => {
    const observe = vi.fn();
    const client = {
      describe: vi.fn(async () => manifest()),
      render: vi.fn(async () => Readable.from([
        new Uint8Array([1, 2]),
        new Uint8Array([3]),
      ])),
      action: vi.fn(async () => undefined),
      serverFunction: vi.fn(async () => ({ type: 'null' as const })),
    };
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({ client, release: () => undefined }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
      observe,
    });

    await runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    });

    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'render',
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      outcome: 'success',
      bytes: 3,
      durationMs: expect.any(Number),
    }));
  });

  it('observes locator failures before a build lease exists', async () => {
    const error = new Error('plugin unavailable');
    const observe = vi.fn();
    const runtime = new RscHostRuntime({
      locator: { resolve: vi.fn(async () => { throw error; }) },
      decoder: { decode: vi.fn() },
      observe,
    });

    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    })).rejects.toBe(error);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      outcome: 'error',
      bytes: 0,
      error,
    }));
  });

  it('observes a decoder failure after Flight reaches EOF as an error', async () => {
    const error = new Error('invalid Flight payload');
    const observe = vi.fn();
    const client = {
      describe: vi.fn(async () => manifest()),
      render: vi.fn(async () => Readable.from([new Uint8Array([1, 2, 3])])),
      action: vi.fn(async () => undefined),
    };
    const runtime = new RscHostRuntime({
      locator: { resolve: vi.fn(async () => ({ client, release: vi.fn() })) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        throw error;
      } },
      observe,
    });

    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/fixture' },
    })).rejects.toBe(error);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      bytes: 3,
      error,
    }));
  });

  it('handles a Flight iterator rejection without an unhandled rejection', async () => {
    const error = new Error('stream boom');
    const release = vi.fn();
    const observe = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({
        client: {
          describe: async () => manifest(),
          render: async () => ({
            [Symbol.asyncIterator]: () => ({ next: async () => { throw error; } }),
          }),
          action: async () => undefined,
          serverFunction: async () => ({ type: 'null' as const }),
        },
        release,
      }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
      observe,
    });
    try {
      await expect(runtime.render({
        pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
      })).rejects.toBe(error);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(2);
      expect(observe).toHaveBeenCalledOnce();
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', error }));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('reports an aborted Flight stream as cancelled exactly once', async () => {
    const error = new DOMException('caller left', 'AbortError');
    const release = vi.fn();
    const observe = vi.fn();
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({
        client: {
          describe: async () => manifest(),
          render: async () => ({
            [Symbol.asyncIterator]: () => ({ next: async () => { throw error; } }),
          }),
          action: async () => undefined,
          serverFunction: async () => ({ type: 'null' as const }),
        },
        release,
      }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
      observe,
    });

    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
    })).rejects.toBe(error);
    expect(release).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled', bytes: 0 }));
  });

  it('reports lease cleanup failure without losing stream completion telemetry', async () => {
    const cleanupError = new Error('release failed');
    const observe = vi.fn();
    const release = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cleanupError);
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({
        client: {
          describe: async () => manifest(),
          render: async () => Readable.from([]),
          action: async () => undefined,
          serverFunction: async () => ({ type: 'null' as const }),
        },
        release,
      }) },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
      observe,
    });
    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
    })).rejects.toBe(cleanupError);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', error: cleanupError,
    }));
  });

  it('reports a caller aborted before resolution as cancelled without acquiring a lease', async () => {
    const controller = new AbortController();
    const reason = new DOMException('gone', 'AbortError');
    controller.abort(reason);
    const resolve = vi.fn();
    const observe = vi.fn();
    const runtime = new RscHostRuntime({
      locator: { resolve }, decoder: { decode: async () => null }, observe,
    });
    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(resolve).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled', bytes: 0 }));
  });

  it('reports cancellation while plugin resolution is pending as cancelled', async () => {
    const controller = new AbortController();
    const reason = new DOMException('gone while resolving', 'AbortError');
    const observe = vi.fn();
    const runtime = new RscHostRuntime({
      locator: {
        resolve: (_target, options) => new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        }),
      },
      decoder: { decode: async () => null },
      observe,
    });
    const rendering = runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(rendering).rejects.toBe(reason);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled' }));
  });

  it('preserves manifest verification and verification-lease cleanup failures', async () => {
    const describeError = new Error('describe failed');
    const cleanupError = new Error('verification release failed');
    const requestRelease = vi.fn();
    let resolves = 0;
    const observe = vi.fn();
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => {
        resolves++;
        return resolves % 2 === 1
          ? {
              verificationKey: 'fixture.v1',
              client: {
                describe: async () => manifest(), render: async () => Readable.from([]),
                action: async () => undefined,
                serverFunction: async () => ({ type: 'null' as const }),
              },
              release: requestRelease,
            }
          : {
              verificationKey: 'fixture.v1',
              client: {
                describe: async () => { throw describeError; },
                render: async () => Readable.from([]), action: async () => undefined,
                serverFunction: async () => ({ type: 'null' as const }),
              },
              release: async () => { throw cleanupError; },
            };
      } },
      decoder: { decode: async () => null },
      observe,
    });
    const rendering = runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
    });
    await expect(rendering).rejects.toSatisfy((error: unknown) =>
      error instanceof AggregateError
      && error.errors.includes(describeError)
      && error.errors.includes(cleanupError));
    expect(requestRelease).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
  });

  it('preserves an identity mismatch when verification-lease cleanup also fails', async () => {
    const cleanupError = new Error('verification release failed');
    let resolves = 0;
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => {
        resolves++;
        return {
          verificationKey: 'fixture.v1',
          client: {
            describe: async () => resolves === 2
              ? { ...manifest(), pluginId: 'org.hile.attacker' }
              : manifest(),
            render: async () => Readable.from([]), action: async () => undefined,
            serverFunction: async () => ({ type: 'null' as const }),
          },
          release: resolves === 2
            ? async () => { throw cleanupError; }
            : () => undefined,
        };
      } },
      decoder: { decode: async () => null },
    });
    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof AggregateError
      && error.errors.some((entry) => entry instanceof Error && entry.message.includes('identity mismatch'))
      && error.errors.includes(cleanupError));
  });

  it.each(['return', 'throw'] as const)(
    'preserves iterator.%s failure when request-lease cleanup also fails',
    async (operation) => {
      const sourceError = new Error(`${operation} failed`);
      const cleanupError = new Error('request release failed');
      const release = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(cleanupError);
      const source = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false as const, value: new Uint8Array([1]) }),
          return: async () => { throw sourceError; },
          throw: async () => { throw sourceError; },
        }),
      };
      const runtime = new RscHostRuntime({
        locator: { resolve: async () => ({
          verificationKey: 'fixture.v1',
          client: {
            describe: async () => manifest(), render: async () => source,
            action: async () => undefined,
            serverFunction: async () => ({ type: 'null' as const }),
          },
          release,
        }) },
        decoder: { decode: async (flight) => {
          const iterator = flight[Symbol.asyncIterator]();
          if (operation === 'return') await iterator.return?.();
          else await iterator.throw?.(new Error('requested throw'));
          return null;
        } },
      });
      await expect(runtime.render({
        pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
      })).rejects.toSatisfy((error: unknown) =>
        error instanceof AggregateError
        && error.errors.includes(sourceError)
        && error.errors.includes(cleanupError));
    },
  );

  it('keeps the lease when an iterator handles throw and continues streaming', async () => {
    const release = vi.fn();
    let nextCalls = 0;
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => nextCalls++ === 0
          ? { done: false as const, value: new Uint8Array([2, 3]) }
          : { done: true as const, value: undefined },
        throw: async () => ({ done: false as const, value: new Uint8Array([1]) }),
      }),
    };
    const observe = vi.fn();
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({
        verificationKey: 'fixture.v1',
        client: {
          describe: async () => manifest(), render: async () => source,
          action: async () => undefined,
          serverFunction: async () => ({ type: 'null' as const }),
        },
        release,
      }) },
      decoder: { decode: async (flight) => {
        const iterator = flight[Symbol.asyncIterator]();
        const recovered = await iterator.throw?.(new Error('handled'));
        expect(recovered).toMatchObject({ done: false, value: new Uint8Array([1]) });
        expect(release).toHaveBeenCalledOnce();
        await iterator.next();
        await iterator.next();
        return null;
      } },
      observe,
    });
    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
    })).resolves.toBeNull();
    expect(release).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', bytes: 3 }));
  });

  it('keeps the lease when iterator.return yields cleanup data before completing', async () => {
    const release = vi.fn();
    let nextCalls = 0;
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => nextCalls++ === 0
          ? { done: false as const, value: new Uint8Array([2, 3]) }
          : { done: true as const, value: undefined },
        return: async () => ({ done: false as const, value: new Uint8Array([1]) }),
      }),
    };
    const observe = vi.fn();
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => ({
        verificationKey: 'fixture.v1',
        client: {
          describe: async () => manifest(), render: async () => source,
          action: async () => undefined,
          serverFunction: async () => ({ type: 'null' as const }),
        },
        release,
      }) },
      decoder: { decode: async (flight) => {
        const iterator = flight[Symbol.asyncIterator]();
        const cleanupChunk = await iterator.return?.();
        expect(cleanupChunk).toMatchObject({ done: false, value: new Uint8Array([1]) });
        expect(release).toHaveBeenCalledOnce();
        await iterator.next();
        await iterator.next();
        return null;
      } },
      observe,
    });
    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
    })).resolves.toBeNull();
    expect(release).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', bytes: 3 }));
  });

  it('does not share manifest verification across leases without an endpoint key', async () => {
    const descriptions = [
      vi.fn(async () => manifest()),
      vi.fn(async () => ({ ...manifest(), pluginId: 'org.hile.attacker' })),
    ];
    let resolves = 0;
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => {
        const current = Math.floor(resolves++ / 2);
        return {
          client: {
            describe: descriptions[current], render: async () => Readable.from([]),
            action: async () => undefined,
            serverFunction: async () => ({ type: 'null' as const }),
          },
          release: () => undefined,
        };
      } },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
    });
    await runtime.render({ pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' } });
    await expect(runtime.render({
      pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' },
    })).rejects.toThrow('identity mismatch');
    expect(descriptions[0]).toHaveBeenCalledOnce();
    expect(descriptions[1]).toHaveBeenCalledOnce();
  });

  it('rejects unsafe stream limits before resolving a plugin lease', async () => {
    const resolve = vi.fn();
    const runtime = new RscHostRuntime({
      locator: { resolve }, decoder: { decode: async () => null },
    });
    for (const options of [
      { timeout: Number.MAX_SAFE_INTEGER },
      { idleTimeout: Number.MAX_SAFE_INTEGER },
      { window: 65 },
    ]) {
      await expect(runtime.render({
        pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' }, ...options,
      })).rejects.toThrow();
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('re-verifies the same logical build when its concrete endpoint changes', async () => {
    const first = { ...manifest() };
    const second = { ...manifest() };
    const describe = [vi.fn(async () => first), vi.fn(async () => second)];
    let resolves = 0;
    const runtime = new RscHostRuntime({
      locator: { resolve: async () => {
        const current = Math.floor(resolves++ / 2);
        return {
          verificationKey: `namespace-${current}`,
          client: {
            describe: describe[current],
            render: async () => Readable.from([]),
            action: async () => undefined,
            serverFunction: async () => ({ type: 'null' as const }),
          },
          release: () => undefined,
        };
      } },
      decoder: { decode: async (source) => {
        for await (const _chunk of source) { /* consume */ }
        return null;
      } },
    });
    await runtime.render({ pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' } });
    await runtime.render({ pluginId: 'org.hile.fixture', request: { buildId: 'build-a', path: '/' } });
    expect(describe[0]).toHaveBeenCalledOnce();
    expect(describe[1]).toHaveBeenCalledOnce();
  });
});
