import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UriTemplate, type Variables } from '@modelcontextprotocol/server';
import { HileMcpError } from '../errors.js';
import { normalizeMcpPrincipal } from '../principal.js';
import type { McpCapabilityAccess, McpInvocationContext, McpInvocationCredentialCodec, McpPrincipal, McpProviderDefinition } from '../types.js';
import { McpLoader } from './loader.js';
import { createMcpProviderManifest } from './manifest.js';
import { streamExecution } from './stream.js';
import {
  MCP_OPERATIONS,
  MCP_PROVIDER_TOPIC_PREFIX,
  MCP_RESOURCE_UPDATE_TOPIC,
  type HileMcpProviderApplication,
  type McpCapabilityKind,
  type McpProviderInput,
} from './types.js';

interface WireRequest { providerId: string; instanceId: string; fingerprint: string; kind: McpCapabilityKind; name: string; input: unknown; credential?: unknown; principal?: unknown; requestState?: unknown; inputResponses?: Record<string, unknown> }
interface TrustedWireRequest extends WireRequest { principal?: McpPrincipal }
interface CompletionInput { argument: string; value: string; context?: { arguments?: Record<string, string> } }

async function validate(schema: any, input: unknown) {
  const result = await schema['~standard'].validate(input);
  if (result.issues) {
    throw new HileMcpError('INVALID_DEFINITION', `Invalid MCP input: ${result.issues.map((issue: any) => issue.message).join('; ')}`);
  }
  return result.value;
}

async function authorize(access: McpCapabilityAccess<any> | undefined, principal: McpPrincipal | undefined, input: unknown) {
  const scopes = new Set(principal?.scopes ?? []);
  if (access?.scopes?.some(scope => !scopes.has(scope))) return false;
  return access?.authorize ? await access.authorize(principal, input) : true;
}

function trustedPrincipal(value: unknown): McpPrincipal | undefined {
  try { return normalizeMcpPrincipal(value); } catch (cause) {
    throw new HileMcpError('PROVIDER_UNAVAILABLE', 'Invalid trusted-internal MCP principal', { cause });
  }
}

function context(request: TrustedWireRequest, signal?: AbortSignal): McpInvocationContext {
  return {
    signal: signal ?? new AbortController().signal,
    principal: request.principal,
    requestState: request.requestState,
    inputResponses: request.inputResponses,
    emit: { progress: async () => undefined, log: async () => undefined },
  };
}

async function invokeCapability(provider: McpProviderDefinition, request: TrustedWireRequest, invocation: McpInvocationContext) {
  invocation.signal.throwIfAborted();
  if (request.kind === 'tool') {
    const capability = provider.tools[request.name];
    if (!capability) throw new HileMcpError('INVALID_DEFINITION', `Unknown MCP tool "${request.name}"`);
    const input = await validate(capability.config.inputSchema, request.input);
    invocation.signal.throwIfAborted();
    if (!await authorize(capability.config.access, request.principal, input)) throw new Error('MCP capability access denied');
    invocation.signal.throwIfAborted();
    return capability.handler(input, invocation);
  }
  if (request.kind === 'resource') {
    const capability = provider.resources[request.name];
    if (!capability) throw new HileMcpError('INVALID_DEFINITION', `Unknown MCP resource "${request.name}"`);
    const input = capability.config.kind === 'static' ? new URL(capability.config.uri) : request.input;
    if (!await authorize(capability.config.access, request.principal, input)) throw new Error('MCP capability access denied');
    invocation.signal.throwIfAborted();
    return capability.handler(input as never, invocation);
  }
  if (request.kind === 'prompt') {
    const capability = provider.prompts[request.name];
    if (!capability) throw new HileMcpError('INVALID_DEFINITION', `Unknown MCP prompt "${request.name}"`);
    const input = await validate(capability.config.argsSchema, request.input);
    invocation.signal.throwIfAborted();
    if (!await authorize(capability.config.access, request.principal, input)) throw new Error('MCP capability access denied');
    invocation.signal.throwIfAborted();
    return capability.handler(input, invocation);
  }
  throw new HileMcpError('INVALID_DEFINITION', 'Unknown MCP capability kind');
}

