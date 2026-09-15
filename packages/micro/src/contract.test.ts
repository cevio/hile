import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, createInvocationContext, type InvocationContext } from '@hile/context';
import { createMicroClient, defineMicroContract } from '@hile/micro-contract';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Application, loadMicroContract } from './application';
import { defineMicroMessage } from './message';
import { Registry } from './registry';

const context = createExecutionContext({ requestId: 'contract-test', actor: 'reader' });
const invocation = () => createInvocationContext(context, new AbortController().signal);
const identitySchema: StandardSchemaV1<{ value: string }> = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => ({ value: value as { value: string } }),
  },
};
const stringSchema: StandardSchemaV1<string> = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => typeof value === 'string'
      ? { value: value.trim() }
      : { issues: [{ message: 'expected string' }] },
  },
};
const contract = defineMicroContract({
  namespace: 'test.contract',
  operations: {
    echo: { path: '/echo', input: stringSchema, output: stringSchema },
  },
});

// Test-only definitions let native Loader imports share the exact test objects.
const definitionsKey = Symbol.for('hile.micro.contract.test.definitions');
const definitions = new Map<string, unknown>();
Object.assign(globalThis, { [definitionsKey]: definitions });
const directories: string[] = [];
const cleanups: Array<() => Promise<unknown> | void> = [];

async function files(entries: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'hile-contract-'));
  directories.push(directory);
  for (const [name, definition] of Object.entries(entries)) {
    const key = randomUUID();
    definitions.set(key, definition);
    const filename = join(directory, name);
    await mkdir(join(filename, '..'), { recursive: true });
    await writeFile(filename,
      `export default globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(definitionsKey))})].get(${JSON.stringify(key)});\n`);
  }
  return directory;
}

