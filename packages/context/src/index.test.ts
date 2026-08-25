import { describe, expect, it } from 'vitest';
import {
  createExecutionContext,
  createInvocationContext,
  deriveExecutionContext,
  executionContextBindings,
  InvalidExecutionContextError,
  MissingExecutionContextValueError,
  MissingExecutionContextError,
  parseExecutionContext,
  pickExecutionContext,
  requireExecutionContextValues,
  UnsupportedExecutionContextVersionError,
  withExecutionContextLogger,
  type ExecutionContext,
} from './index';

type ShopContext = {
  shopId: string;
  channel: 'web' | 'wechat';
};

describe('@hile/context explicit execution context', () => {
  it('creates immutable versioned protocol data without ambient state', () => {
    const context = createExecutionContext<ShopContext>({
      shopId: 'shop-1',
      channel: 'wechat',
    });

    expect(context).toEqual({
      version: 1,
      values: {
        shopId: 'shop-1',
        channel: 'wechat',
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.values)).toBe(true);
    expect(() => {
      (context.values as Record<string, unknown>).shopId = 'changed';
    }).toThrow(TypeError);
  });

  it('accepts structurally compatible context created by another module instance', () => {
    const foreignContext = Object.freeze({
      version: 1 as const,
      values: Object.freeze({ shopId: 'shop-2', channel: 'web' as const }),
    });

    const parsed: ExecutionContext<ShopContext> = parseExecutionContext<ShopContext>(foreignContext);

    expect(parsed.values.shopId).toBe('shop-2');
    expect(parsed.values.channel).toBe('web');
  });

  it('works across independently evaluated module instances', async () => {
    const producer = await import('./execution-context?producer');
    const consumer = await import('./execution-context?consumer');

    expect(producer).not.toBe(consumer);
    const context = producer.createExecutionContext({ requestId: 'cross-instance' });
    expect(consumer.parseExecutionContext(context).values.requestId).toBe('cross-instance');
  });

  it('survives structured clone boundaries used by workers and message ports', () => {
    const context = createExecutionContext({ requestId: 'worker-boundary', roles: ['reader'] });
    const cloned = structuredClone(context);

    expect(parseExecutionContext(cloned)).toEqual(context);
    expect(cloned).not.toBe(context);
  });

  it('creates and validates an explicit invocation context', () => {
    const signal = new AbortController().signal;
    const invocation = createInvocationContext(
      createExecutionContext({ requestId: 'invocation' }),
      signal,
    );

    expect(invocation.context.values.requestId).toBe('invocation');
    expect(invocation.signal).toBe(signal);
    expect(Object.isFrozen(invocation)).toBe(true);
  });

  it('reports a stable error when invocation context is missing', () => {
    expect(() => createInvocationContext(undefined as never, new AbortController().signal))
      .toThrow(MissingExecutionContextError);
  });

  it('deeply snapshots and freezes JSON-compatible values', () => {
    const source = {
      request: { id: 'request-1' },
      roles: ['reader', 'writer'],
    };

    const context = createExecutionContext(source);
    source.request.id = 'changed';
    source.roles.push('admin');

    expect(context.values).toEqual({
      request: { id: 'request-1' },
      roles: ['reader', 'writer'],
    });
    expect(Object.isFrozen(context.values.request)).toBe(true);
    expect(Object.isFrozen(context.values.roles)).toBe(true);
  });

  it('preserves prototype-looking JSON keys as inert own properties', () => {
    const values = JSON.parse('{"__proto__":{"polluted":true},"constructor":"plain"}');
    const context = createExecutionContext(values);

    expect(Object.prototype.hasOwnProperty.call(context.values, '__proto__')).toBe(true);
    expect(context.values.__proto__).toEqual({ polluted: true });
    expect(context.values.constructor).toBe('plain');
    expect(Object.getPrototypeOf(context.values)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('safely picks and requires prototype-looking keys', () => {
    const context = createExecutionContext(JSON.parse('{"__proto__":{"role":"reader"}}'));
    const picked = pickExecutionContext(context, ['__proto__']);
    const required = requireExecutionContextValues(context, ['__proto__']);

    expect(Object.prototype.hasOwnProperty.call(picked.values, '__proto__')).toBe(true);
    expect(picked.values.__proto__).toEqual({ role: 'reader' });
    expect(Object.getPrototypeOf(picked.values)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(required, '__proto__')).toBe(true);
    expect(required.__proto__).toEqual({ role: 'reader' });
    expect(Object.getPrototypeOf(required)).toBe(Object.prototype);
  });

  it.each([
    ['non-finite number', { value: Number.NaN }],
    ['function', { value: () => undefined }],
    ['symbol', { value: Symbol('invalid') }],
    ['class instance', { value: new Date() }],
  ])('rejects %s values', (_name, values) => {
    expect(() => createExecutionContext(values)).toThrow(InvalidExecutionContextError);
  });

  it('rejects cyclic values with the invalid field path', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => createExecutionContext({ cyclic })).toThrowError(
      expect.objectContaining({ path: '$.cyclic.self' }),
    );
  });

  it('rejects unsupported protocol versions separately from malformed input', () => {
    expect(() => parseExecutionContext({ version: 2, values: {} })).toThrow(
      UnsupportedExecutionContextVersionError,
    );
    expect(() => parseExecutionContext({ version: 1, values: [] })).toThrow(
      InvalidExecutionContextError,
    );
  });

  it('derives and picks immutable context values without mutating the parent', () => {
    const parent = createExecutionContext({
      shopId: 'shop-1',
      channel: 'web',
      secret: 'hidden',
    });

    const derived = deriveExecutionContext(parent, { channel: 'wechat' });
    const picked = pickExecutionContext(derived, ['shopId', 'channel']);

    expect(parent.values.channel).toBe('web');
    expect(derived.values).toEqual({ shopId: 'shop-1', channel: 'wechat', secret: 'hidden' });
    expect(picked.values).toEqual({ shopId: 'shop-1', channel: 'wechat' });
  });

  it('requires selected values and reports missing keys', () => {
    const context = createExecutionContext({ shopId: 'shop-1' });

    expect(requireExecutionContextValues(context, ['shopId'])).toEqual({ shopId: 'shop-1' });
    expect(() => requireExecutionContextValues(context, ['shopId', 'channel'])).toThrowError(
      expect.objectContaining({ keys: ['channel'] }),
    );
    expect(() => requireExecutionContextValues(context, ['channel'])).toThrow(
      MissingExecutionContextValueError,
    );
  });

  it('derives logger bindings only from an explicitly supplied execution context', () => {
    const calls: Array<Record<string, unknown>> = [];
    const logger = {
      child(bindings: Record<string, unknown>) {
        return {
          info(data: Record<string, unknown>) {
            calls.push({ ...bindings, ...data });
          },
        };
      },
      info() {
        throw new Error('expected child logger');
      },
    };
    const context = createExecutionContext({
      requestId: 'request-1',
      tenantId: 'tenant-1',
      secret: 'hidden',
    });
    const wrapped = withExecutionContextLogger(logger, context, {
      pick: ['requestId', 'tenantId'],
    });

    wrapped.info({ event: 'checkout' });

    expect(calls).toEqual([{
      requestId: 'request-1',
      tenantId: 'tenant-1',
      event: 'checkout',
    }]);
  });

  it('preserves prototype-looking logger binding keys without changing the prototype', () => {
    const context = createExecutionContext(JSON.parse('{"__proto__":"picked"}'));
    const mapped = JSON.parse('{"__proto__":"mapped"}');
    const bindings = executionContextBindings(context, {
      pick: ['__proto__'],
      map: () => mapped,
    });

    expect(Object.prototype.hasOwnProperty.call(bindings, '__proto__')).toBe(true);
    expect(bindings.__proto__).toBe('mapped');
    expect(Object.getPrototypeOf(bindings)).toBe(Object.prototype);
  });
});