async function completeCapability(provider: McpProviderDefinition, request: TrustedWireRequest, invocation: McpInvocationContext) {
  const input = request.input as CompletionInput;
  if (!input || typeof input !== 'object' || typeof input.argument !== 'string' || typeof input.value !== 'string'
    || (input.context !== undefined && (!input.context || typeof input.context !== 'object' || Array.isArray(input.context)))
    || (input.context?.arguments !== undefined && (!input.context.arguments || typeof input.context.arguments !== 'object'
      || Array.isArray(input.context.arguments) || Object.values(input.context.arguments).some(value => typeof value !== 'string')))) {
    throw new HileMcpError('INVALID_DEFINITION', 'Invalid MCP completion input');
  }
  const capability = request.kind === 'prompt' ? provider.prompts[request.name]
    : request.kind === 'resource' ? provider.resources[request.name] : undefined;
  if (!capability) throw new HileMcpError('INVALID_DEFINITION', `Unknown MCP completion target "${request.name}"`);
  const resourceConfig = request.kind === 'resource' ? provider.resources[request.name]?.config : undefined;
  const complete = request.kind === 'prompt'
    ? provider.prompts[request.name]?.config.completions?.[input.argument]
    : resourceConfig?.kind === 'template' ? resourceConfig.completions?.[input.argument] : undefined;
  if (!complete) throw new HileMcpError('INVALID_DEFINITION', `Unknown MCP completion argument "${input.argument}"`);
  const scopes = new Set(request.principal?.scopes ?? []);
  if (capability.config.access?.scopes?.some(scope => !scopes.has(scope))) throw new Error('MCP capability access denied');
  invocation.signal.throwIfAborted();
  const suggestions = await complete(input.value, {
    signal: invocation.signal,
    principal: request.principal,
    arguments: input.context?.arguments,
  });
  invocation.signal.throwIfAborted();
  if (!Array.isArray(suggestions) || suggestions.some(value => typeof value !== 'string')) {
    throw new HileMcpError('INVALID_DEFINITION', 'MCP completion handler must return an array of strings');
  }
  return suggestions;
}

const providerHosts = new WeakMap<HileMcpProviderApplication, McpProviderHost>();

