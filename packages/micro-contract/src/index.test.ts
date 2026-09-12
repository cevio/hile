import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  createMicroClient,
  defineMicroContract,
  MICRO_CONTRACT_ERROR_STATUS,
  MicroContractError,
  type MicroCaller,
  type MicroClient,
} from './index.js';
import {
  assertMicroContract,
  getOperationMetadata,
  normalizeMicroCallOptions,
  snapshotMicroJson,
  validateMicroValue,
} from './internal.js';

const context = Object.freeze({ version: 1 as const, values: Object.freeze({ requestId: 'contract-test' }) });

function makeContract() {
  return defineMicroContract({
    namespace: 'test.contract',
    operations: {
      list: {
        path: '/items/list',
        input: z.strictObject({ limit: z.number().int().min(1).default(20) }),
        output: z.strictObject({ items: z.array(z.string()), next: z.string().nullable().default(null) }),
      },
    },
  });
}

describe('Micro contract definitions', () => {
  it('preserves schema inference and freezes only its own metadata', () => {
    const contract = makeContract();
    expectTypeOf<Parameters<MicroClient<typeof contract>['list']>[0]>()
      .toEqualTypeOf<{ limit?: number | undefined }>();
    expectTypeOf<Awaited<ReturnType<MicroClient<typeof contract>['list']>>>()
      .toEqualTypeOf<{ items: string[]; next: string | null }>();
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.operations)).toBe(true);
    expect(Object.isFrozen(contract.operations.list)).toBe(true);
    expect(Object.isFrozen(contract.operations.list.input)).toBe(false);
    expect(contract.operations.list.input.shape.limit).toBeDefined();
    const metadata = getOperationMetadata(contract.operations.list);
    expect(metadata).toEqual({ namespace: 'test.contract', key: 'list', path: '/items/list', contract });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(() => assertMicroContract(contract)).not.toThrow();
  });

  it('snapshots caller-owned descriptors while preserving schema identity', () => {
    const input = z.strictObject({});
    const descriptor = { path: '/one', input, output: input };
    const source = { namespace: 'service.one', operations: { one: descriptor } };
    const contract = defineMicroContract(source);
    descriptor.path = '/changed';
    source.namespace = 'changed';
    expect(contract.namespace).toBe('service.one');
    expect(contract.operations.one.path).toBe('/one');
    expect(contract.operations.one.input).toBe(input);
    expect(() => getOperationMetadata(descriptor)).toThrow(TypeError);
    expect(() => assertMicroContract({ ...contract })).toThrow(TypeError);
  });

  it.each(['', ' /one', 'one', '/one/', '/one//two', '/[id]', '/:id', '/a*', '/a?b', '/a#b', '/(a)', '/a{b}', '/a\\b'])
    ('rejects noncanonical or variable paths: %s', (path) => {
      expect(() => defineMicroContract({
        namespace: 'test.contract',
        operations: { test: { path, input: z.json(), output: z.json() } },
      })).toThrow(TypeError);
    });

  it.each(['then', 'toJSON', '__proto__', 'constructor', 'prototype', 'toString'])('rejects reserved operation key %s', (key) => {
    expect(() => defineMicroContract({
      namespace: 'test.contract',
      operations: { [key]: { path: '/one', input: z.json(), output: z.json() } },
    })).toThrow(TypeError);
  });

  it('rejects duplicate paths, empty declarations, and malformed schemas', () => {
    const operation = { path: '/one', input: z.json(), output: z.json() };
    expect(() => defineMicroContract({
      namespace: 'test.contract', operations: { a: operation, b: operation },
    })).toThrow(TypeError);
    expect(() => defineMicroContract({ namespace: 'test.contract', operations: {} })).toThrow(TypeError);
    expect(() => defineMicroContract({
      namespace: '', operations: { a: operation },
    })).toThrow(TypeError);
    expect(() => defineMicroContract({
      namespace: 'test.contract',
      operations: { a: { ...operation, input: {} as StandardSchemaV1 } },
    })).toThrow(TypeError);
  });
});

