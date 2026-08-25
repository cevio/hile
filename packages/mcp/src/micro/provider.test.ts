import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  createInvocationContext,
  MissingExecutionContextError,
} from '@hile/context';
import { z } from 'zod';
import {
  createMcpEd25519InvocationCredentialSigner,
  createMcpEd25519InvocationCredentialVerifier,
  defineMcpPrompt,
  defineMcpProvider,
  defineMcpResource,
  defineMcpTool,
} from '../index.js';
import { attachMcpProvider } from './provider.js';

const trustedInvocation = { invocationSecurity: { mode: 'trusted-internal' as const } };
const executionContext = createExecutionContext({ requestId: 'mcp-provider-test' });
const invocation = createInvocationContext(executionContext, new AbortController().signal);

describe('attachMcpProvider', () => {
  it('requires an explicit internal invocation trust mode', async () => {
    const application = {
      namespace: 'orders-service', host: '127.0.0.1', port: 4100,
      register: vi.fn(), publish: vi.fn(), unpublish: vi.fn(async () => undefined),
    };
    await expect(attachMcpProvider(application, defineMcpProvider({ id: 'orders' }), undefined as any))
      .rejects.toThrow(/invocationSecurity/i);
    expect(application.register).not.toHaveBeenCalled();
  });

  it('does not publish when its single invocation operation cannot be registered', async () => {
    const application = {
      namespace: 'orders-service', host: '127.0.0.1', port: 4100,
      register: vi.fn(() => { throw new Error('duplicate route'); }),
      publish: vi.fn(),
      unpublish: vi.fn(async () => undefined),
    };

    await expect(attachMcpProvider(application, defineMcpProvider({ id: 'orders' }), trustedInvocation)).rejects.toThrow(/attach/i);
    expect(application.publish).not.toHaveBeenCalled();
  });

  it('uses an AsyncIterable operation compatible with application.stream for progress and result frames', async () => {
    const handlers = new Map<string, (input: any) => unknown>();
    const application = {
      namespace: 'orders-service', host: '127.0.0.1', port: 4100,
      register: vi.fn((operation: string, handler: (input: any) => unknown) => {
        handlers.set(operation, handler);
        return () => { handlers.delete(operation); };
      }),
      publish: vi.fn(async () => ({ unpublish: async () => undefined })),
      unpublish: vi.fn(async () => undefined),
    };
    const provider = defineMcpProvider({
      id: 'orders',
      tools: { lookup: defineMcpTool({
        name: 'lookup',
        inputSchema: z.object({}),
        access: {
          authorize: async (_principal, _input, context) => context.values.requestId === 'mcp-provider-test',
        },
      }, async (_input, context) => {
        expect(context.executionContext.values.requestId).toBe('mcp-provider-test');
        await context.emit.progress(1, 2, 'working');
        return { content: [{ type: 'text', text: 'done' }] };
      }) },
    });
    const attachment = await attachMcpProvider(application, provider, trustedInvocation);
    const data = {
      providerId: attachment.manifest.providerId,
      instanceId: attachment.manifest.instanceId,
      fingerprint: attachment.manifest.fingerprint,
      kind: 'tool' as const,
      name: 'lookup',
      input: {},
    };
    await expect(handlers.get('/-/mcp/invoke')!({ data }))
      .rejects.toBeInstanceOf(MissingExecutionContextError);
    const iterable = await handlers.get('/-/mcp/invoke')!({
      data,
      invocation,
    }) as AsyncIterable<unknown>;
    const frames = [];
    for await (const frame of iterable) frames.push(frame);

    expect(frames).toEqual([
      { type: 'progress', progress: 1, total: 2, message: 'working' },
      { type: 'result', result: { content: [{ type: 'text', text: 'done' }] } },
    ]);
    await attachment.close();
  });

  it('executes declared completion handlers with the verified principal', async () => {
    const handlers = new Map<string, (input: any) => unknown>();
    const application = {
      namespace: 'catalog-service', host: '127.0.0.1', port: 4100,
      register: vi.fn((operation: string, handler: (input: any) => unknown) => {
        handlers.set(operation, handler);
        return () => { handlers.delete(operation); };
      }),
      publish: vi.fn(async () => ({ unpublish: async () => undefined })),
      unpublish: vi.fn(async () => undefined),
    };
    const complete = vi.fn(async (_value, context) => [`${context.principal?.subject}:typescript`]);
    const attachment = await attachMcpProvider(application, defineMcpProvider({
      id: 'catalog',
      prompts: {
        review: defineMcpPrompt({
          name: 'review',
          argsSchema: z.object({ language: z.string() }),
          completions: { language: complete },
          access: { scopes: ['catalog:read'] },
        }, async () => ({ messages: [] })),
      },
    }), trustedInvocation);
    const iterable = await handlers.get('/-/mcp/complete')!({ data: {
      providerId: attachment.manifest.providerId,
      instanceId: attachment.manifest.instanceId,
      fingerprint: attachment.manifest.fingerprint,
      principal: { subject: 'user-1', scopes: ['catalog:read'] },
      kind: 'prompt',
      name: 'review',
      input: { argument: 'language', value: 'ty', context: { arguments: { framework: 'node' } } },
    }, invocation }) as AsyncIterable<any>;
    const frames = [];
    for await (const frame of iterable) frames.push(frame);

    expect(frames).toEqual([{ type: 'result', result: ['user-1:typescript'] }]);
    expect(complete).toHaveBeenCalledWith('ty', expect.objectContaining({
      principal: { subject: 'user-1', scopes: ['catalog:read'] },
      executionContext,
      arguments: { framework: 'node' },
    }));
    await attachment.close();
  });

  it('publishes resource update events with provider identity and expanded URIs', async () => {
    const update = vi.fn(async () => undefined);
    const unpublishManifest = vi.fn(async () => undefined);
    const unpublishUpdates = vi.fn(async () => undefined);
    const publish = vi.fn(async (topic: string) => topic === '@hile/mcp/resource-updates'
      ? { update, unpublish: unpublishUpdates }
      : { update: vi.fn(), unpublish: unpublishManifest });
    const application = {
      namespace: 'docs-service', host: '127.0.0.1', port: 4100,
      register: vi.fn(() => vi.fn()), publish, unpublish: vi.fn(async () => undefined),
    };
    const attachment = await attachMcpProvider(application, defineMcpProvider({
      id: 'docs',
      resources: {
        manual: defineMcpResource({ kind: 'static', name: 'manual', uri: 'hile://docs/manual' }, async uri => ({ contents: [{ uri: uri.toString(), text: 'manual' }] })),
        locale: defineMcpResource({ kind: 'template', name: 'locale', uriTemplate: 'hile://docs/{language}' }, async uri => ({ contents: [{ uri: String(uri), text: 'manual' }] })),
      },
    }), trustedInvocation);

    await attachment.notifyResourceUpdated('manual');
    await attachment.notifyResourceUpdated('locale', { language: 'zh-CN' });

    expect(publish).toHaveBeenCalledWith('@hile/mcp/resource-updates', expect.objectContaining({
      eventId: expect.any(String),
      providerId: 'docs',
      instanceId: attachment.manifest.instanceId,
      fingerprint: attachment.manifest.fingerprint,
      uri: 'hile://docs/manual',
    }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ uri: 'hile://docs/zh-CN' }));
    await attachment.close();
    expect(unpublishManifest).toHaveBeenCalledOnce();
    expect(unpublishUpdates).toHaveBeenCalledOnce();
  });

  it('registers one reusable operation set, publishes an instance manifest, and closes idempotently', async () => {
    const removers = [vi.fn(), vi.fn()];
    const register = vi.fn((_operation, _handler) => removers[register.mock.calls.length - 1]);
    const unpublish = vi.fn(async () => undefined);
    const publish = vi.fn(async () => ({ update: vi.fn(), unpublish }));
    const application = { namespace: 'orders-service', host: '127.0.0.1', port: 4100, register, publish, unpublish: vi.fn(async () => undefined) };
    const provider = defineMcpProvider({
      id: 'orders',
      tools: {
        lookup: defineMcpTool({ name: 'lookup', inputSchema: z.object({ id: z.string() }) }, async ({ id }) => ({
          content: [{ type: 'text', text: id }],
        })),
      },
    });

    const attachment = await attachMcpProvider(application, provider, trustedInvocation);
    expect(register.mock.calls.map(([operation]) => operation)).toEqual(['/-/mcp/invoke', '/-/mcp/complete']);
    expect(publish).toHaveBeenCalledWith(
      expect.stringMatching(/^@hile\/mcp\/providers\/orders\//),
      expect.objectContaining({ providerId: 'orders', instanceId: expect.any(String), namespace: 'orders-service' }),
    );

    await attachment.close();
    await attachment.close();
    expect(unpublish).toHaveBeenCalledTimes(1);
    expect(removers.every(remove => remove.mock.calls.length === 1)).toBe(true);
  });

  it('rolls registrations back when publication fails', async () => {
    const removers = [vi.fn(), vi.fn()];
    let index = 0;
    const application = {
      namespace: 'orders-service', host: '127.0.0.1', port: 4100,
      register: vi.fn(() => removers[index++]),
      publish: vi.fn(async () => { throw new Error('registry unavailable'); }),
      unpublish: vi.fn(async () => undefined),
    };
    const provider = defineMcpProvider({ id: 'orders' });

    await expect(attachMcpProvider(application, provider, trustedInvocation)).rejects.toThrow(/attach/i);
    expect(removers.every(remove => remove.mock.calls.length === 1)).toBe(true);
    expect(application.unpublish).toHaveBeenCalledWith(expect.stringMatching(/^@hile\/mcp\/providers\/orders\//));
  });

  it('serializes concurrent close and retries only failed cleanup phases', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const unpublish = vi.fn()
      .mockImplementationOnce(async () => { await blocked; throw new Error('temporary'); })
      .mockResolvedValue(undefined);
    const unregister = vi.fn();
    const application = {
      namespace: 'orders-service', host: '127.0.0.1', port: 4100,
      register: vi.fn(() => unregister),
      publish: vi.fn(async () => ({ unpublish })),
      unpublish: vi.fn(async () => undefined),
    };
    const attachment = await attachMcpProvider(application, defineMcpProvider({ id: 'orders' }), trustedInvocation);
    const first = attachment.close();
    const concurrent = attachment.close();
    release();
    await expect(Promise.all([first, concurrent])).rejects.toThrow(/close/i);
    expect(unpublish).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(0);

    await attachment.close();
    expect(unpublish).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledTimes(2);
  });

  it('dispatches multiple attachments by exact instance and keeps the shared route until the last close', async () => {
    const handlers = new Map<string, (input: any) => unknown>();
    const application = {
      namespace: 'commerce-service', host: '127.0.0.1', port: 4100,
      register: vi.fn((operation: string, handler: (input: any) => unknown) => {
        handlers.set(operation, handler);
        return () => { handlers.delete(operation); };
      }),
      publish: vi.fn(async () => ({ unpublish: async () => undefined })),
      unpublish: vi.fn(async () => undefined),
    };
    const makeProvider = (id: string) => defineMcpProvider({
      id,
      tools: { lookup: defineMcpTool({ name: 'lookup', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: id }] })) },
    });
    const orders = await attachMcpProvider(application, makeProvider('orders'), trustedInvocation);
    const payments = await attachMcpProvider(application, makeProvider('payments'), trustedInvocation);
    expect(application.register).toHaveBeenCalledTimes(2);

    const invoke = async (attachment: typeof orders) => {
      const iterable = await handlers.get('/-/mcp/invoke')!({ data: {
        providerId: attachment.manifest.providerId,
        instanceId: attachment.manifest.instanceId,
        fingerprint: attachment.manifest.fingerprint,
        kind: 'tool', name: 'lookup', input: {},
      }, invocation }) as AsyncIterable<any>;
      const frames = [];
      for await (const frame of iterable) frames.push(frame);
      return frames.at(-1)?.result;
    };
    await expect(invoke(orders)).resolves.toEqual({ content: [{ type: 'text', text: 'orders' }] });
    await expect(invoke(payments)).resolves.toEqual({ content: [{ type: 'text', text: 'payments' }] });
    await orders.close();
    expect(handlers.has('/-/mcp/invoke')).toBe(true);
    await expect(invoke(payments)).resolves.toEqual({ content: [{ type: 'text', text: 'payments' }] });
    await payments.close();
    expect(handlers.has('/-/mcp/invoke')).toBe(false);
    expect(handlers.has('/-/mcp/complete')).toBe(false);
  });

  it('rejects a forged direct principal and accepts only a bound invocation credential', async () => {
    const handlers = new Map<string, (input: any) => unknown>();
    const authority = generateKeyPairSync('ed25519');
    const signer = createMcpEd25519InvocationCredentialSigner({ privateKey: authority.privateKey });
    const verifier = createMcpEd25519InvocationCredentialVerifier({ publicKey: authority.publicKey });
    const invocationSecurity: { mode: 'credential' | 'trusted-internal'; credentials: typeof verifier } = {
      mode: 'credential', credentials: verifier,
    };
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'authorized' }] }));
    const application = {
      namespace: 'orders-service', host: '127.0.0.1', port: 4100,
      register: vi.fn((operation: string, invoke: (input: any) => unknown) => {
        handlers.set(operation, invoke);
        return () => { handlers.delete(operation); };
      }),
      publish: vi.fn(async () => ({ unpublish: async () => undefined })),
      unpublish: vi.fn(async () => undefined),
    };
    const attachment = await attachMcpProvider(application, defineMcpProvider({
      id: 'orders',
      tools: { lookup: defineMcpTool({ name: 'lookup', inputSchema: z.object({}), access: { scopes: ['orders:read'] } }, handler) },
    }), { invocationSecurity: invocationSecurity as { mode: 'credential'; credentials: typeof verifier } });
    invocationSecurity.mode = 'trusted-internal';
    const descriptor = {
      executionContext,
      providerId: attachment.manifest.providerId,
      instanceId: attachment.manifest.instanceId,
      fingerprint: attachment.manifest.fingerprint,
      kind: 'tool' as const,
      name: 'lookup',
      input: {},
    };
    const invoke = handlers.get('/-/mcp/invoke')!;

    await expect(invoke({
      data: { ...descriptor, principal: { subject: 'attacker', scopes: ['orders:read'] } },
      invocation,
    }))
      .rejects.toThrow(/credential/i);
    expect(handler).not.toHaveBeenCalled();

    const iterable = await invoke({
      data: {
        ...descriptor,
        credential: signer.create(descriptor, { subject: 'gateway-user', scopes: ['orders:read'] }),
      },
      invocation,
    }) as AsyncIterable<any>;
    const frames = [];
    for await (const frame of iterable) frames.push(frame);
    expect(frames.at(-1)?.result).toEqual({ content: [{ type: 'text', text: 'authorized' }] });
    expect(handler).toHaveBeenCalledTimes(1);
    await attachment.close();
  });
});