function application(shutdownTimeoutMs = 1_000, registryPort = 9876) {
  return new Application({
    namespace: contract.namespace,
    registry: { host: '127.0.0.1', port: registryPort },
    advertiseHost: '127.0.0.1',
    shutdownTimeoutMs,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function freePort() {
  const server = createServer();
  // Match Server.listen's dual-stack bind rather than only checking IPv4.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('No test port');
  return address.port;
}

async function listen(server: Application | Registry): Promise<number> {
  // Releasing a probe cannot reserve its port. Retry only this test allocation
  // race; actual Registry, contract, and transport failures must still fail.
  for (let attempt = 0; ; attempt++) {
    const port = await freePort();
    try {
      cleanups.push(await server.listen(port));
      return port;
    } catch (error) {
      if (attempt >= 9 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  definitions.clear();
});

describe('file-loaded Micro contracts', () => {
  it('lets untyped file messages inherit the safe required catch-all route', async () => {
    const app = application()
    const unload = await app.load(await files({
      'events/[...paths].msg.mjs': defineMicroMessage(({ params }) => params.paths),
    }))
    expect(await app.dispatch('/events/one/two', {})).toBe('one/two')
    await expect(app.dispatch('/events', {})).rejects.toThrow()
    unload()
    await expect(app.dispatch('/events/one/two', {})).rejects.toThrow()
  })

  it('rejects catch-all files for typed fixed-path Micro operations with file context', async () => {
    const directory = await files({
      '[...paths].msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => data),
    })
    await expect(loadMicroContract(application(), contract, directory))
      .rejects.toThrow(/\[\.\.\.paths\]\.msg\.mjs.*fixed file route/)
  })

  it('requires successful loading and activation before local or URL invocation', async () => {
    const handler = vi.fn(({ data, invocation: call }) => {
      expect(call.context.values.actor).toBe('reader');
      return data;
    });
    const app = application();
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, handler),
    }));
    cleanups.push(() => binding.close());
    await expect(binding.local.echo(' value ', invocation())).rejects.toMatchObject({ status: 'HILE_MICRO_UNAVAILABLE' });
    await expect(app.dispatch('/echo', ' value ', { invocation: invocation() }))
      .rejects.toMatchObject({ status: 'HILE_MICRO_UNAVAILABLE' });
    expect(handler).not.toHaveBeenCalled();
    binding.activate();
    binding.activate();
    await expect(binding.local.echo(' value ', invocation())).resolves.toBe('value');
    await expect(app.dispatch('/echo', ' value ', { invocation: invocation() })).resolves.toBe('value');
    expect(handler).toHaveBeenCalledTimes(2);
    await binding.close();
    await expect(binding.local.echo('value', invocation())).rejects.toMatchObject({ status: 'HILE_MICRO_UNAVAILABLE' });
    expect(() => binding.activate()).toThrow();
  });

  it('rejects mismatched paths, missing files, raw substitutes, and foreign contracts', async () => {
    const handler = vi.fn(({ data }) => data);
    for (const entries of [
      { 'wrong.msg.mjs': defineMicroMessage(contract.operations.echo, handler) },
      {},
      { 'echo.msg.mjs': defineMicroMessage(handler) },
    ]) {
      await expect(loadMicroContract(application(), contract, await files(entries))).rejects.toThrow();
    }
    const foreign = defineMicroContract({ namespace: 'test.foreign', operations: contract.operations });
    await expect(loadMicroContract(application(), contract, await files({
      'echo.msg.mjs': defineMicroMessage(foreign.operations.echo, handler),
    }))).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rolls back a loaded directory exactly once when contract completeness fails', async () => {
    const app = application();
    const unload = vi.fn();
    vi.spyOn(app, 'load').mockResolvedValue(unload);

    await expect(loadMicroContract(app, contract, 'unused-by-test')).rejects.toThrow('Missing Micro operation');
    expect(unload).toHaveBeenCalledOnce();
  });

  it('never opens local admission when an inactive binding starts closing', async () => {
    const handler = vi.fn(({ data }) => data);
    const binding = await loadMicroContract(application(), contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, handler),
    }));
    const closing = binding.close();
    await expect(binding.local.echo('never activated', invocation()))
      .rejects.toMatchObject({ status: 'HILE_MICRO_UNAVAILABLE' });
    await closing;
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects typed definitions loaded without a contract and concurrent contract initialization', async () => {
    const directory = await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => data),
    });
    await expect(application().load(directory)).rejects.toThrow();
    const app = application();
    const first = loadMicroContract(app, contract, directory);
    await expect(loadMicroContract(app, contract, directory)).rejects.toThrow();
    const binding = await first;
    cleanups.push(() => binding.close());
  });

  it.each(['namespace', 'identity'])('fails closed even when the initial %s check rejects before loading files', async (kind) => {
    const app = application();
    const handler = vi.fn(() => 'must not execute');
    cleanups.push(app.register('/raw', handler));
    const invalid = kind === 'namespace'
      ? defineMicroContract({ namespace: 'other.service', operations: contract.operations })
      : { ...contract };
    const directory = await files({});
    await expect(loadMicroContract(app, invalid, directory)).rejects.toThrow();
    await expect(app.dispatch('/raw', {}, { invocation: invocation() }))
      .rejects.toMatchObject({ status: 'HILE_MICRO_UNAVAILABLE' });
    await expect(loadMicroContract(app, contract, directory)).rejects.toThrow('only one');
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses the loader final index/group/prefix path without overriding the contract', async () => {
    const grouped = defineMicroContract({
      namespace: contract.namespace,
      operations: { echo: { ...contract.operations.echo, path: '/prefix/echo' } },
    });
    const app = new Application({
      namespace: contract.namespace,
      registry: { host: '127.0.0.1', port: 9876 },
      advertiseHost: '127.0.0.1',
      prefix: '/prefix/',
    });
    const binding = await loadMicroContract(app, grouped, await files({
      '(group)/echo/index.msg.mjs': defineMicroMessage(grouped.operations.echo, ({ data }) => data),
    }));
    cleanups.push(() => binding.close());
    binding.activate();
    await expect(binding.local.echo('ok', invocation())).resolves.toBe('ok');
    await expect(app.dispatch('/prefix/echo', 'ok', { invocation: invocation() })).resolves.toBe('ok');
    await expect(app.dispatch('/echo', 'ok', { invocation: invocation() })).rejects.toThrow();
  });

  it('validates local requests and responses without leaking mutable input/output references', async () => {
    const sharedResponse = { value: 'original' };
    const echo = defineMicroContract({ namespace: contract.namespace, operations: {
      echo: { path: '/echo', input: identitySchema, output: identitySchema },
    } });
    const binding = await loadMicroContract(application(), echo, await files({
      'echo.msg.mjs': defineMicroMessage(echo.operations.echo, ({ data }) => {
        data.value = 'changed';
        return sharedResponse;
      }),
    }));
    cleanups.push(() => binding.close());
    binding.activate();
    const input = { value: 'input' };
    const output = await binding.local.echo(input, invocation());
    expect(input.value).toBe('input');
    output.value = 'consumer';
    expect(sharedResponse.value).toBe('original');
    await expect(binding.local.echo(new Date() as any, invocation()))
      .rejects.toMatchObject({ status: 'HILE_MICRO_INVALID_REQUEST', phase: 'provider_request' });
  });

  it('rejects unsupported local options and unary request streams before effects', async () => {
    const handler = vi.fn(({ data }) => data);
    const app = application();
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, handler),
    }));
    cleanups.push(() => binding.close());
    binding.activate();
    await expect(binding.local.echo('value', { ...invocation(), retries: 2 } as any)).rejects.toThrow();
    await expect(binding.local.echo('value', Object.defineProperty({ ...invocation() }, 'timeout', {
      value: 100,
      enumerable: false,
    }))).rejects.toThrow();
    const valid = invocation();
    const inherited = new Proxy({}, {
      get(_target, key) {
        if (key === 'context') return valid.context;
        if (key === 'signal') return valid.signal;
        return undefined;
      },
    });
    await expect(binding.local.echo('value', inherited as InvocationContext)).rejects.toThrow();
    const input = Readable.from(['chunk']);
    await expect(app.dispatch('/echo', 'value', { invocation: invocation(), input })).rejects.toThrow();
    expect(input.destroyed).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('checks cancellation again between asynchronous validation and handler entry', async () => {
    const controller = new AbortController();
    const cancelContract = defineMicroContract({
      namespace: contract.namespace,
      operations: {
        echo: {
          path: '/echo',
          input: {
            '~standard': {
              ...stringSchema['~standard'],
              validate(value: unknown) {
                queueMicrotask(() => queueMicrotask(() => controller.abort(new Error('cancel before effect'))));
                return { value: value as string };
              },
            },
          },
          output: stringSchema,
        },
      },
    });
    const handler = vi.fn(({ data }) => data);
    const binding = await loadMicroContract(application(), cancelContract, await files({
      'echo.msg.mjs': defineMicroMessage(cancelContract.operations.echo, handler),
    }));
    cleanups.push(() => binding.close());
    binding.activate();
    await expect(binding.local.echo('value', createInvocationContext(context, controller.signal)))
      .rejects.toThrow('cancel before effect');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not deliver a local response cancelled after output validation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before local response delivery');
    const cancelContract = defineMicroContract({
      namespace: contract.namespace,
      operations: {
        echo: {
          path: '/echo',
          input: stringSchema,
          output: {
            '~standard': {
              ...stringSchema['~standard'],
              validate(value: unknown) {
                queueMicrotask(() => queueMicrotask(() => controller.abort(reason)));
                return { value: value as string };
              },
            },
          },
        },
      },
    });
    const binding = await loadMicroContract(application(), cancelContract, await files({
      'echo.msg.mjs': defineMicroMessage(cancelContract.operations.echo, ({ data }) => data),
    }));
    cleanups.push(() => binding.close());
    binding.activate();
    await expect(binding.local.echo('value', createInvocationContext(context, controller.signal)))
      .rejects.toBe(reason);
  });

  it('drains an admitted outer adapter across two sequential local calls', async () => {
    const between = deferred();
    const continueOuter = deferred();
    const app = application();
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => data),
    }));
    cleanups.push(() => binding.close());
    const unregister = app.register<unknown, { invocation: InvocationContext }>('/adapter', async ({ invocation: call }) => {
      await binding.local.echo('first', call);
      between.resolve();
      await continueOuter.promise;
      return binding.local.echo('second', call);
    });
    cleanups.push(unregister);
    binding.activate();
    const outer = app.dispatch('/adapter', {}, { invocation: invocation() });
    await between.promise;
    const closing = binding.close();
    await expect(app.dispatch('/adapter', {}, { invocation: invocation() }))
      .rejects.toMatchObject({ status: 'HILE_MICRO_UNAVAILABLE' });
    continueOuter.resolve();
    await expect(outer).resolves.toBe('second');
    await closing;
    await expect(binding.local.echo('late', invocation())).rejects.toThrow();
  });

  it('keeps stream ingress admitted until consumption and bounds shutdown cancellation', async () => {
    const app = application(30);
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => data),
    }));
    cleanups.push(() => binding.close());
    let signal: AbortSignal | undefined;
    const unregister = app.register<unknown, { invocation: InvocationContext }>('/stream', async function* ({ invocation: call }) {
      signal = call.signal;
      yield await binding.local.echo('one', call);
      await new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    cleanups.push(unregister);
    binding.activate();
    const stream = await app.dispatch('/stream', {}, { invocation: invocation() });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: 'one' });
    await binding.close();
    expect(signal?.aborted).toBe(true);
    await iterator.return?.();
  });

  it.each(['throw', 'return'] as const)('tracks a stream that yields while handling iterator.%s()', async (method) => {
    const app = application(30);
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => data),
    }));
    cleanups.push(() => binding.close());
    let signal: AbortSignal | undefined;
    cleanups.push(app.register<unknown, { invocation: InvocationContext }>('/stream', async function* ({ invocation: call }) {
      signal = call.signal;
      try {
        yield 'first';
      } catch {
        yield 'caught';
      } finally {
        yield 'cleanup';
      }
    }));
    binding.activate();
    const stream = await app.dispatch('/stream', {}, { invocation: invocation() });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const result = method === 'throw'
      ? await iterator.throw(new Error('test'))
      : await iterator.return();
    expect(result.done).toBe(false);
    await binding.close();
    expect(signal?.aborted).toBe(true);
    await expect(iterator.next()).rejects.toThrow();
  });

  it('waits for cooperative stream cleanup after caller cancellation before unloading', async () => {
    const app = application();
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => data),
    }));
    cleanups.push(() => binding.close());
    const cleanupStarted = deferred();
    const finishCleanup = deferred();
    let cleanupDone = false;
    cleanups.push(app.register('/stream', async function* () {
      try {
        yield 'first';
      } finally {
        cleanupStarted.resolve();
        await finishCleanup.promise;
        cleanupDone = true;
      }
    }));
    binding.activate();
    const controller = new AbortController();
    const stream = await app.dispatch('/stream', {}, {
      invocation: createInvocationContext(context, controller.signal),
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await cleanupStarted.promise;
    let closed = false;
    const closing = binding.close().then(() => { closed = true; });
    await expect(iterator.next()).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    finishCleanup.resolve();
    await closing;
    expect(cleanupDone).toBe(true);
  });

  it('drains cleanup yields after stream cancellation without consuming the shutdown deadline', async () => {
    const app = application(1_000);
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => data),
    }));
    cleanups.push(() => binding.close());
    let cleanupDone = false;
    cleanups.push(app.register<unknown, { invocation: InvocationContext }>('/stream', async function* () {
      try {
        yield 'first';
      } finally {
        yield 'cleanup';
        cleanupDone = true;
      }
    }));
    binding.activate();
    const controller = new AbortController();
    const stream = await app.dispatch('/stream', {}, {
      invocation: createInvocationContext(context, controller.signal),
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    vi.useFakeTimers();
    let closing: Promise<void> | undefined;
    try {
      controller.abort();
      let closed = false;
      closing = binding.close().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupDone).toBe(true);
      expect(closed).toBe(true);
      await closing;
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      await closing;
    }
  });

  it('uses one idempotent shutdown deadline across outer and uncooperative local work', async () => {
    const app = application(100);
    const localStarted = deferred();
    const finishLocal = deferred();
    const finishOuter = deferred();
    let localSignal: AbortSignal | undefined;
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, async ({ data, invocation: call }) => {
        localSignal = call.signal;
        localStarted.resolve();
        await finishLocal.promise;
        return data;
      }),
    }));
    cleanups.push(() => binding.close());
    cleanups.push(app.register('/outer', async () => {
      await finishOuter.promise;
      return 'done';
    }));
    binding.activate();
    const local = binding.local.echo('pending', invocation());
    const localRejected = expect(local).rejects.toThrow();
    await localStarted.promise;
    const outer = app.dispatch('/outer', {}, { invocation: invocation() });
    vi.useFakeTimers();
    try {
      let closed = false;
      const closing = binding.close();
      expect(binding.close()).toBe(closing);
      void closing.then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(80);
      finishOuter.resolve();
      await outer;
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      await closing;
      expect(localSignal?.aborted).toBe(true);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
      finishOuter.resolve();
      finishLocal.resolve();
      await localRejected;
    }
  });

  it('uses the same validation over real RPC and never retries provider output failures', async () => {
    const registry = new Registry({ advertiseHost: '127.0.0.1' });
    const registryPort = await listen(registry);
    const app = application(1_000, registryPort);
    let executions = 0;
    const binding = await loadMicroContract(app, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => {
        executions++;
        return data === 'invalid' ? 123 as any : data;
      }),
    }));
    cleanups.push(() => binding.close());
    await listen(app);
    const consumer = new Application({
      namespace: 'test.consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      advertiseHost: '127.0.0.1',
      circuitBreaker: { shouldRetry: () => true },
    });
    await listen(consumer);
    const client = createMicroClient(consumer, contract);
    await expect(client.echo('ok', { context })).rejects.toMatchObject({ status: 'HILE_MICRO_UNAVAILABLE' });
    binding.activate();
    for (const path of ['/-/health', '/-/heartbeat']) {
      await expect(consumer.call(contract.namespace, path, {}, {
        context,
        protocol: 'http-over-micro.test',
        retries: 0,
      })).rejects.toMatchObject({ status: 'HILE_MESSAGE_PROTOCOL_MISMATCH' });
    }
    const invalidStream = await consumer.stream(contract.namespace, '/echo', 'ok', { context, retries: 0 });
    await expect((async () => { for await (const _chunk of invalidStream) { /* must reject */ } })())
      .rejects.toMatchObject({ status: 'HILE_MICRO_INVALID_REQUEST' });
    await expect(consumer.call(contract.namespace, '/echo', 'ok', {
      context,
      input: Readable.from(['chunk']),
      retries: 0,
    })).rejects.toMatchObject({ status: 'HILE_MICRO_INVALID_REQUEST' });
    await expect(client.echo(' ok ', { context })).resolves.toBe('ok');
    await expect(client.echo('invalid', { context, retries: 3 }))
      .rejects.toMatchObject({ status: 'HILE_MICRO_INVALID_RESPONSE', phase: 'provider_response' });
    expect(executions).toBe(2);
  });

  it('keeps request mistakes neutral and records schema/response failures without any retries', async () => {
    const inputSchema = {
      '~standard': {
        ...stringSchema['~standard'],
        validate(value: unknown) {
          if (value === 'invalid-request') return { issues: [{ message: 'private validation detail' }] };
          if (value === 'request-crash') throw new Error('private request exception');
          return { value: value as string };
        },
      },
    };
    const outputSchema = {
      '~standard': {
        ...stringSchema['~standard'],
        validate(value: unknown) {
          if (value === 'invalid-response') return { issues: [{ message: 'private response detail' }] };
          if (value === 'response-crash') throw new Error('private response exception');
          return { value: value as string };
        },
      },
    };
    const providerContract = defineMicroContract({
      namespace: contract.namespace,
      operations: {
        echo: { path: '/echo', input: inputSchema, output: outputSchema },
        compose: { path: '/compose', input: stringSchema, output: stringSchema },
      },
    });
    const registry = new Registry({ advertiseHost: '127.0.0.1' });
    const registryPort = await listen(registry);
    const provider = application(1_000, registryPort);
    const handler = vi.fn(({ data }) => data);
    let invokeNested!: (data: string, call: InvocationContext) => Promise<string>;
    const binding = await loadMicroContract(provider, providerContract, await files({
      'echo.msg.mjs': defineMicroMessage(providerContract.operations.echo, handler),
      'compose.msg.mjs': defineMicroMessage(providerContract.operations.compose, ({ data, invocation: call }) =>
        invokeNested(data, call)),
    }));
    invokeNested = binding.local.echo;
    cleanups.push(() => binding.close());
    await listen(provider);
    binding.activate();
    const shouldRetry = vi.fn(() => true);
    const shouldRecordFailure = vi.fn(() => true);
    const consumer = new Application({
      namespace: 'test.validation-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      advertiseHost: '127.0.0.1',
      circuitBreaker: { shouldRetry, shouldRecordFailure, failureThreshold: 20 },
    });
    await listen(consumer);
    for (const [data, status] of [
      ['invalid-request', 'HILE_MICRO_INVALID_REQUEST'],
      ['request-crash', 'HILE_MICRO_REQUEST_SCHEMA_FAILED'],
      ['invalid-response', 'HILE_MICRO_INVALID_RESPONSE'],
      ['response-crash', 'HILE_MICRO_RESPONSE_SCHEMA_FAILED'],
    ]) {
      await expect(consumer.call(contract.namespace, '/echo', data, { context, retries: 3 }))
        .rejects.toMatchObject({ status, message: 'Micro contract validation failed' });
    }
    expect(handler).toHaveBeenCalledTimes(2);
    expect(shouldRetry).not.toHaveBeenCalled();
    expect(shouldRecordFailure).toHaveBeenCalledTimes(3);
    await expect(consumer.call(contract.namespace, '/compose', 'invalid-response', { context, retries: 3 }))
      .rejects.toMatchObject({ status: 'HILE_MICRO_EXECUTION_FAILED', message: 'Micro operation failed' });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(shouldRetry).not.toHaveBeenCalled();
    expect(shouldRecordFailure).toHaveBeenCalledTimes(4);
  });

  it('cancels an undeliverable native stream after a unary RPC without leaving phantom work', async () => {
    const registry = new Registry({ advertiseHost: '127.0.0.1' });
    const registryPort = await listen(registry);
    const provider = application(1_000, registryPort);
    const binding = await loadMicroContract(provider, contract, await files({
      'echo.msg.mjs': defineMicroMessage(contract.operations.echo, ({ data }) => data),
    }));
    cleanups.push(() => binding.close());
    let streamSignal: AbortSignal | undefined;
    cleanups.push(provider.register<unknown, { invocation: InvocationContext }>('/native-stream', ({ invocation: call }) => {
      streamSignal = call.signal;
      return (async function* () { yield 'chunk'; })();
    }));
    await listen(provider);
    binding.activate();
    const consumer = new Application({
      namespace: 'test.stream-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      advertiseHost: '127.0.0.1',
    });
    await listen(consumer);
    await expect(consumer.call(contract.namespace, '/native-stream', {}, { context, retries: 0 }))
      .rejects.toThrow('Async iterable is not supported');
    expect(streamSignal?.aborted).toBe(true);
    await binding.close();
  });
});
