import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, MissingExecutionContextError } from '@hile/context';
import type { RscPluginClient, RscPluginLocator } from '../transport';
import {
  RscServerFunctionGateway,
  RscServerFunctionGatewayError,
  createRscServerFunctionMiddleware,
  type RscServerFunctionHttpContext,
} from './server-functions';

const testContext = createExecutionContext({ test: true });

function setup() {
  const client = { serverFunction: vi.fn(async (request) => request.args) } as unknown as RscPluginClient;
  const release = vi.fn();
  const locator: RscPluginLocator = { resolve: vi.fn(async () => ({ client, release })) };
  return { client, release, locator };
}

describe('RscServerFunctionGateway', () => {
  it('fails before authorization when execution context is missing', async () => {
    const { locator } = setup();
    const authorize = vi.fn(async () => true);
    const gateway = new RscServerFunctionGateway({ locator, authorize });

    await expect(gateway.invoke({
      referenceId: 'org.hile.fixture/build-a/src/actions#save',
      args: {},
    }, {} as never)).rejects.toBeInstanceOf(MissingExecutionContextError);
    expect(authorize).not.toHaveBeenCalled();
    expect(locator.resolve).not.toHaveBeenCalled();
  });

  it('pins the reference to its exact plugin build and always releases the lease', async () => {
    const { client, release, locator } = setup();
    const authorize = vi.fn(async () => true);
    const gateway = new RscServerFunctionGateway({ locator, authorize });
    const signal = new AbortController().signal;
    const request = {
      referenceId: 'org.hile.fixture/build-a/src/actions#save',
      args: { $rsc: 'array', value: [1] },
    };

    await expect(gateway.invoke(request, { context: testContext, signal })).resolves.toEqual(request.args);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'org.hile.fixture', buildId: 'build-a', referenceId: request.referenceId,
    }), expect.objectContaining({ context: testContext, signal }));
    expect(locator.resolve).toHaveBeenCalledWith(
      { pluginId: 'org.hile.fixture', buildId: 'build-a' }, { context: testContext, signal },
    );
    expect(client.serverFunction).toHaveBeenCalledWith({
      buildId: 'build-a', referenceId: request.referenceId, args: request.args,
    }, { context: testContext, signal });
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects malformed or denied references before resolving a plugin', async () => {
    const { locator } = setup();
    const gateway = new RscServerFunctionGateway({ locator, authorize: async () => true });
    for (const invalid of [null, {}, { referenceId: 'bad', args: {} }, {
      referenceId: 'plugin/build/module#name', args: undefined,
    }]) {
      await expect(gateway.invoke(invalid, { context: testContext })).rejects.toBeInstanceOf(RscServerFunctionGatewayError);
    }
    const denied = new RscServerFunctionGateway({ locator, authorize: async () => false });
    await expect(denied.invoke({
      referenceId: 'plugin/build/module#name', args: {},
    }, { context: testContext })).rejects.toMatchObject({ code: 'ERR_RSC_SERVER_FUNCTION_FORBIDDEN' });
    expect(locator.resolve).not.toHaveBeenCalled();
  });

  it('releases the lease when remote execution fails', async () => {
    const { client, release, locator } = setup();
    vi.mocked(client.serverFunction).mockRejectedValueOnce(new Error('remote failed'));
    const gateway = new RscServerFunctionGateway({ locator, authorize: async () => true });
    await expect(gateway.invoke({
      referenceId: 'plugin/build/module#name', args: {},
    }, { context: testContext })).rejects.toThrow('remote failed');
    expect(release).toHaveBeenCalledOnce();
  });
});

function context(method: string, path: string): RscServerFunctionHttpContext {
  const headers = new Map<string, string>();
  return {
    method,
    path,
    status: 0,
    requestContext: { context: testContext },
    set(name, value) { headers.set(name, value); },
  };
}

describe('RSC Server Function HTTP adapter', () => {
  it('owns one exact POST endpoint and delegates all other paths', async () => {
    const gateway = { invoke: vi.fn(async () => 'wire-result') };
    const readJson = vi.fn(async () => ({ referenceId: 'plugin/build/module#name', args: {} }));
    const middleware = createRscServerFunctionMiddleware({ gateway, readJson });
    const next = vi.fn(async () => 'next');
    await expect(middleware(context('GET', '/outside'), next)).resolves.toBe('next');

    const method = context('GET', '/_hile/rsc/server-functions');
    await middleware(method, next);
    expect(method.status).toBe(405);

    const post = context('POST', '/_hile/rsc/server-functions');
    await middleware(post, next);
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ value: 'wire-result' });
  });

  it('maps malformed and forbidden requests to stable HTTP errors', async () => {
    for (const [code, status] of [
      ['ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST', 400],
      ['ERR_RSC_SERVER_FUNCTION_FORBIDDEN', 403],
    ] as const) {
      const gateway = { invoke: vi.fn(async () => {
        throw new RscServerFunctionGatewayError(code, 'denied');
      }) };
      const middleware = createRscServerFunctionMiddleware({ gateway, readJson: async () => ({}) });
      const ctx = context('POST', '/_hile/rsc/server-functions');
      await middleware(ctx, vi.fn());
      expect(ctx.status).toBe(status);
      expect(ctx.body).toEqual({ code, message: 'denied' });
    }
  });

  it('returns a stable JSON 500 envelope when plugin execution fails', async () => {
    const middleware = createRscServerFunctionMiddleware({
      gateway: { invoke: vi.fn(async () => { throw new Error('private plugin detail'); }) },
      readJson: async () => ({}),
    });
    const ctx = context('POST', '/_hile/rsc/server-functions');
    await middleware(ctx, vi.fn());
    expect(ctx.status).toBe(500);
    expect(ctx.type).toBe('application/json; charset=utf-8');
    expect(ctx.body).toEqual({
      code: 'ERR_RSC_SERVER_FUNCTION_FAILED',
      message: 'RSC Server Function execution failed',
    });
  });
});