class McpProviderHost {
  private readonly providers = new Map<string, {
    provider: McpProviderDefinition;
    fingerprint: string;
    security: { mode: 'trusted-internal' } | { mode: 'credential'; credentials: Pick<McpInvocationCredentialCodec, 'verify'> };
  }>();
  private registered = true;
  private readonly unregisters: Array<() => void> = [];
  private resourceUpdatePublication?: Awaited<ReturnType<HileMcpProviderApplication['publish']>>;
  private resourceUpdateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly application: HileMcpProviderApplication) {
    const dispatch = async (data: unknown, signal: AbortSignal | undefined, execute: (
      provider: McpProviderDefinition,
      request: TrustedWireRequest,
      invocation: McpInvocationContext,
    ) => Promise<unknown>) => {
      const request = data as WireRequest;
      if (!request || typeof request !== 'object' || typeof request.providerId !== 'string' || typeof request.instanceId !== 'string'
        || !['tool', 'resource', 'prompt'].includes(request.kind) || typeof request.name !== 'string') {
        throw new HileMcpError('INVALID_DEFINITION', 'Invalid MCP invocation envelope');
      }
      const entry = this.providers.get(request.instanceId);
      if (!entry || entry.provider.id !== request.providerId || entry.fingerprint !== request.fingerprint) {
        throw new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP provider instance is unavailable');
      }
      const descriptor = {
        providerId: request.providerId, instanceId: request.instanceId, fingerprint: request.fingerprint,
        kind: request.kind, name: request.name, input: request.input,
      };
      signal?.throwIfAborted();
      const verifiedPrincipal = entry.security.mode === 'credential'
        ? await entry.security.credentials.verify(request.credential, descriptor, signal)
        : trustedPrincipal(request.principal);
      signal?.throwIfAborted();
      const trustedRequest = { ...request, principal: verifiedPrincipal };
      const base = context(trustedRequest, signal);
      return streamExecution(base, invocation => Promise.resolve(execute(entry.provider, trustedRequest, invocation)));
    };
    try {
      this.unregisters.push(application.register(MCP_OPERATIONS.invoke, ({ data, signal }) =>
        dispatch(data, signal, invokeCapability)));
      this.unregisters.push(application.register(MCP_OPERATIONS.complete, ({ data, signal }) =>
        dispatch(data, signal, completeCapability)));
    } catch (error) {
      for (const unregister of this.unregisters.splice(0).reverse()) unregister();
      throw error;
    }
  }

  add(instanceId: string, provider: McpProviderDefinition, fingerprint: string, security: { mode: 'trusted-internal' } | { mode: 'credential'; credentials: Pick<McpInvocationCredentialCodec, 'verify'> }) {
    this.providers.set(instanceId, { provider, fingerprint, security });
    let released = false;
    return async () => {
      if (released) return;
      if (this.providers.size === 1 && this.resourceUpdatePublication) {
        await this.resourceUpdateQueue;
        await this.resourceUpdatePublication.unpublish();
        this.resourceUpdatePublication = undefined;
      }
      this.providers.delete(instanceId);
      released = true;
      if (this.providers.size > 0 || !this.registered) return;
      for (const unregister of this.unregisters.splice(0).reverse()) unregister();
      this.registered = false;
      providerHosts.delete(this.application);
    };
  }

  notifyResourceUpdated(instanceId: string, name: string, variables?: Readonly<Variables>) {
    const entry = this.providers.get(instanceId);
    const capability = entry?.provider.resources[name];
    if (!entry || !capability) throw new HileMcpError('INVALID_DEFINITION', `Unknown MCP resource "${name}"`);
    let uri: string;
    if (capability.config.kind === 'static') {
      if (variables !== undefined) throw new HileMcpError('INVALID_DEFINITION', `Static MCP resource "${name}" does not accept variables`);
      uri = capability.config.uri;
    } else {
      if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
        throw new HileMcpError('INVALID_DEFINITION', `Template MCP resource "${name}" requires variables`);
      }
      uri = new UriTemplate(capability.config.uriTemplate).expand(variables as Variables);
    }
    const update = {
      eventId: randomUUID(), providerId: entry.provider.id, instanceId, fingerprint: entry.fingerprint, uri,
    };
    const publish = async () => {
      if (!this.providers.has(instanceId)) throw new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP provider attachment is closed');
      if (this.resourceUpdatePublication) await this.resourceUpdatePublication.update(update);
      else this.resourceUpdatePublication = await this.application.publish(MCP_RESOURCE_UPDATE_TOPIC, update);
    };
    const pending = this.resourceUpdateQueue.then(publish, publish);
    this.resourceUpdateQueue = pending.catch(() => undefined);
    return pending;
  }
}

function acquireProviderHost(application: HileMcpProviderApplication) {
  let host = providerHosts.get(application);
  if (!host) {
    host = new McpProviderHost(application);
    providerHosts.set(application, host);
  }
  return host;
}

export interface McpProviderAttachment {
  readonly provider: McpProviderDefinition;
  readonly manifest: ReturnType<typeof createMcpProviderManifest>;
  notifyResourceUpdated(name: string, variables?: Readonly<Variables>): Promise<void>;
  close(): Promise<void>;
}

class McpProviderAttachmentRuntime implements McpProviderAttachment {
  private unpublishPending = true;
  private unregisterPending = true;
  private unloadPending = true;
  private closing?: Promise<void>;

  constructor(
    readonly provider: McpProviderDefinition,
    readonly manifest: ReturnType<typeof createMcpProviderManifest>,
    private readonly unpublish: () => Promise<unknown>,
    private readonly unregister: () => Promise<void> | void,
    private readonly unload: () => void,
    private readonly notify: (name: string, variables?: Readonly<Variables>) => Promise<void>,
  ) {}