describe('validated Micro client', () => {
  it('uses stable paths, normalizes defaults, snapshots output and disables implicit retries', async () => {
    const contract = makeContract();
    const response = { items: ['one'] };
    const call = vi.fn<MicroCaller['call']>().mockResolvedValue(response);
    const client = createMicroClient({ call }, contract);
    const signal = new AbortController().signal;
    const result = await client.list({}, { context, signal, timeout: 500 });
    expect(call).toHaveBeenCalledWith('test.contract', '/items/list', { limit: 20 }, {
      context, signal, timeout: 500, retries: 0,
    });
    expect(call.mock.calls[0][3].context).toBe(context);
    expect(call.mock.calls[0][3].signal).toBe(signal);
    expect(result).toEqual({ items: ['one'], next: null });
    result.items.push('changed');
    expect(response.items).toEqual(['one']);
    expect(Object.getPrototypeOf(client)).toBe(Object.prototype);
    expect(Object.isFrozen(client)).toBe(true);
  });

  it('preserves structural caller receivers and explicit retry choices', async () => {
    const caller = {
      result: { items: [] },
      async call() { return this.result; },
    };
    const client = createMicroClient(caller, makeContract());
    await expect(client.list({}, { context, retries: 2 })).resolves.toEqual({ items: [], next: null });
  });

  it('rejects input before transport and rejects invalid responses without replay', async () => {
    const call = vi.fn<MicroCaller['call']>().mockResolvedValue({ items: [123] });
    const client = createMicroClient({ call }, makeContract());
    await expect(client.list({ limit: 0 }, { context })).rejects.toMatchObject({ phase: 'client_request' });
    expect(call).not.toHaveBeenCalled();
    await expect(client.list({}, { context })).rejects.toMatchObject({ phase: 'client_response' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HILE_MICRO_INVALID_REQUEST', 'provider_request', 'validation'],
    ['HILE_MICRO_REQUEST_SCHEMA_FAILED', 'provider_request', 'schema'],
    ['HILE_MICRO_INVALID_RESPONSE', 'provider_response', 'validation'],
    ['HILE_MICRO_RESPONSE_SCHEMA_FAILED', 'provider_response', 'schema'],
  ])('recovers only finite remote status semantics: %s', async (status, phase, kind) => {
    const remote = Object.assign(new Error('secret database credential'), { status, cause: 'private detail' });
    const client = createMicroClient({ call: vi.fn().mockRejectedValue(remote) }, makeContract());
    const failure = await client.list({}, { context }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MicroContractError);
    expect(failure).toMatchObject({ status, phase, kind, namespace: 'test.contract', operation: 'list' });
    expect(String(failure)).not.toContain('secret');
    expect((failure as Error).cause).toBeUndefined();
  });

  it('does not reinterpret unknown transport errors or stable domain outcomes', async () => {
    const failure = Object.assign(new Error('transport failed'), { status: 'ECONNRESET' });
    const client = createMicroClient({ call: vi.fn().mockRejectedValue(failure) }, makeContract());
    await expect(client.list({}, { context })).rejects.toBe(failure);
    const contract = defineMicroContract({ namespace: 'test.domain', operations: {
      write: {
        path: '/write', input: z.strictObject({}),
        output: z.union([z.strictObject({ outcome: z.literal('ok') }), z.strictObject({ outcome: z.literal('conflict') })]),
      },
    } });
    const domain = createMicroClient({ call: vi.fn().mockResolvedValue({ outcome: 'conflict' }) }, contract);
    await expect(domain.write({}, { context })).resolves.toEqual({ outcome: 'conflict' });
  });

  it('does not execute arbitrary transport error accessors', async () => {
    const getter = vi.fn(() => { throw new Error('unexpected getter'); });
    const failure = Object.defineProperty(new Error('unknown'), 'status', { get: getter });
    const client = createMicroClient({ call: vi.fn().mockRejectedValue(failure) }, makeContract());
    await expect(client.list({}, { context })).rejects.toBe(failure);
    expect(getter).not.toHaveBeenCalled();
  });

  it('preserves opaque transport failures whose property descriptors cannot be inspected', async () => {
    const opaque = Proxy.revocable({}, {});
    opaque.revoke();
    const client = createMicroClient({ call: vi.fn().mockRejectedValue(opaque.proxy) }, makeContract());
    let observed: unknown;
    try {
      await client.list({}, { context });
    } catch (error) {
      observed = error;
    }
    expect(Object.is(observed, opaque.proxy)).toBe(true);
  });
});

describe('Micro call options', () => {
  it.each(['input', 'window', 'idleTimeout', 'protocol', 'namespace', 'peer', 'unexpected'])
    ('rejects unsupported option %s', (key) => {
      expect(() => normalizeMicroCallOptions({ context, [key]: undefined })).toThrow(TypeError);
    });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid retry or timeout value %s', (value) => {
    expect(() => normalizeMicroCallOptions({ context, retries: value })).toThrow(TypeError);
    expect(() => normalizeMicroCallOptions({ context, timeout: value })).toThrow(TypeError);
  });

  it('requires context and a real structural signal without parsing context itself', () => {
    expect(() => normalizeMicroCallOptions({})).toThrow(TypeError);
    expect(() => normalizeMicroCallOptions({ context: null })).toThrow(TypeError);
    expect(() => normalizeMicroCallOptions({ context, signal: { aborted: false } })).toThrow(TypeError);
    expect(() => normalizeMicroCallOptions({ context, timeout: 0 })).toThrow(TypeError);
    expect(normalizeMicroCallOptions({ context, retries: 0 })).toEqual({ context, retries: 0 });
  });
});

