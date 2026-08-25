import { Server } from '@hile/micro';
import {
  createExecutionContext,
  MissingExecutionContextError,
  type InvocationContext,
} from '@hile/context';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RscPluginManifest } from '../protocol';
import {
  decodeRscServerFunctionValue,
  encodeRscServerFunctionValue,
} from '../server-functions/codec';
import { attachRscPluginService } from '../transport/registrar';
import { RscPluginService as BaseRscPluginService, RscPluginServiceError } from './service';

function testInvocation(value?: InvocationContext | AbortSignal): InvocationContext {
  if (value && 'context' in value) return value;
  return {
    context: createExecutionContext({ requestId: 'rsc-plugin-test' }),
    signal: value ?? new AbortController().signal,
  };
}

class RscPluginService extends BaseRscPluginService {
  public override render(value: unknown, invocation?: InvocationContext | AbortSignal) {
    return super.render(value, testInvocation(invocation));
  }

  public override action(value: unknown, invocation?: InvocationContext | AbortSignal) {
    return super.action(value, testInvocation(invocation));
  }

  public override serverFunction(value: unknown, invocation?: InvocationContext | AbortSignal) {
    return super.serverFunction(value, testInvocation(invocation));
  }
}

const temporaryModelDirectories: string[] = [];
const modelModule = new URL('../../../model/src/index.ts', import.meta.url).href;

afterEach(async () => {
  await Promise.all(temporaryModelDirectories.splice(0)
    .map((directory) => rm(directory, { recursive: true, force: true })));
});

async function modelDirectory(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hile-rsc-model-reload-'));
  temporaryModelDirectories.push(directory);
  await mkdir(path.join(directory, 'counter'), { recursive: true });
  await writeFile(path.join(directory, 'counter/read.model.mjs'), source);
  return directory;
}