  notifyResourceUpdated(name: string, variables?: Readonly<Variables>) {
    if (this.closing || !this.unpublishPending) return Promise.reject(new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP provider attachment is closing'));
    return this.notify(name, variables);
  }

  close() {
    if (!this.closing) this.closing = this.performClose().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async performClose() {
    const errors: unknown[] = [];
    if (this.unpublishPending) {
      try { await this.unpublish(); this.unpublishPending = false; } catch (error) { errors.push(error); }
    }
    if (this.unpublishPending) {
      if (errors.length) throw new AggregateError(errors, 'Failed to close MCP provider attachment');
    }
    if (this.unregisterPending) {
      try { await this.unregister(); this.unregisterPending = false; } catch (error) { errors.push(error); }
    }
    if (this.unloadPending) {
      try { this.unload(); this.unloadPending = false; } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to close MCP provider attachment');
  }
}

export async function attachMcpProvider(
  application: HileMcpProviderApplication,
  input: McpProviderInput,
  options: { invocationSecurity: { mode: 'trusted-internal' } | { mode: 'credential'; credentials: Pick<McpInvocationCredentialCodec, 'verify'> } },
): Promise<McpProviderAttachment> {
  if (!options?.invocationSecurity || !['trusted-internal', 'credential'].includes(options.invocationSecurity.mode)
    || (options.invocationSecurity.mode === 'credential' && typeof options.invocationSecurity.credentials?.verify !== 'function')) {
    throw new TypeError('MCP provider invocationSecurity must be explicit');
  }
  const invocationSecurity = options.invocationSecurity.mode === 'credential'
    ? Object.freeze({
      mode: 'credential' as const,
      credentials: Object.freeze({ verify: options.invocationSecurity.credentials.verify.bind(options.invocationSecurity.credentials) }),
    })
    : Object.freeze({ mode: 'trusted-internal' as const });
  let unload: () => void = () => undefined;
  let unregister: (() => Promise<void> | void) | undefined;
  let publication: Awaited<ReturnType<HileMcpProviderApplication['publish']>> | undefined;
  let topic: string | undefined;
  try {
    let provider: McpProviderDefinition;
    if ('directory' in input) {
      const loader = new McpLoader({ id: input.id, displayName: input.displayName });
      const loaded = await loader.loadProvider(input.directory instanceof URL ? fileURLToPath(input.directory) : input.directory);
      provider = loaded.provider;
      unload = loaded.unload;
    } else provider = input;
    if (!application.port) throw new Error('Application must be listening before attaching an MCP provider');
    const instanceId = randomUUID();
    const manifest = createMcpProviderManifest(provider, {
      instanceId,
      namespace: application.namespace,
      address: { host: application.host, port: application.port },
    });
    const host = acquireProviderHost(application);
    unregister = host.add(instanceId, provider, manifest.fingerprint, invocationSecurity);
    topic = `${MCP_PROVIDER_TOPIC_PREFIX}${provider.id}/${instanceId}`;
    publication = await application.publish(topic, manifest);
    return new McpProviderAttachmentRuntime(
      provider, manifest, () => publication!.unpublish(), unregister, unload,
      (name, variables) => host.notifyResourceUpdated(instanceId, name, variables),
    );
  } catch (cause) {
    const errors = [cause];
    if (publication) try { await publication.unpublish(); } catch (error) { errors.push(error); }
    else if (topic) try { await application.unpublish(topic); } catch (error) { errors.push(error); }
    if (unregister) try { await unregister(); } catch (error) { errors.push(error); }
    try { unload(); } catch (error) { errors.push(error); }
    throw new HileMcpError('PROVIDER_ATTACH_FAILED', 'Failed to attach MCP provider', {
      cause: errors.length === 1 ? cause : new AggregateError(errors, 'MCP provider attachment rollback failed'),
    });
  }
}