describe('shared executor validation', () => {
  it('reports provider input/output failures with safe retry-classifiable status', async () => {
    const operation = makeContract().operations.list;
    await expect(validateMicroValue(operation, 'input', { limit: 0 }, 'provider_request'))
      .rejects.toMatchObject({ status: MICRO_CONTRACT_ERROR_STATUS.invalidRequest, phase: 'provider_request' });
    await expect(validateMicroValue(operation, 'output', { items: [12] }, 'provider_response'))
      .rejects.toMatchObject({ status: MICRO_CONTRACT_ERROR_STATUS.invalidResponse, phase: 'provider_response' });
  });

  it('distinguishes schema exceptions from ordinary issues and retains local diagnostic cause', async () => {
    const cause = new Error('secret');
    const schema: StandardSchemaV1 = { '~standard': {
      version: 1, vendor: 'test', validate() { throw cause; },
    } };
    const operation = defineMicroContract({ namespace: 'test.contract', operations: {
      test: { path: '/test', input: schema, output: schema },
    } }).operations.test;
    const failure = await validateMicroValue(operation, 'output', {}, 'provider_response')
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      kind: 'schema', status: MICRO_CONTRACT_ERROR_STATUS.responseSchemaFailed, cause,
    });
    expect(String(failure)).not.toContain('secret');
  });

  it('classifies exceptions thrown while reading a schema result as schema implementation failures', async () => {
    const cause = new Error('schema result failed');
    const schema: StandardSchemaV1 = { '~standard': {
      version: 1, vendor: 'test', validate() {
        return { get value() { throw cause; } };
      },
    } };
    const operation = defineMicroContract({ namespace: 'test.contract', operations: {
      test: { path: '/test', input: schema, output: schema },
    } }).operations.test;
    await expect(validateMicroValue(operation, 'input', {}, 'provider_request')).rejects.toMatchObject({
      kind: 'schema', status: MICRO_CONTRACT_ERROR_STATUS.requestSchemaFailed, cause,
    });
  });

  it('isolates objects returned by identity schemas and shared default values', async () => {
    const shared = { nested: { value: 1 } };
    const schema: StandardSchemaV1 = { '~standard': {
      version: 1, vendor: 'test', validate() { return { value: shared }; },
    } };
    const operation = defineMicroContract({ namespace: 'test.contract', operations: {
      test: { path: '/test', input: schema, output: schema },
    } }).operations.test;
    const parsed = await validateMicroValue(operation, 'input', {}, 'provider_request') as typeof shared;
    parsed.nested.value = 2;
    expect(shared.nested.value).toBe(1);
  });

  it('checks cancellation after async schema validation and never invokes transport', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const schema: StandardSchemaV1 = { '~standard': {
      version: 1, vendor: 'test', async validate(value) {
        controller.abort(reason);
        return { value };
      },
    } };
    const contract = defineMicroContract({ namespace: 'test.contract', operations: {
      test: { path: '/test', input: schema, output: schema },
    } });
    const call = vi.fn<MicroCaller['call']>();
    const client = createMicroClient({ call }, contract);
    await expect(client.test({}, { context, signal: controller.signal })).rejects.toBe(reason);
    expect(call).not.toHaveBeenCalled();
  });

  it('does not call transport when cancellation arrives between validation and invocation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled after validation');
    const schema: StandardSchemaV1 = { '~standard': {
      version: 1, vendor: 'test', validate(value) {
        queueMicrotask(() => queueMicrotask(() => controller.abort(reason)));
        return { value };
      },
    } };
    const contract = defineMicroContract({ namespace: 'test.contract', operations: {
      test: { path: '/test', input: schema, output: schema },
    } });
    const call = vi.fn<MicroCaller['call']>().mockResolvedValue({});
    const client = createMicroClient({ call }, contract);
    await expect(client.test({}, { context, signal: controller.signal })).rejects.toBe(reason);
    expect(call).not.toHaveBeenCalled();
  });

  it('does not deliver a response when cancellation arrives after asynchronous output validation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before response delivery');
    const output: StandardSchemaV1 = { '~standard': {
      version: 1, vendor: 'test', validate(value) {
        queueMicrotask(() => queueMicrotask(() => controller.abort(reason)));
        return { value };
      },
    } };
    const contract = defineMicroContract({ namespace: 'test.contract', operations: {
      test: { path: '/test', input: z.json(), output },
    } });
    const client = createMicroClient({ call: vi.fn().mockResolvedValue({ ok: true }) }, contract);
    await expect(client.test({}, { context, signal: controller.signal })).rejects.toBe(reason);
  });

  it('rejects non-JSON schema output instead of allowing serialization to change it', async () => {
    const schema: StandardSchemaV1 = { '~standard': {
      version: 1, vendor: 'test', validate() { return { value: new Date() }; },
    } };
    const operation = defineMicroContract({ namespace: 'test.contract', operations: {
      test: { path: '/test', input: schema, output: schema },
    } }).operations.test;
    await expect(validateMicroValue(operation, 'output', {}, 'provider_response'))
      .rejects.toMatchObject({ kind: 'wire', status: MICRO_CONTRACT_ERROR_STATUS.invalidResponse });
  });
});

describe('JSON DTO snapshots', () => {
  it('omits optional undefined fields and preserves prototype-looking keys without mutation', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value","nested":{"a":1}}');
    source.optional = undefined;
    const result = snapshotMicroJson(source) as typeof source;
    expect(result).toEqual(JSON.parse(JSON.stringify(source)));
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    result.nested.a = 9;
    expect(source.nested.a).toBe(1);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    undefined, [undefined], new Array(1), new Date(), 1n, new Map(), new Set(), NaN, Infinity,
    { value() {} }, { value: Symbol('bad') },
  ])('rejects values that cannot preserve JSON DTO semantics: %s', (value) => {
    expect(() => snapshotMicroJson(value)).toThrow(TypeError);
  });

  it('rejects cyclic references and accessors without executing getters', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => snapshotMicroJson(cycle)).toThrow(TypeError);
    const getter = vi.fn(() => 1);
    expect(() => snapshotMicroJson(Object.defineProperty({}, 'value', { enumerable: true, get: getter })))
      .toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    const shared = { a: 1 };
    expect(snapshotMicroJson({ one: shared, two: shared })).toEqual({ one: { a: 1 }, two: { a: 1 } });
  });
});