function manifest(): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'com.example.plugin',
    buildId: 'build-1',
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: {
      entry: 'server-rsc/index.js',
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
    serverFunctions: [{
      id: 'com.example.plugin/build-1/src/actions#save',
      module: 'server-functions/actions.js',
      exportName: 'save',
      integrity: 'sha256-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
    }],
    clients: [{
      id: 'com.example.plugin/src/counter#default',
      module: 'client-browser/counter.js',
      ssrModule: 'client-ssr/counter.js',
      exportName: 'default',
      chunks: [],
      ssrChunks: [],
      integrity: 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      ssrIntegrity: 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
    }],
    styles: [],
    routes: [{ path: '/dashboard', entry: 'default' }],
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function expectServiceError(fn: () => unknown, code: string) {
  try {
    fn();
    expect.unreachable('expected RscPluginServiceError');
  } catch (error) {
    expect(error).toBeInstanceOf(RscPluginServiceError);
    expect(error).toMatchObject({ code });
  }
}

describe('RscPluginService', () => {
  const modelsDirectory = fileURLToPath(new URL('../../test-fixtures/models', import.meta.url));
  it('fails directly with a stable error when invocation context is missing', () => {
    const service = new BaseRscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
    });

    expect(() => service.render({ buildId: 'build-1', path: '/dashboard' }, undefined as never))
      .toThrow(MissingExecutionContextError);
  });

  it('returns a defensive manifest snapshot', () => {
    const original = manifest();
    const service = new RscPluginService({
      manifest: original,
      renderer: async function* () {},
    });

    const first = service.describe();
    first.routes[0].path = '/mutated';
    original.routes[0].path = '/also-mutated';

    expect(service.describe().routes[0].path).toBe('/dashboard');
  });

  it('atomically activates a compatible RSC revision while in-flight renders keep their snapshot', async () => {
    const release = deferred<void>();
    const firstRenderer = vi.fn(async function* () {
      yield Buffer.from('old-');
      await release.promise;
      yield Buffer.from('revision');
    });
    const service = new RscPluginService({ manifest: manifest(), renderer: firstRenderer });
    const oldRender = collect(service.render({ buildId: 'build-1', path: '/dashboard' }));
    await vi.waitFor(() => expect(firstRenderer).toHaveBeenCalledOnce());
    const next = manifest();
    next.buildId = 'build-2';
    const nextRenderer = vi.fn(async function* () { yield Buffer.from('new-revision'); });

    service.activate({ manifest: next, renderer: nextRenderer });
    release.resolve();

    await expect(oldRender).resolves.toEqual(Buffer.from('old-revision'));
    await expect(collect(service.render({ buildId: 'build-2', path: '/dashboard' })))
      .resolves.toEqual(Buffer.from('new-revision'));
    await expect(collect(service.render({ buildId: 'build-1', path: '/dashboard' })))
      .resolves.toEqual(Buffer.from('old-revision'));
  });

  it('bounds revision hand-off retention and evicts the oldest immutable build', async () => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () { yield Buffer.from('one'); },
      retainedRevisions: 2,
    });
    const second = manifest();
    second.buildId = 'build-2';
    service.activate({ manifest: second, renderer: async function* () { yield Buffer.from('two'); } });
    const third = manifest();
    third.buildId = 'build-3';
    service.activate({ manifest: third, renderer: async function* () { yield Buffer.from('three'); } });

    expectServiceError(() => service.render({ buildId: 'build-1', path: '/dashboard' }), 'ERR_RSC_BUILD_MISMATCH');
    await expect(collect(service.render({ buildId: 'build-2', path: '/dashboard' })))
      .resolves.toEqual(Buffer.from('two'));
  });

  it('rejects activation for another plugin or runtime', () => {
    const service = new RscPluginService({ manifest: manifest(), renderer: async function* () {} });
    const otherPlugin = manifest();
    otherPlugin.pluginId = 'other';
    const otherRuntime = manifest();
    otherRuntime.runtime.react = '20.0.0';

    expect(() => service.activate({ manifest: otherPlugin, renderer: async function* () {} }))
      .toThrow('pluginId');
    expect(() => service.activate({ manifest: otherRuntime, renderer: async function* () {} }))
      .toThrow('runtime');
    expect(service.describe().buildId).toBe('build-1');
  });

  it('rejects replacing a renderer under the same immutable build id', () => {
    const service = new RscPluginService({ manifest: manifest(), renderer: async function* () {} });
    expect(() => service.activate({ manifest: manifest(), renderer: async function* () {} }))
      .toThrow('buildId');
  });

  it('renders ordered binary chunks with route and request context', async () => {
    const renderer = vi.fn(async function* ({ routeEntry, request, signal }) {
      expect(routeEntry).toBe('default');
      expect(request.params).toEqual({ tenant: 't1' });
      expect(signal.aborted).toBe(false);
      yield Buffer.from('flight-');
      yield new Uint8Array(Buffer.from('payload'));
    });
    const service = new RscPluginService({ manifest: manifest(), renderer });

    const output = await collect(service.render({
      buildId: 'build-1',
      path: '/dashboard',
      params: { tenant: 't1' },
    }));

    expect(output.toString()).toBe('flight-payload');
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('matches a parameterized route and merges the captured value into request params', async () => {
    const parameterizedManifest = manifest();
    parameterizedManifest.routes = [{ path: '/items/[itemId]', entry: 'itemDetail' }];
    const renderer = vi.fn(async function* ({ routeEntry, request }) {
      expect(routeEntry).toBe('itemDetail');
      expect(request.params).toEqual({ locale: 'zh-CN', itemId: 'item-42' });
      yield Buffer.from('item');
    });
    const service = new RscPluginService({ manifest: parameterizedManifest, renderer });

    await expect(collect(service.render({
      buildId: 'build-1',
      path: '/items/item-42',
      params: { locale: 'zh-CN' },
    }))).resolves.toEqual(Buffer.from('item'));
  });

  it('treats parameter syntax in a concrete path as a captured value, not an exact route', async () => {
    const parameterizedManifest = manifest();
    parameterizedManifest.routes = [{ path: '/items/[itemId]', entry: 'itemDetail' }];
    const renderer = vi.fn(async function* ({ request }) {
      expect(request.params).toEqual({ itemId: '[itemId]' });
      yield Buffer.from('literal-parameter');
    });
    const service = new RscPluginService({ manifest: parameterizedManifest, renderer });

    await expect(collect(service.render({
      buildId: 'build-1',
      path: '/items/[itemId]',
    }))).resolves.toEqual(Buffer.from('literal-parameter'));
  });

  it('does not capture an empty path segment', () => {
    const parameterizedManifest = manifest();
    parameterizedManifest.routes = [{ path: '/items/[itemId]', entry: 'itemDetail' }];
    const renderer = vi.fn(async function* () {});
    const service = new RscPluginService({ manifest: parameterizedManifest, renderer });

    expectServiceError(() => service.render({
      buildId: 'build-1',
      path: '/items/',
    }), 'ERR_RSC_ROUTE_NOT_FOUND');
    expect(renderer).not.toHaveBeenCalled();
  });

  it('prefers an exact route over a parameterized route', async () => {
    const routedManifest = manifest();
    routedManifest.routes = [
      { path: '/items/[itemId]', entry: 'itemDetail' },
      { path: '/items/new', entry: 'newItem' },
    ];
    const renderer = vi.fn(async function* ({ routeEntry, request }) {
      expect(routeEntry).toBe('newItem');
      expect(request.params).toEqual({});
      yield Buffer.from('new');
    });
    const service = new RscPluginService({ manifest: routedManifest, renderer });

    await expect(collect(service.render({ buildId: 'build-1', path: '/items/new' })))
      .resolves.toEqual(Buffer.from('new'));
  });

  it('prefers the parameterized route with more static segments', async () => {
    const routedManifest = manifest();
    routedManifest.routes = [
      { path: '/[collection]/[itemId]', entry: 'collectionItem' },
      { path: '/items/[itemId]', entry: 'itemDetail' },
    ];
    const renderer = vi.fn(async function* ({ routeEntry, request }) {
      expect(routeEntry).toBe('itemDetail');
      expect(request.params).toEqual({ itemId: 'item-42' });
      yield Buffer.from('specific');
    });
    const service = new RscPluginService({ manifest: routedManifest, renderer });

    await expect(collect(service.render({ buildId: 'build-1', path: '/items/item-42' })))
      .resolves.toEqual(Buffer.from('specific'));
  });

  it('rejects a captured route parameter that conflicts with caller params', () => {
    const parameterizedManifest = manifest();
    parameterizedManifest.routes = [{ path: '/items/[itemId]', entry: 'itemDetail' }];
    const renderer = vi.fn(async function* () {});
    const service = new RscPluginService({ manifest: parameterizedManifest, renderer });

    expectServiceError(() => service.render({
      buildId: 'build-1',
      path: '/items/item-42',
      params: { itemId: 'caller-value' },
    }), 'ERR_RSC_INVALID_REQUEST');
    expect(renderer).not.toHaveBeenCalled();
  });

  it('fails closed if an unvalidated manifest contains ambiguous parameterized routes', () => {
    const ambiguousManifest = manifest();
    ambiguousManifest.routes = [
      { path: '/items/[itemId]', entry: 'itemById' },
      { path: '/items/[slug]', entry: 'itemBySlug' },
    ];
    const renderer = vi.fn(async function* () {});
    const service = new RscPluginService({ manifest: ambiguousManifest, renderer });

    expectServiceError(() => service.render({
      buildId: 'build-1',
      path: '/items/item-42',
    }), 'ERR_RSC_INVALID_REQUEST');
    expect(renderer).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { buildId: '', path: '/dashboard' },
    { buildId: 'build-1', path: 'dashboard' },
  ])('rejects malformed render request %j', (request) => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
    });
    expectServiceError(() => service.render(request), 'ERR_RSC_INVALID_REQUEST');
  });

  it('rejects a request pinned to another build', () => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
    });
    expectServiceError(() => service.render({
      buildId: 'build-2',
      path: '/dashboard',
    }), 'ERR_RSC_BUILD_MISMATCH');
  });

  it('rejects an unknown route without invoking renderer', () => {
    const renderer = vi.fn(async function* () {});
    const service = new RscPluginService({ manifest: manifest(), renderer });
    expectServiceError(() => service.render({
      buildId: 'build-1',
      path: '/unknown',
    }), 'ERR_RSC_ROUTE_NOT_FOUND');
    expect(renderer).not.toHaveBeenCalled();
  });

  it('rejects a renderer that yields non-binary chunks and still drains state', async () => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () { yield 'not-binary' as any; },
    });

    await expect(collect(service.render({ buildId: 'build-1', path: '/dashboard' })))
      .rejects.toThrow('Uint8Array');
    await expect(service.drain()).resolves.toBeUndefined();
  });

  it('propagates a remote AbortSignal into a render and stops later chunks', async () => {
    const aborted = deferred<void>();
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* ({ signal }) {
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        yield Buffer.from('first');
        await aborted.promise;
        yield Buffer.from('late');
      },
    });
    const controller = new AbortController();
    const chunks: Buffer[] = [];
    for await (const chunk of service.render(
      { buildId: 'build-1', path: '/dashboard' },
      controller.signal,
    )) {
      chunks.push(Buffer.from(chunk));
      controller.abort();
    }

    await aborted.promise;
    expect(chunks.map(String)).toEqual(['first']);
  });

  it('terminates an in-flight render with the shutdown reason when the plugin deactivates', async () => {
    const continueRender = deferred<void>();
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {
        yield Buffer.from('first');
        await continueRender.promise;
        yield Buffer.from('late');
      },
    });
    const iterator = service.render({ buildId: 'build-1', path: '/dashboard' })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    service.deactivate();
    continueRender.resolve();

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'ERR_RSC_PLUGIN_INACTIVE',
    });
    await expect(service.drain()).resolves.toBeUndefined();
  });

  it('does not turn a shutdown-aware renderer return into graceful EOF', async () => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* ({ signal }) {
        yield Buffer.from('first');
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
            once: true,
          }));
        }
        return;
      },
    });
    const iterator = service.render({ buildId: 'build-1', path: '/dashboard' })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    service.deactivate();

    await expect(iterator.next()).rejects.toMatchObject({
      code: 'ERR_RSC_PLUGIN_INACTIVE',
    });
    await expect(service.drain()).resolves.toBeUndefined();
  });

  it('releases in-flight state when a consumer breaks early', async () => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {
        yield Buffer.from('first');
        yield Buffer.from('second');
      },
    });

    for await (const _chunk of service.render({ buildId: 'build-1', path: '/dashboard' })) break;

    await expect(service.drain()).resolves.toBeUndefined();
  });

  it('does not count a render iterable as in-flight until consumption starts', async () => {
    const renderer = vi.fn(async function* () { yield Buffer.from('unused'); });
    const service = new RscPluginService({ manifest: manifest(), renderer });

    service.render({ buildId: 'build-1', path: '/dashboard' });
    service.deactivate();

    await expect(service.drain()).resolves.toBeUndefined();
    expect(renderer).not.toHaveBeenCalled();
  });

  it('executes only allowlisted actions with build pin and signal', async () => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
    });
    await service.load(modelsDirectory);

    await expect(service.action({
      buildId: 'build-1',
      actionId: 'save',
      input: { id: 1 },
    })).resolves.toEqual({ saved: { id: 1 }, aborted: false });
    await expect(service.action({ buildId: 'build-1', actionId: 'internal', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_RSC_ACTION_NOT_FOUND' });
  });

  it('executes an allowlisted build-pinned server function through the loaded Model registry', async () => {
    const runtime = {
      invoke: vi.fn(async ({ args, invokeModel }: {
        args: unknown[];
        invokeModel: (id: string, input: unknown) => Promise<unknown>;
      }) => invokeModel('save', { id: args[0] })),
    };
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
      serverFunctions: runtime,
    });
    await service.load(modelsDirectory);

    const response = await service.serverFunction({
      buildId: 'build-1',
      referenceId: 'com.example.plugin/build-1/src/actions#save',
      args: await encodeRscServerFunctionValue([7]),
    });

    await expect(decodeRscServerFunctionValue(response)).resolves.toEqual({
      saved: { id: 7 },
      aborted: false,
    });
    expect(runtime.invoke).toHaveBeenCalledOnce();
  });

  it('rejects malformed, unknown, and wrong-build server function calls before execution', async () => {
    const runtime = { invoke: vi.fn() };
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
      serverFunctions: runtime,
    });
    const args = await encodeRscServerFunctionValue([]);

    await expect(service.serverFunction({
      buildId: 'build-2',
      referenceId: 'com.example.plugin/build-1/src/actions#save',
      args,
    })).rejects.toMatchObject({ code: 'ERR_RSC_BUILD_MISMATCH' });
    await expect(service.serverFunction({
      buildId: 'build-1',
      referenceId: 'com.example.plugin/build-1/src/actions#missing',
      args,
    })).rejects.toMatchObject({ code: 'ERR_RSC_SERVER_FUNCTION_NOT_FOUND' });
    await expect(service.serverFunction({
      buildId: 'build-1', referenceId: '', args,
    })).rejects.toMatchObject({ code: 'ERR_RSC_INVALID_REQUEST' });
    expect(runtime.invoke).not.toHaveBeenCalled();
  });

  it('pins server function execution to the immutable revision runtime during upgrades', async () => {
    const firstRuntime = { invoke: vi.fn(async () => 'first') };
    const service = new RscPluginService({
      manifest: manifest(), renderer: async function* () {}, serverFunctions: firstRuntime,
    });
    const next = manifest();
    next.buildId = 'build-2';
    next.serverFunctions[0] = {
      ...next.serverFunctions[0],
      id: 'com.example.plugin/build-2/src/actions#save',
    };
    const secondRuntime = { invoke: vi.fn(async () => 'second') };
    service.activate({
      manifest: next, renderer: async function* () {}, serverFunctions: secondRuntime,
    });

    const oldResult = await service.serverFunction({
      buildId: 'build-1',
      referenceId: 'com.example.plugin/build-1/src/actions#save',
      args: await encodeRscServerFunctionValue([]),
    });
    const newResult = await service.serverFunction({
      buildId: 'build-2',
      referenceId: 'com.example.plugin/build-2/src/actions#save',
      args: await encodeRscServerFunctionValue([]),
    });

    await expect(decodeRscServerFunctionValue(oldResult)).resolves.toBe('first');
    await expect(decodeRscServerFunctionValue(newResult)).resolves.toBe('second');
    expect(firstRuntime.invoke).toHaveBeenCalledOnce();
    expect(secondRuntime.invoke).toHaveBeenCalledOnce();
  });

  it('does not execute a server function after shutdown wins the async decode race', async () => {
    const runtime = { invoke: vi.fn(async () => 'late') };
    const service = new RscPluginService({
      manifest: manifest(), renderer: async function* () {}, serverFunctions: runtime,
    });
    const invocation = service.serverFunction({
      buildId: 'build-1',
      referenceId: 'com.example.plugin/build-1/src/actions#save',
      args: await encodeRscServerFunctionValue([1]),
    });
    service.deactivate();

    await expect(invocation).rejects.toBeDefined();
    expect(runtime.invoke).not.toHaveBeenCalled();
    await expect(service.drain()).resolves.toBeUndefined();
  });

  it('rejects unknown, malformed, and wrong-build actions', async () => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
    });
    await service.load(modelsDirectory);

    await expect(new RscPluginService({ manifest: manifest(), renderer: async function* () {} })
      .action({ buildId: 'build-1', actionId: 'other', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_RSC_ACTION_NOT_FOUND' });
    await expect(service.action({ buildId: 'build-2', actionId: 'save', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_RSC_BUILD_MISMATCH' });
    await expect(service.action({ buildId: 'build-1', actionId: 'save', input: null }))
      .rejects.toMatchObject({ code: 'ERR_RSC_INVALID_REQUEST' });
  });

  it('owns model loader lifecycle and rejects loading after deactivation', async () => {
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
    });
    const unload = await service.load(modelsDirectory);
    await expect(service.action({ buildId: 'build-1', actionId: 'ping', input: {} }))
      .resolves.toBe('pong');
    unload();
    unload();
    await expect(service.action({ buildId: 'build-1', actionId: 'ping', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_RSC_ACTION_NOT_FOUND' });

    service.deactivate();
    await expect(service.load(modelsDirectory)).rejects.toMatchObject({
      code: 'ERR_RSC_PLUGIN_INACTIVE',
    });
  });

  it('atomically replaces the model snapshot and ignores stale unload handles', async () => {
    const directory = await modelDirectory(`
      import { defineActionModel } from ${JSON.stringify(modelModule)};
      export default defineActionModel(async () => ({ version: 1 }));
    `);
    const service = new RscPluginService({ manifest: manifest(), renderer: async function* () {} });
    const unloadFirst = await service.load(directory, { cacheBust: 1 });
    await writeFile(path.join(directory, 'counter/read.model.mjs'), `
      import { defineActionModel } from ${JSON.stringify(modelModule)};
      export default defineActionModel(async () => ({ version: 2 }));
    `);

    const unloadSecond = await service.load(directory, { cacheBust: 2 });
    unloadFirst();

    await expect(service.action({ buildId: 'build-1', actionId: 'counter/read', input: {} }))
      .resolves.toEqual({ version: 2 });
    unloadSecond();
    await expect(service.action({ buildId: 'build-1', actionId: 'counter/read', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_RSC_ACTION_NOT_FOUND' });
  });

  it('keeps the previous model snapshot when a hot reload is invalid', async () => {
    const directory = await modelDirectory(`
      import { defineActionModel } from ${JSON.stringify(modelModule)};
      export default defineActionModel(async () => ({ stable: true }));
    `);
    const service = new RscPluginService({ manifest: manifest(), renderer: async function* () {} });
    await service.load(directory, { cacheBust: 1 });
    await writeFile(path.join(directory, 'counter/read.model.mjs'), 'export default { invalid: true };\n');

    await expect(service.load(directory, { cacheBust: 2 })).rejects.toMatchObject({
      code: 'ERR_MODEL_ACTION_INVALID_MODULE',
    });
    await expect(service.action({ buildId: 'build-1', actionId: 'counter/read', input: {} }))
      .resolves.toEqual({ stable: true });
  });

  it('attaches only internal message routes and creates no HTTP or WS listener', async () => {
    const server = new Server('com.example.plugin', { advertiseHost: '127.0.0.1' });
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () { yield Buffer.from('flight'); },
    });
    await service.load(modelsDirectory);

    attachRscPluginService(service, server);

    expect(server.port).toBeUndefined();
    await expect(server.dispatch('/-/rsc/describe', {})).resolves.toMatchObject({ buildId: 'build-1' });
    const stream = await server.dispatch('/-/rsc/render', { buildId: 'build-1', path: '/dashboard' }, {
      invocation: testInvocation(),
    });
    expect((await collect(stream)).toString()).toBe('flight');
    await expect(server.dispatch('/-/rsc/action', {
      buildId: 'build-1', actionId: 'ping', input: {},
    }, { invocation: testInvocation() })).resolves.toBe('pong');
  });

  it('prevents duplicate attachment and supports idempotent detach', async () => {
    const server = new Server('com.example.plugin', { advertiseHost: '127.0.0.1' });
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* () {},
    });

    const detach = attachRscPluginService(service, server);
    expect(() => attachRscPluginService(service, server)).toThrow('already attached');
    detach();
    detach();
    await expect(server.dispatch('/-/rsc/describe', {})).rejects.toMatchObject({ status: 'NOT_FOUND' });
  });

  it('deactivate aborts in-flight work, detaches routes, blocks new work, and drains', async () => {
    const started = deferred<AbortSignal>();
    const server = new Server('com.example.plugin', { advertiseHost: '127.0.0.1' });
    const service = new RscPluginService({
      manifest: manifest(),
      renderer: async function* ({ signal }) {
        started.resolve(signal);
        yield Buffer.from('first');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    });
    attachRscPluginService(service, server);
    const consume = collect(service.render({ buildId: 'build-1', path: '/dashboard' }));
    const signal = await started.promise;

    service.deactivate();
    await expect(consume).rejects.toMatchObject({ code: 'ERR_RSC_PLUGIN_INACTIVE' });
    await service.drain();

    expect(signal.aborted).toBe(true);
    expectServiceError(() => service.render({ buildId: 'build-1', path: '/dashboard' }), 'ERR_RSC_PLUGIN_INACTIVE');
    await expect(service.action({ buildId: 'build-1', actionId: 'none', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_RSC_PLUGIN_INACTIVE' });
    await expect(server.dispatch('/-/rsc/describe', {})).rejects.toMatchObject({ status: 'NOT_FOUND' });
  });

  it('notifies every deactivation listener even when one listener throws', () => {
    const service = new RscPluginService({ manifest: manifest(), renderer: async function* () {} });
    const called = vi.fn();
    service.onDeactivate(() => { throw new Error('listener failed'); });
    service.onDeactivate(called);

    expect(() => service.deactivate()).toThrow('listeners failed');
    expect(called).toHaveBeenCalledOnce();
    expect(() => service.render({ buildId: 'build-1', path: '/dashboard' })).toThrow('inactive');
  });
});
