import { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { createExecutionContext, createInvocationContext } from '@hile/context';
import { Application, Registry } from '@hile/micro';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  HTTP_OVER_MICRO_PROTOCOL,
  HTTP_OVER_MICRO_VERSION,
  HttpOverMicroError,
  callHttpOverMicro,
  defineHttpOverMicroMessage,
  httpFieldsToRecord,
  httpOverMicroRequestEnvelopeSchema,
  type HttpOverMicroApplication,
  type HttpOverMicroCallOptions,
  type HttpOverMicroResponseHead,
} from './index';

const context = createExecutionContext({ requestId: 'request-1' });

function responseHead(
  body: HttpOverMicroResponseHead['body'],
  overrides: Partial<HttpOverMicroResponseHead> = {},
): HttpOverMicroResponseHead {
  return {
    protocol: HTTP_OVER_MICRO_PROTOCOL,
    version: HTTP_OVER_MICRO_VERSION,
    type: 'response',
    status: 200,
    headers: [],
    body,
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function invocation() {
  return createInvocationContext(context, new AbortController().signal, 'http-over-micro-test');
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate a test port');
  return address.port;
}

async function listenOnAvailablePort(server: { listen(port: number): Promise<() => Promise<void>> }) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await getAvailablePort();
    try {
      return { port, close: await server.listen(port) };
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw lastError;
}

async function createMicroHarness(providerNamespace: string) {
  const registry = new Registry({ advertiseHost: '127.0.0.1' });
  const registryListener = await listenOnAvailablePort(registry);
  const provider = new Application({
    namespace: providerNamespace,
    registry: { host: '127.0.0.1', port: registryListener.port },
    advertiseHost: '127.0.0.1',
  });
  const consumer = new Application({
    namespace: `${providerNamespace}.consumer`,
    registry: { host: '127.0.0.1', port: registryListener.port },
    advertiseHost: '127.0.0.1',
  });
  let providerListener: Awaited<ReturnType<typeof listenOnAvailablePort>> | undefined;
  let consumerListener: Awaited<ReturnType<typeof listenOnAvailablePort>> | undefined;
  try {
    providerListener = await listenOnAvailablePort(provider);
    consumerListener = await listenOnAvailablePort(consumer);
  } catch (error) {
    await consumerListener?.close();
    await providerListener?.close();
    await registryListener.close();
    throw error;
  }
  return {
    provider,
    consumer,
    close: async () => {
      await consumerListener.close();
      await providerListener.close();
      await registryListener.close();
    },
  };
}

describe('callHttpOverMicro', () => {
  it('serializes an inline request and returns an inline response', async () => {
    const stream = vi.fn<HttpOverMicroApplication['stream']>(async () => Readable.from([
      responseHead(
        { kind: 'inline', value: { ok: true } },
        { status: 201, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']] },
      ),
    ]));

    const response = await callHttpOverMicro(
      { stream },
      'cn.zlooks.blog.server',
      '/posts',
      {
        method: 'post',
        headers: { Cookie: 'sid=1', 'X-Trace': ['a', 'b'] },
        query: [['tag', 'node'], ['tag', 'hile']],
        body: { title: 'hello' },
      },
      { context, timeout: 5_000 },
    );

    expect(stream).toHaveBeenCalledWith(
      'cn.zlooks.blog.server',
      '/posts',
      {
        protocol: HTTP_OVER_MICRO_PROTOCOL,
        version: HTTP_OVER_MICRO_VERSION,
        type: 'request',
        method: 'POST',
        headers: [['cookie', 'sid=1'], ['x-trace', 'a'], ['x-trace', 'b']],
        query: [['tag', 'node'], ['tag', 'hile']],
        body: { kind: 'inline', value: { title: 'hello' } },
      },
      { context, timeout: 5_000, retries: 0, protocol: HTTP_OVER_MICRO_PROTOCOL },
    );
    expect(response).toEqual({
      status: 201,
      headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']],
      bodyKind: 'inline',
      body: { ok: true },
    });
  });

  it('automatically sends binary and async iterable request bodies as Micro input', async () => {
    const upload = Readable.from([Buffer.from('a'), Buffer.from('b')]);
    const stream = vi.fn<HttpOverMicroApplication['stream']>(async () => Readable.from([
      responseHead({ kind: 'empty' }, { status: 204 }),
    ]));

    await callHttpOverMicro(
      { stream },
      'upload.server',
      '/files',
      { method: 'PUT', body: upload },
      { context },
    );

    expect(stream).toHaveBeenCalledWith(
      'upload.server',
      '/files',
      expect.objectContaining({ body: { kind: 'stream' } }),
      { context, retries: 0, input: upload, protocol: HTTP_OVER_MICRO_PROTOCOL },
    );

    const binary = new Uint8Array([1, 2, 3]);
    await callHttpOverMicro(
      { stream },
      'upload.server',
      '/bytes',
      { method: 'PUT', body: binary },
      { context },
    );
    expect(stream).toHaveBeenLastCalledWith(
      'upload.server',
      '/bytes',
      expect.objectContaining({ body: { kind: 'stream' } }),
      { context, retries: 0, input: binary, protocol: HTTP_OVER_MICRO_PROTOCOL },
    );
  });

  it('sets its transport protocol even when unchecked options try to override it', async () => {
    expectTypeOf<HttpOverMicroCallOptions>().not.toHaveProperty('protocol');
    const stream = vi.fn<HttpOverMicroApplication['stream']>(async () => Readable.from([
      responseHead({ kind: 'empty' }, { status: 204 }),
    ]));

    await callHttpOverMicro(
      { stream },
      'service',
      '/protocol',
      { method: 'GET' },
      { context, protocol: 'other-protocol' } as never,
    );

    expect(stream).toHaveBeenCalledWith(
      'service',
      '/protocol',
      expect.any(Object),
      { context, retries: 0, protocol: HTTP_OVER_MICRO_PROTOCOL },
    );
  });

  it('rejects retries for streamed request bodies before dispatch', async () => {
    const stream = vi.fn<HttpOverMicroApplication['stream']>();
    await expect(callHttpOverMicro(
      { stream },
      'upload.server',
      '/files',
      { method: 'POST', body: Readable.from(['body']) },
      { context, retries: 1 },
    )).rejects.toThrow('non-replayable');
    expect(stream).not.toHaveBeenCalled();
  });

  it('returns the remaining Micro output as the streamed HTTP body', async () => {
    const source = Readable.from([
      responseHead({ kind: 'stream' }, { headers: [['content-type', 'application/octet-stream']] }),
      Buffer.from('a'),
      Buffer.from('b'),
    ]);
    const response = await callHttpOverMicro(
      { stream: async () => source },
      'download.server',
      '/files/1',
      { method: 'GET' },
      { context },
    );

    expect(response.bodyKind).toBe('stream');
    if (response.bodyKind !== 'stream') throw new Error('expected stream');
    const chunks = await collect<Buffer>(response.body);
    expect(Buffer.concat(chunks).toString()).toBe('ab');
  });

  it('preserves a response-stream error raised immediately after the head', async () => {
    const source = Readable.from((async function* () {
      yield responseHead({ kind: 'stream' });
      throw new Error('response failed');
    })());
    const response = await callHttpOverMicro(
      { stream: async () => source },
      'download.server',
      '/files/failing',
      { method: 'GET' },
      { context },
    );

    if (response.bodyKind !== 'stream') throw new Error('expected stream');
    await expect(collect(response.body)).rejects.toThrow('response failed');
  });

  it('rejects a missing or malformed response head', async () => {
    await expect(callHttpOverMicro(
      { stream: async () => Readable.from([]) },
      'service',
      '/empty',
      { method: 'GET' },
      { context },
    )).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });

    await expect(callHttpOverMicro(
      { stream: async () => Readable.from([{ status: 200 }]) },
      'service',
      '/malformed',
      { method: 'GET' },
      { context },
    )).rejects.toBeInstanceOf(HttpOverMicroError);
  });

  it('rejects a non-JSON inline body received from an invalid application adapter', async () => {
    await expect(callHttpOverMicro(
      { stream: async () => Readable.from([
        responseHead({ kind: 'inline', value: 1n }),
      ]) },
      'service',
      '/non-json',
      { method: 'GET' },
      { context },
    )).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
  });

  it('rejects trailing frames after an inline response', async () => {
    await expect(callHttpOverMicro(
      { stream: async () => Readable.from([
        responseHead({ kind: 'inline', value: { ok: true } }),
        { unexpected: true },
      ]) },
      'service',
      '/extra',
      { method: 'GET' },
      { context },
    )).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
  });

  it('rejects an upstream body forbidden by the request method or response status', async () => {
    await expect(callHttpOverMicro(
      { stream: async () => Readable.from([
        responseHead({ kind: 'inline', value: 'body' }, { status: 204 }),
      ]) },
      'service',
      '/invalid-204',
      { method: 'GET' },
      { context },
    )).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
  });

  it('bounds inline request bodies before opening Micro transport', async () => {
    const stream = vi.fn<HttpOverMicroApplication['stream']>();
    await expect(callHttpOverMicro(
      { stream },
      'service',
      '/large',
      { method: 'POST', body: { value: 'too large' } },
      { context, limits: { maxInlineBodyBytes: 8 } },
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 413 });
    expect(stream).not.toHaveBeenCalled();
  });

  it('rejects malformed runtime request metadata consistently', async () => {
    await expect(callHttpOverMicro(
      { stream: vi.fn() },
      'service',
      '/invalid',
      null as never,
      { context },
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });

    const parsed = httpOverMicroRequestEnvelopeSchema.safeParse({
      protocol: HTTP_OVER_MICRO_PROTOCOL,
      version: HTTP_OVER_MICRO_VERSION,
      type: 'request',
      method: 'GET',
      headers: [],
      query: [['bad\0name', 'value']],
      body: { kind: 'empty' },
    });
    expect(parsed.success).toBe(false);

    const stream = vi.fn<HttpOverMicroApplication['stream']>();
    await expect(callHttpOverMicro(
      { stream },
      'service',
      '/invalid-fields',
      { method: 'GET', headers: { invalid: 1 as never } },
      { context },
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(stream).not.toHaveBeenCalled();
  });

  it('rejects header injection and keeps special field names data-only', async () => {
    const stream = vi.fn<HttpOverMicroApplication['stream']>();
    await expect(callHttpOverMicro(
      { stream },
      'service',
      '/headers',
      { method: 'GET', headers: { 'x-value': 'safe\r\ninjected: true' } },
      { context },
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(stream).not.toHaveBeenCalled();

    const values = httpFieldsToRecord([
      ['__proto__', 'plain-data'],
      ['constructor', 'also-data'],
    ]);
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(values.__proto__).toBe('plain-data');
    expect(values.constructor).toBe('also-data');
  });
});

describe('defineHttpOverMicroMessage', () => {
  it('declares its transport protocol before a handler can run', () => {
    const definition = defineHttpOverMicroMessage(
      { method: 'GET' },
      async () => ({ status: 204 }),
    );

    expect(definition).toMatchObject({ protocol: HTTP_OVER_MICRO_PROTOCOL });
  });

  it('validates and passes parsed request values to the handler', async () => {
    const handler = vi.fn(async ({ request, params, invocation: current }) => ({
      status: 200,
      headers: { 'X-Page': String(request.query.page) },
      body: {
        title: request.body.title,
        authorized: request.headers.authorization,
        slug: params.slug,
        requestId: current.context.values.requestId,
      },
    }));
    const definition = defineHttpOverMicroMessage({
      method: 'POST',
      schema: {
        headers: z.object({ authorization: z.string().startsWith('Bearer ') }),
        query: z.object({ page: z.coerce.number().int().positive() }),
        params: z.object({ slug: z.string().transform(value => value.toUpperCase()) }),
        body: z.object({ title: z.string().min(1) }),
      },
    }, handler);

    const output = await collect(definition.fn({
      data: {
        protocol: HTTP_OVER_MICRO_PROTOCOL,
        version: HTTP_OVER_MICRO_VERSION,
        type: 'request',
        method: 'POST',
        headers: [['authorization', 'Bearer token']],
        query: [['page', '2']],
        body: { kind: 'inline', value: { title: 'Hello' } },
      },
      url: '/posts/hello',
      params: { slug: 'hello' },
      client: {} as never,
      invocation: invocation(),
    }));

    expect(handler).toHaveBeenCalledOnce();
    expect(output).toEqual([
      responseHead(
        {
          kind: 'inline',
          value: {
            title: 'Hello',
            authorized: 'Bearer token',
            slug: 'HELLO',
            requestId: 'request-1',
          },
        },
        { headers: [['x-page', '2']] },
      ),
    ]);
  });

  it('passes a request stream as body and emits a streamed response after the head', async () => {
    const input = Readable.from([Buffer.from('request')]);
    const definition = defineHttpOverMicroMessage(
      { method: ['POST', 'PUT'] },
      async ({ request }) => {
        expect(request.body).toBe(input);
        return {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
          body: Readable.from([Buffer.from('one'), Buffer.from('two')]),
        };
      },
    );

    const output = await collect(definition.fn({
      data: {
        protocol: HTTP_OVER_MICRO_PROTOCOL,
        version: HTTP_OVER_MICRO_VERSION,
        type: 'request',
        method: 'PUT',
        headers: [],
        query: [],
        body: { kind: 'stream' },
      },
      input,
      url: '/files',
      client: {} as never,
      invocation: invocation(),
    }));

    expect(output[0]).toEqual(responseHead(
      { kind: 'stream' },
      { headers: [['content-type', 'application/octet-stream']] },
    ));
    expect(Buffer.concat(output.slice(1) as Buffer[]).toString()).toBe('onetwo');
  });

  it('returns 405 with Allow without invoking the handler', async () => {
    const handler = vi.fn(async () => ({ status: 204 }));
    const definition = defineHttpOverMicroMessage({ method: ['GET', 'HEAD'] }, handler);

    const output = await collect(definition.fn({
      data: {
        protocol: HTTP_OVER_MICRO_PROTOCOL,
        version: HTTP_OVER_MICRO_VERSION,
        type: 'request',
        method: 'DELETE',
        headers: [],
        query: [],
        body: { kind: 'empty' },
      },
      url: '/posts/1',
      client: {} as never,
      invocation: invocation(),
    }));

    expect(handler).not.toHaveBeenCalled();
    expect(output).toEqual([
      responseHead(
        { kind: 'empty' },
        { status: 405, headers: [['allow', 'GET, HEAD']] },
      ),
    ]);
  });

  it('rejects inconsistent stream metadata and invalid Zod input as HTTP 400 errors', async () => {
    const definition = defineHttpOverMicroMessage({
      method: 'POST',
      schema: { body: z.object({ title: z.string().min(1) }) },
    }, async () => ({ status: 204 }));

    const base = {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
      version: HTTP_OVER_MICRO_VERSION,
      type: 'request' as const,
      method: 'POST',
      headers: [],
      query: [],
    };

    await expect(collect(definition.fn({
      data: { ...base, body: { kind: 'stream' as const } },
      url: '/posts',
      client: {} as never,
      invocation: invocation(),
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });

    await expect(collect(definition.fn({
      data: { ...base, body: { kind: 'inline' as const, value: { title: '' } } },
      url: '/posts',
      client: {} as never,
      invocation: invocation(),
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
  });

  it('rejects invalid definitions and bodies forbidden by HTTP semantics', async () => {
    expect(() => defineHttpOverMicroMessage(
      { method: 'NOT A METHOD' },
      async () => ({ status: 204 }),
    )).toThrow(expect.objectContaining({ code: 'INVALID_DEFINITION', status: 500 }));
    expect(() => defineHttpOverMicroMessage(
      { method: undefined as never },
      async () => ({ status: 204 }),
    )).toThrow(expect.objectContaining({ code: 'INVALID_DEFINITION', status: 500 }));
    expect(() => defineHttpOverMicroMessage(
      { method: 'GET', schema: { body: {} as never } },
      async () => ({ status: 204 }),
    )).toThrow(expect.objectContaining({ code: 'INVALID_DEFINITION', status: 500 }));

    const definition = defineHttpOverMicroMessage({ method: 'HEAD' }, async () => ({
      status: 200,
      body: 'not allowed',
    }));
    await expect(collect(definition.fn({
      data: {
        protocol: HTTP_OVER_MICRO_PROTOCOL,
        version: HTTP_OVER_MICRO_VERSION,
        type: 'request',
        method: 'HEAD',
        headers: [],
        query: [],
        body: { kind: 'empty' },
      },
      url: '/head',
      client: {} as never,
      invocation: invocation(),
    }))).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 500 });
  });

  it('rejects response-header injection from a handler', async () => {
    const definition = defineHttpOverMicroMessage({ method: 'GET' }, async () => ({
      status: 200,
      headers: { 'x-value': 'safe\r\ninjected: true' },
    }));
    await expect(collect(definition.fn({
      data: {
        protocol: HTTP_OVER_MICRO_PROTOCOL,
        version: HTTP_OVER_MICRO_VERSION,
        type: 'request',
        method: 'GET',
        headers: [],
        query: [],
        body: { kind: 'empty' },
      },
      url: '/headers',
      client: {} as never,
      invocation: invocation(),
    }))).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 500 });
  });

  it('rejects malformed envelopes and invalid handler response shapes', async () => {
    const malformed = defineHttpOverMicroMessage({ method: 'GET' }, async () => ({ status: 204 }));
    await expect(collect(malformed.fn({
      data: { version: 2 } as never,
      url: '/malformed',
      client: {} as never,
      invocation: invocation(),
    }))).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });

    const invalidResponse = defineHttpOverMicroMessage(
      { method: 'GET' },
      async () => null as never,
    );
    await expect(collect(invalidResponse.fn({
      data: {
        protocol: HTTP_OVER_MICRO_PROTOCOL,
        version: HTTP_OVER_MICRO_VERSION,
        type: 'request',
        method: 'GET',
        headers: [],
        query: [],
        body: { kind: 'empty' },
      },
      url: '/invalid-response',
      client: {} as never,
      invocation: invocation(),
    }))).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 500 });
  });
});

describe('@hile/http-over-micro integration', () => {
  it('rejects an HOM request before an input-ignoring ordinary Micro handler has side effects', async () => {
    const harness = await createMicroHarness('http-over-micro.reject-ordinary');
    const handler = vi.fn(async function* () {
      yield responseHead({ kind: 'empty' }, { status: 204 });
    });
    const unregister = harness.provider.register('/ordinary', handler);

    try {
      await expect(callHttpOverMicro(
        harness.consumer,
        'http-over-micro.reject-ordinary',
        '/ordinary',
        { method: 'POST' },
        { context, retries: 0 },
      )).rejects.toThrow(/protocol/i);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      unregister();
      await harness.close();
    }
  });

  it('rejects an ordinary Micro request with a valid HOM envelope before the HOM handler runs', async () => {
    const harness = await createMicroHarness('http-over-micro.reject-unmarked');
    const handler = vi.fn(async () => ({ status: 204 }));
    const message = defineHttpOverMicroMessage({ method: 'POST' }, handler);
    const unregister = harness.provider.register('/http', message.fn, {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
    });

    try {
      await expect((async () => {
        const response = await harness.consumer.stream(
          'http-over-micro.reject-unmarked',
          '/http',
          {
            protocol: HTTP_OVER_MICRO_PROTOCOL,
            version: HTTP_OVER_MICRO_VERSION,
            type: 'request',
            method: 'POST',
            headers: [],
            query: [],
            body: { kind: 'empty' },
          },
          { context, retries: 0 },
        );
        await collect(response);
      })()).rejects.toThrow(/protocol/i);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      unregister();
      await harness.close();
    }
  });

  it('preserves a legitimate inline HOM invocation and its execution context', async () => {
    const harness = await createMicroHarness('http-over-micro.inline');
    const message = defineHttpOverMicroMessage(
      { method: 'POST', schema: { body: z.object({ title: z.string() }) } },
      async ({ request, invocation: current }) => ({
        status: 201,
        body: { title: request.body.title, requestId: current.context.values.requestId },
      }),
    );
    const unregister = harness.provider.register('/inline', message.fn, {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
    });

    try {
      const response = await callHttpOverMicro(
        harness.consumer,
        'http-over-micro.inline',
        '/inline',
        { method: 'POST', body: { title: 'Hello' } },
        { context, retries: 0 },
      );

      expect(response).toEqual({
        status: 201,
        headers: [],
        bodyKind: 'inline',
        body: { title: 'Hello', requestId: 'request-1' },
      });
    } finally {
      unregister();
      await harness.close();
    }
  });

  it('carries simultaneous request and response streams through Registry-discovered Micro', async () => {
    const harness = await createMicroHarness('http-over-micro.provider');
    const message = defineHttpOverMicroMessage({ method: 'POST' }, async ({ request }) => {
      if (!(request.body instanceof Readable)) throw new Error('expected request stream');
      let received = '';
      for await (const chunk of request.body) received += Buffer.from(chunk).toString();
      return {
        status: 201,
        headers: [['set-cookie', 'upload=done'], ['location', '/files/1']],
        body: Readable.from([Buffer.from('stored:'), Buffer.from(received)]),
      };
    });

    const unregister = harness.provider.register('/files', message.fn, {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
    });

    try {
      const response = await callHttpOverMicro(
        harness.consumer,
        'http-over-micro.provider',
        '/files',
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: Readable.from([Buffer.from('hello'), Buffer.from('-world')]),
        },
        { context, timeout: 5_000, idleTimeout: 2_000 },
      );

      expect(response.status).toBe(201);
      expect(response.headers).toEqual([
        ['set-cookie', 'upload=done'],
        ['location', '/files/1'],
      ]);
      expect(response.bodyKind).toBe('stream');
      if (response.bodyKind !== 'stream') throw new Error('expected response stream');
      const chunks = await collect<Buffer>(response.body);
      expect(Buffer.concat(chunks).toString()).toBe('stored:hello-world');
    } finally {
      unregister();
      await harness.close();
    }
  });

  it('cancels an unconsumed upload source when the provider responds early', async () => {
    const harness = await createMicroHarness('http-over-micro.early-response');
    const iterator = {
      next: vi.fn(async () => ({ done: false as const, value: Buffer.from('chunk') })),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const input = { [Symbol.asyncIterator]: () => iterator };
    const message = defineHttpOverMicroMessage({ method: 'POST' }, async () => ({ status: 413 }));
    const unregister = harness.provider.register('/upload', message.fn, {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
    });

    try {
      const response = await callHttpOverMicro(
        harness.consumer,
        'http-over-micro.early-response',
        '/upload',
        { method: 'POST', body: input },
        { context },
      );
      expect(response).toMatchObject({ status: 413, bodyKind: 'empty' });
      await vi.waitFor(() => expect(iterator.return).toHaveBeenCalledOnce());
    } finally {
      unregister();
      await harness.close();
    }
  });

  it('propagates response-body destruction to the provider iterator', async () => {
    const harness = await createMicroHarness('http-over-micro.cancel-response');
    const iterator = {
      next: vi.fn(async () => ({ done: false as const, value: Buffer.from('chunk') })),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const output = { [Symbol.asyncIterator]: () => iterator };
    const message = defineHttpOverMicroMessage(
      { method: 'GET' },
      async () => ({ status: 200, body: output }),
    );
    const unregister = harness.provider.register('/download', message.fn, {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
    });

    try {
      const response = await callHttpOverMicro(
        harness.consumer,
        'http-over-micro.cancel-response',
        '/download',
        { method: 'GET' },
        { context },
      );
      if (response.bodyKind !== 'stream') throw new Error('expected stream');
      await new Promise<void>((resolve, reject) => {
        response.body.once('error', reject);
        response.body.once('data', () => {
          response.body.pause();
          resolve();
        });
      });
      response.body.destroy();
      await vi.waitFor(() => expect(iterator.return).toHaveBeenCalledOnce());
    } finally {
      unregister();
      await harness.close();
    }
  });

  it('preserves caller cancellation through the protocol-marked request', async () => {
    const harness = await createMicroHarness('http-over-micro.abort-signal');
    const controller = new AbortController();
    const iterator = {
      next: vi.fn(async () => ({ done: false as const, value: Buffer.from('chunk') })),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    let providerSignal: AbortSignal | undefined;
    const message = defineHttpOverMicroMessage({ method: 'GET' }, async ({ invocation: current }) => {
      providerSignal = current.signal;
      return { body: { [Symbol.asyncIterator]: () => iterator } };
    });
    const unregister = harness.provider.register('/download', message.fn, {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
    });

    try {
      const response = await callHttpOverMicro(
        harness.consumer,
        'http-over-micro.abort-signal',
        '/download',
        { method: 'GET' },
        { context, signal: controller.signal, retries: 0 },
      );
      if (response.bodyKind !== 'stream') throw new Error('expected stream');
      await new Promise<void>((resolve, reject) => {
        response.body.once('error', reject);
        response.body.once('data', () => {
          response.body.pause();
          resolve();
        });
      });
      const completion = collect(response.body);
      controller.abort(new Error('cancelled-by-test'));

      await expect(completion).rejects.toThrow('Abort');
      await vi.waitFor(() => {
        expect(providerSignal?.aborted).toBe(true);
        expect(iterator.return).toHaveBeenCalledOnce();
      });
    } finally {
      controller.abort();
      unregister();
      await harness.close();
    }
  });
});
