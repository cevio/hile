import { describe, expect, it, vi } from 'vitest';
import type { RscPluginClient, RscPluginLocator } from '../transport';
import {
  RscActionGateway,
  RscActionGatewayError,
  createRscActionMiddleware,
  createSameOriginCsrfAuthorizer,
  type RscActionHttpContext,
} from './actions';

function setup() {
  const client = {
    describe: vi.fn(),
    render: vi.fn(),
    action: vi.fn(async (request) => ({ actionId: request.actionId, input: request.input })),
  } as unknown as RscPluginClient;
  const release = vi.fn();
  const locator: RscPluginLocator = {
    resolve: vi.fn(async () => ({ client, release })),
  };
  const authorize = vi.fn(async () => true);
  return { client, release, locator, authorize };
}

describe('RscActionGateway', () => {
  it('authorizes, invokes an exact build and always releases its lease', async () => {
    const { client, release, locator, authorize } = setup();
    const gateway = new RscActionGateway({ locator, authorize });
    const signal = new AbortController().signal;
    const context = { signal, headers: { origin: 'https://host.test' } };

    await expect(gateway.invoke({
      pluginId: 'org.hile.fixture', buildId: 'build-a', actionId: 'operation-a', input: { value: 1 },
    }, context)).resolves.toEqual({ actionId: 'operation-a', input: { value: 1 } });

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'operation-a' }), context);
    expect(locator.resolve).toHaveBeenCalledWith(
      { pluginId: 'org.hile.fixture', buildId: 'build-a' }, { signal },
    );
    expect(client.action).toHaveBeenCalledWith(
      { buildId: 'build-a', actionId: 'operation-a', input: { value: 1 } }, { signal },
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects denied and malformed requests before locating a plugin', async () => {
    const { locator } = setup();
    const denied = new RscActionGateway({ locator, authorize: async () => false });
    await expect(denied.invoke({
      pluginId: 'org.hile.fixture', buildId: 'build-a', actionId: 'operation-a', input: {},
    }, {})).rejects.toMatchObject({ code: 'ERR_RSC_ACTION_FORBIDDEN' });

    const gateway = new RscActionGateway({ locator, authorize: async () => true });
    for (const invalid of [
      null,
      {},
      { pluginId: '', buildId: 'a', actionId: 'x', input: {} },
      { pluginId: 'p', buildId: 'a', actionId: 'x', input: null },
      { pluginId: 'p', buildId: 'a', actionId: 'x', input: [] },
    ]) {
      await expect(gateway.invoke(invalid, {})).rejects.toBeInstanceOf(RscActionGatewayError);
    }
    expect(locator.resolve).not.toHaveBeenCalled();
  });

  it('releases a lease when the remote action fails', async () => {
    const { client, release, locator } = setup();
    vi.mocked(client.action).mockRejectedValueOnce(new Error('remote failed'));
    const gateway = new RscActionGateway({ locator, authorize: async () => true });
    await expect(gateway.invoke({
      pluginId: 'org.hile.fixture', buildId: 'build-a', actionId: 'operation-a', input: {},
    }, {})).rejects.toThrow('remote failed');
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('same-origin CSRF action policy', () => {
  it('requires an exact origin and delegates token validation', async () => {
    const verifyToken = vi.fn(async (token) => token === 'valid-token');
    const authorize = createSameOriginCsrfAuthorizer({
      expectedOrigin: 'https://host.test',
      readToken: (context) => context.headers?.['x-csrf-token'] as string | undefined,
      verifyToken,
    });
    const request = {
      pluginId: 'p', buildId: 'b', actionId: 'a', input: {},
    };

    await expect(authorize(request, {
      headers: { origin: 'https://host.test', 'x-csrf-token': 'valid-token' },
    })).resolves.toBe(true);
    await expect(authorize(request, {
      headers: { Origin: 'https://host.test', 'x-csrf-token': 'valid-token' },
    })).resolves.toBe(true);
    await expect(authorize(request, {
      headers: { origin: 'https://other.test', 'x-csrf-token': 'valid-token' },
    })).resolves.toBe(false);
    await expect(authorize(request, {
      headers: { origin: 'https://host.test' },
    })).resolves.toBe(false);
    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  it('supports request-scoped expected origins without accepting malformed origins', async () => {
    const authorize = createSameOriginCsrfAuthorizer({
      expectedOrigin: (context) => context.headers?.host ? `https://${context.headers.host}` : undefined,
      readToken: () => 'token',
      verifyToken: async () => true,
    });
    const request = { pluginId: 'p', buildId: 'b', actionId: 'a', input: {} };
    await expect(authorize(request, {
      headers: { host: 'host.test', origin: 'https://host.test' },
    })).resolves.toBe(true);
    await expect(authorize(request, {
      headers: { host: 'host.test', origin: 'not a url' },
    })).resolves.toBe(false);
  });
});

function context(method: string, requestPath: string): RscActionHttpContext & {
  headers: Map<string, string>;
} {
  const headers = new Map<string, string>();
  return {
    method,
    path: requestPath,
    status: 0,
    headers,
    set(name, value) { headers.set(name, value); },
  };
}

describe('RSC action HTTP adapter', () => {
  it('delegates unrelated paths and exposes only POST', async () => {
    const gateway = { invoke: vi.fn() };
    const middleware = createRscActionMiddleware({ gateway, readJson: vi.fn() });
    const next = vi.fn(async () => 'next');
    await expect(middleware(context('GET', '/outside'), next)).resolves.toBe('next');

    const wrongMethod = context('GET', '/_hile/rsc/actions/p/b/a');
    await middleware(wrongMethod, next);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('POST');
    expect(gateway.invoke).not.toHaveBeenCalled();
  });

  it('decodes route identities, delegates JSON parsing and returns a result', async () => {
    const gateway = { invoke: vi.fn(async () => ({ accepted: true })) };
    const readJson = vi.fn(async () => ({ input: { value: 'value' } }));
    const middleware = createRscActionMiddleware({
      gateway,
      mountPath: '/runtime-actions',
      bodyLimit: 256,
      readJson,
    });
    const ctx = context('POST', '/runtime-actions/org.hile%2Ffixture/build%20a/action%2Fa');
    const signal = new AbortController().signal;
    ctx.signal = signal;
    ctx.requestContext = { headers: { origin: 'https://host.test' } };

    await middleware(ctx, vi.fn());
    expect(readJson).toHaveBeenCalledWith(ctx, 256);
    expect(gateway.invoke).toHaveBeenCalledWith({
      pluginId: 'org.hile/fixture', buildId: 'build a', actionId: 'action/a', input: { value: 'value' },
    }, { signal, headers: { origin: 'https://host.test' } });
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ accepted: true });
    expect(ctx.type).toBe('application/json; charset=utf-8');
  });

  it.each([
    '/_hile/rsc/actions/p/b',
    '/_hile/rsc/actions/p/b/a/extra',
    '/_hile/rsc/actions/%E0%A4%A/b/a',
  ])('rejects malformed action routes without invoking the gateway: %s', async (requestPath) => {
    const gateway = { invoke: vi.fn() };
    const middleware = createRscActionMiddleware({ gateway, readJson: async () => ({ input: {} }) });
    const ctx = context('POST', requestPath);
    await middleware(ctx, vi.fn());
    expect(ctx.status).toBe(requestPath.includes('%E0') ? 400 : 404);
    expect(gateway.invoke).not.toHaveBeenCalled();
  });
});
