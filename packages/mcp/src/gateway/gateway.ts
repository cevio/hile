import { parseExecutionContext, type ExecutionContext } from '@hile/context';
import {
  McpServer,
  ResourceTemplate,
  completable,
  fromJsonSchema,
  specTypeSchemas,
  type AuthInfo,
  type Annotations,
  type Icon,
  type Implementation,
  type McpRequestContext,
  type ServerOptions,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { HileMcpError } from '../errors.js';
import { compareText } from '../ordering.js';
import { hasMcpScopes } from '../scopes.js';
import { parseMcpProviderManifest } from '../micro/manifest.js';
import { MCP_OPERATIONS, type McpCapabilityKind, type McpManifestCapability, type McpProviderManifest, type McpProviderSource, type McpResourceUpdate } from '../micro/types.js';
import type { McpInvocationCredentialCodec, McpPrincipal } from '../types.js';

export interface McpGatewayInspection {
  providers: Array<{ providerId: string; status: 'ready' | 'conflict'; instanceCount: number; fingerprints: readonly string[]; conflicts: readonly string[] }>;
  tools: string[];
  resources: string[];
  prompts: string[];
}

export interface McpGateway {
  inspect(): McpGatewayInspection;
  close(): Promise<void>;
}

export interface CreateMcpGatewayOptions {
  source: McpProviderSource;
  /** Resolves the explicit Hile execution context owned by the ingress/runtime. */
  executionContext: (request: McpRequestContext) => ExecutionContext;
  info: Implementation;
  instructions?: string;
  cacheHints?: ServerOptions['cacheHints'];
  naming?: { separator?: '.' | '-' | '_'; aliases?: Readonly<Record<string, string>> };
  startup?: 'allow-empty' | 'require-provider';
  /** Optional integrity verifier for client-echoed requestState. Unverified state remains typed as unknown. */
  requestState?: ServerOptions['requestState'];
  invocationSecurity:
    | { mode: 'trusted-internal' }
    | { mode: 'credential'; credentials: Pick<McpInvocationCredentialCodec, 'create'> };
  isCapabilityExposed?: (capability: McpGatewayCapability, principal: McpPrincipal | undefined) => boolean;
  onError?: (error: unknown) => void;
}

export interface McpGatewayCapability {
  providerId: string;
  kind: McpCapabilityKind;
  localName: string;
  publicName: string;
  scopes: readonly string[];
}

interface CatalogEntry extends McpGatewayCapability {
  manifest: McpProviderManifest;
  capability: McpManifestCapability;
  view: McpGatewayCapability;
  inputSchema?: ReturnType<typeof fromJsonSchema>;
  outputSchema?: ReturnType<typeof fromJsonSchema>;
  resourceTemplate?: ResourceTemplate;
}
interface CatalogState {
  groups: Map<string, McpProviderManifest[]>;
  conflicts: Map<string, Set<string>>;
  tools: CatalogEntry[];
  resources: CatalogEntry[];
  prompts: CatalogEntry[];
}
interface LiveProjection {
  server: McpServer;
  executionContext: ExecutionContext;
  authInfo?: AuthInfo;
  principal?: McpPrincipal;
  era: 'legacy' | 'modern';
  http: boolean;
  resourceSubscriptions: Set<string>;
  handles: Array<{ remove(): void }>;
  names: { tools: string; resources: string; prompts: string };
}
export interface McpGatewayCatalogChange {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
  resourceUpdates: readonly string[];
}
const GATEWAY_RUNTIME = Symbol('hile.mcp.gateway.runtime');
const gatewayFactories = new WeakMap<McpGateway, (context: McpRequestContext) => McpServer>();
const gatewayChangeSubscriptions = new WeakMap<McpGateway, (listener: (change: McpGatewayCatalogChange) => void) => () => void>();

function principal(authInfo: AuthInfo | undefined): McpPrincipal | undefined {
  if (!authInfo) return undefined;
  return {
    subject: authInfo.clientId,
    clientId: authInfo.clientId,
    scopes: Object.freeze([...(authInfo.scopes ?? [])]),
    claims: authInfo.extra ? Object.freeze({ ...authInfo.extra }) : undefined,
  };
}

function cloneIcons(icons: readonly Icon[] | undefined): Icon[] | undefined {
  return icons?.map(icon => ({ ...icon, sizes: icon.sizes ? [...icon.sizes] : undefined }));
}

function cloneMeta(meta: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
  return meta ? structuredClone(meta) : undefined;
}

function promptSchemaWithCompletions(
  schema: Readonly<Record<string, unknown>>,
  argumentsToComplete: readonly string[] | undefined,
  complete: (argument: string, value: string, context?: { arguments?: Record<string, string> }) => Promise<string[]>,
) {
  const base = fromJsonSchema(schema);
  if (!argumentsToComplete?.length) return base;
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, Record<string, unknown>>
    : {};
  const selected = new Set(argumentsToComplete);
  const shape = Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    const field = fromJsonSchema(property);
    return [name, selected.has(name) ? completable(field, (value, context) => complete(name, String(value), context)) : field];
  }));
  return Object.assign(Object.create(base), { shape }) as typeof base;
}

export class McpGatewayRuntime implements McpGateway {
  private instances: readonly McpProviderManifest[] = [];
  private unsubscribe: () => void = () => undefined;
  private unsubscribeResourceUpdates: () => void = () => undefined;
  private closed = false;
  private closing?: Promise<void>;
  private unsubscribePending = true;
  private unsubscribeResourceUpdatesPending = true;
  private sourceClosePending = true;
  private readonly lifecycle = new AbortController();
  private readonly activeInvocations = new Set<Promise<unknown>>();
  private readonly liveProjections = new Set<LiveProjection>();
  private readonly catalogListeners = new Set<(change: McpGatewayCatalogChange) => void>();
  private readonly cursor = new Map<string, number>();
  private catalogState: CatalogState = { groups: new Map(), conflicts: new Map(), tools: [], resources: [], prompts: [] };

  constructor(private readonly options: CreateMcpGatewayOptions) {}

  async start() {
    await this.options.source.start();
    this.replaceInstances(this.options.source.snapshot());
    if (this.options.startup === 'require-provider' && this.instances.length === 0) {
      throw new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP gateway requires at least one provider');
    }
    this.unsubscribe = this.options.source.subscribe(instances => { this.replaceInstances(instances); });
    this.unsubscribeResourceUpdates = this.options.source.subscribeResourceUpdates(update => { this.handleResourceUpdate(update); });
  }

  private replaceInstances(instances: readonly McpProviderManifest[]) {
    const previous = this.catalogState;
    this.instances = this.validInstances(instances);
    this.catalogState = this.buildCatalog();
    for (const projection of this.liveProjections) this.project(projection, true);
    const signature = (entries: CatalogEntry[]) => entries
      .map(item => `${item.publicName}:${item.manifest.fingerprint}:${item.capability.name}`)
      .join('\0');
    const change = {
      tools: signature(previous.tools) !== signature(this.catalogState.tools),
      resources: signature(previous.resources) !== signature(this.catalogState.resources),
      prompts: signature(previous.prompts) !== signature(this.catalogState.prompts),
      resourceUpdates: [],
    };
    if (change.tools || change.resources || change.prompts) {
      for (const listener of this.catalogListeners) {
        try { listener(change); } catch (error) { this.report(error); }
      }
    }
  }

  private handleResourceUpdate(update: McpResourceUpdate) {
    const entry = this.catalogState.resources.find(item => item.providerId === update.providerId
      && item.manifest.fingerprint === update.fingerprint
      && (item.capability.uri === update.uri || !!item.resourceTemplate?.uriTemplate.match(update.uri)));
    if (!entry || !this.catalogState.groups.get(update.providerId)?.some(instance => instance.instanceId === update.instanceId
      && instance.fingerprint === update.fingerprint)) return;
    for (const projection of this.liveProjections) {
      if (!projection.http && this.visible(entry, projection.principal)
        && (projection.era === 'modern' || projection.resourceSubscriptions.has(update.uri))) {
        void projection.server.server.sendResourceUpdated({ uri: update.uri }).catch(error => this.report(error));
      }
    }
    const change: McpGatewayCatalogChange = { tools: false, resources: false, prompts: false, resourceUpdates: [update.uri] };
    for (const listener of this.catalogListeners) {
      try { listener(change); } catch (error) { this.report(error); }
    }
  }

  subscribeCatalogChanges(listener: (change: McpGatewayCatalogChange) => void) {
    if (this.closed) throw new HileMcpError('GATEWAY_CLOSED', 'MCP gateway is closed');
    this.catalogListeners.add(listener);
    return () => { this.catalogListeners.delete(listener); };
  }

  private report(error: unknown) {
    try { this.options.onError?.(error); } catch { /* diagnostics must not break routing */ }
  }

  private validInstances(instances: readonly McpProviderManifest[]) {
    return instances.flatMap(instance => {
      const parsed = parseMcpProviderManifest(instance);
      return parsed ? [parsed] : [];
    });
  }

  private groups() {
    const groups = new Map<string, McpProviderManifest[]>();
    for (const instance of this.instances) {
      const group = groups.get(instance.providerId) ?? [];
      group.push(instance);
      groups.set(instance.providerId, group);
    }
    for (const group of groups.values()) group.sort((a, b) => compareText(a.instanceId, b.instanceId));
    return groups;
  }

  private name(providerId: string, localName: string) {
    const prefix = this.options.naming?.aliases?.[providerId] ?? providerId;
    const name = `${prefix}${this.options.naming?.separator ?? '.'}${localName}`;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new HileMcpError('CATALOG_CONFLICT', `Invalid public MCP name "${name}"`);
    return name;
  }

  private buildCatalog(): CatalogState {
    const groups = this.groups();
    const conflicts = new Map<string, Set<string>>();
    const conflict = (providerId: string, reason: string) => {
      const reasons = conflicts.get(providerId) ?? new Set<string>();
      reasons.add(reason);
      conflicts.set(providerId, reasons);
    };
    const tools: CatalogEntry[] = [], resources: CatalogEntry[] = [], prompts: CatalogEntry[] = [];
    for (const [providerId, instances] of groups) {
      if (new Set(instances.map(item => item.fingerprint)).size !== 1) {
        conflict(providerId, 'instances publish different capability fingerprints');
        continue;
      }
      const manifest = instances[0];
      const add = (kind: McpCapabilityKind, capability: McpManifestCapability, target: CatalogEntry[]) => {
        try {
          const publicName = this.name(providerId, capability.name);
          const scopes = capability.scopes ?? [];
          const view = Object.freeze({ providerId, kind, localName: capability.name, publicName, scopes });
          target.push({
            manifest, capability, providerId, kind, localName: capability.name, publicName, scopes, view,
            inputSchema: kind === 'tool' || kind === 'prompt' ? fromJsonSchema(capability.inputSchema ?? { type: 'object' }) : undefined,
            outputSchema: kind === 'tool' && capability.outputSchema ? fromJsonSchema(capability.outputSchema) : undefined,
            resourceTemplate: kind === 'resource' && capability.uriTemplate
              ? new ResourceTemplate(capability.uriTemplate, { list: undefined })
              : undefined,
          });
        } catch (error) {
          conflict(providerId, error instanceof Error ? error.message : 'invalid public capability name');
        }
      };
      for (const capability of manifest.capabilities.tools) add('tool', capability, tools);
      for (const capability of manifest.capabilities.resources) add('resource', capability, resources);
      for (const capability of manifest.capabilities.prompts) add('prompt', capability, prompts);
    }
    const markDuplicates = (entries: CatalogEntry[], key: (entry: CatalogEntry) => string, label: string) => {
      const owners = new Map<string, string[]>();
      for (const entry of entries) {
        const itemOwners = owners.get(key(entry)) ?? [];
        itemOwners.push(entry.providerId);
        owners.set(key(entry), itemOwners);
      }
      for (const [value, providerIds] of owners) {
        if (providerIds.length < 2) continue;
        for (const providerId of new Set(providerIds)) conflict(providerId, `${label} conflict: ${value}`);
      }
    };
    markDuplicates(tools, entry => entry.publicName, 'tool name');
    markDuplicates(resources, entry => entry.publicName, 'resource name');
    markDuplicates(prompts, entry => entry.publicName, 'prompt name');
    markDuplicates(resources, entry => entry.capability.uri ?? entry.capability.uriTemplate ?? '', 'resource URI');
    const byName = (a: CatalogEntry, b: CatalogEntry) => compareText(a.publicName, b.publicName);
    const ready = (entry: CatalogEntry) => !conflicts.has(entry.providerId);
    return {
      groups,
      conflicts,
      tools: tools.filter(ready).sort(byName),
      resources: resources.filter(ready).sort(byName),
      prompts: prompts.filter(ready).sort(byName),
    };
  }

  private catalog(): CatalogState { return this.catalogState; }

  inspect(): McpGatewayInspection {
    const catalog = this.catalog();
    return {
      providers: [...catalog.groups].sort(([a], [b]) => compareText(a, b)).map(([providerId, instances]) => {
        const fingerprints = [...new Set(instances.map(item => item.fingerprint))].sort();
        const conflicts = [...(catalog.conflicts.get(providerId) ?? [])].sort();
        return { providerId, status: conflicts.length === 0 ? 'ready' as const : 'conflict' as const, instanceCount: instances.length, fingerprints, conflicts };
      }),
      tools: catalog.tools.map(item => item.publicName),
      resources: catalog.resources.map(item => item.publicName),
      prompts: catalog.prompts.map(item => item.publicName),
    };
  }

  private select(entry: CatalogEntry) {
    const providerId = entry.providerId;
    const instances = this.catalogState.groups.get(providerId) ?? [];
    if (!instances.length) throw new HileMcpError('PROVIDER_UNAVAILABLE', `MCP provider "${providerId}" is unavailable`);
    const fingerprints = new Set(instances.map(instance => instance.fingerprint));
    if (fingerprints.size !== 1 || !fingerprints.has(entry.manifest.fingerprint)) {
      throw new HileMcpError('CATALOG_CONFLICT', `MCP provider "${providerId}" changed during invocation`);
    }
    const key = `${providerId}/${entry.manifest.fingerprint}`;
    const next = this.cursor.get(key) ?? 0;
    this.cursor.set(key, next + 1);
    return instances[next % instances.length];
  }

  private visible(entry: CatalogEntry, currentPrincipal: McpPrincipal | undefined) {
    if (!hasMcpScopes(currentPrincipal?.scopes, entry.scopes)) return false;
    return this.options.isCapabilityExposed?.(entry.view, currentPrincipal) ?? true;
  }

  private invoke(entry: CatalogEntry, input: unknown, authInfo: AuthInfo | undefined, ctx: ServerContext, executionContext: ExecutionContext) {
    if (this.closed) return Promise.reject(new HileMcpError('GATEWAY_CLOSED', 'MCP gateway is closed'));
    const invocation = this.invokeActive(entry, input, authInfo, ctx, executionContext);
    this.activeInvocations.add(invocation);
    void invocation.finally(() => { this.activeInvocations.delete(invocation); }).catch(() => undefined);
    return invocation;
  }

  private complete(
    entry: CatalogEntry,
    argument: string,
    value: string,
    context: { arguments?: Record<string, string> } | undefined,
    authInfo: AuthInfo | undefined,
    executionContext: ExecutionContext,
  ) {
    if (this.closed) return Promise.reject(new HileMcpError('GATEWAY_CLOSED', 'MCP gateway is closed'));
    const completion = this.completeActive(entry, argument, value, context, authInfo, executionContext);
    this.activeInvocations.add(completion);
    void completion.finally(() => { this.activeInvocations.delete(completion); }).catch(() => undefined);
    return completion;
  }

  private async completeActive(
    entry: CatalogEntry,
    argument: string,
    value: string,
    context: { arguments?: Record<string, string> } | undefined,
    authInfo: AuthInfo | undefined,
    executionContext: ExecutionContext,
  ) {
    const signal = this.lifecycle.signal;
    signal.throwIfAborted();
    const instance = this.select(entry);
    const input = { argument, value, context };
    const descriptor = {
      executionContext,
      providerId: entry.providerId,
      instanceId: instance.instanceId,
      fingerprint: entry.manifest.fingerprint,
      kind: entry.kind,
      name: entry.capability.name,
      input,
    };
    const request = {
      ...descriptor,
      input,
      principal: this.options.invocationSecurity.mode === 'trusted-internal' ? principal(authInfo) : undefined,
      credential: this.options.invocationSecurity.mode === 'credential'
        ? await this.options.invocationSecurity.credentials.create(descriptor, principal(authInfo), signal)
        : undefined,
    };
    const stream = await this.options.source.stream(instance, MCP_OPERATIONS.complete, request, {
      context: executionContext,
      signal,
    });
    let result: unknown;
    let completed = false;
    for await (const frame of stream) {
      if ((frame as any)?.type !== 'result' || completed) {
        throw new HileMcpError('PROVIDER_UNAVAILABLE', `MCP completion for "${entry.publicName}" emitted an invalid frame`);
      }
      result = (frame as any).result;
      completed = true;
    }
    if (!completed || !Array.isArray(result) || result.some(item => typeof item !== 'string')) {
      throw new HileMcpError('PROVIDER_UNAVAILABLE', `MCP completion for "${entry.publicName}" returned invalid suggestions`);
    }
    return result;
  }

  private async invokeActive(entry: CatalogEntry, input: unknown, authInfo: AuthInfo | undefined, ctx: ServerContext, executionContext: ExecutionContext) {
    const retries = entry.capability.execution?.retry === 'idempotent-failover' ? 1 : 0;
    const signal = AbortSignal.any([ctx.mcpReq.signal, this.lifecycle.signal]);
    const request = {
      providerId: entry.providerId,
      instanceId: undefined as string | undefined,
      fingerprint: entry.manifest.fingerprint,
      credential: undefined as unknown,
      principal: this.options.invocationSecurity.mode === 'trusted-internal' ? principal(authInfo) : undefined,
      kind: entry.kind,
      name: entry.capability.name,
      input,
      inputResponses: ctx.mcpReq.inputResponses,
      requestState: ctx.mcpReq.requestState(),
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      let completed = false;
      try {
        const instance = this.select(entry);
        request.instanceId = instance.instanceId;
        request.credential = this.options.invocationSecurity.mode === 'credential'
          ? await this.options.invocationSecurity.credentials.create({
          executionContext,
          providerId: entry.providerId,
          instanceId: instance.instanceId,
          fingerprint: entry.manifest.fingerprint,
          kind: entry.kind,
          name: entry.capability.name,
          input,
          }, principal(authInfo), signal)
          : undefined;
        const stream = await this.options.source.stream(instance, MCP_OPERATIONS.invoke, request, {
          context: executionContext,
          timeout: entry.capability.execution?.timeoutMs,
          signal,
        });
        let result: unknown;
        for await (const value of stream) {
          const frame = value as any;
          if (completed) throw new HileMcpError('PROVIDER_UNAVAILABLE', `MCP ${entry.kind} "${entry.publicName}" emitted frames after its result`);
          if (frame?.type === 'progress') {
            if (!Number.isFinite(frame.progress) || (frame.total !== undefined && !Number.isFinite(frame.total))) {
              throw new HileMcpError('PROVIDER_UNAVAILABLE', `MCP ${entry.kind} "${entry.publicName}" emitted an invalid progress frame`);
            }
            const progressToken = (ctx.mcpReq._meta as any)?.progressToken;
            if (progressToken !== undefined) {
              try {
                await ctx.mcpReq.notify({ method: 'notifications/progress', params: {
                  progressToken, progress: frame.progress, total: frame.total, message: frame.message,
                } } as any);
              } catch (cause) {
                throw new HileMcpError('PROVIDER_UNAVAILABLE', 'Failed to deliver MCP progress notification', { cause });
              }
            }
          } else if (frame?.type === 'log') {
            if (!['debug', 'info', 'notice', 'warning', 'error'].includes(frame.level)) {
              throw new HileMcpError('PROVIDER_UNAVAILABLE', `MCP ${entry.kind} "${entry.publicName}" emitted an invalid log frame`);
            }
            try { await ctx.mcpReq.log(frame.level, frame.data); } catch (cause) {
              throw new HileMcpError('PROVIDER_UNAVAILABLE', 'Failed to deliver MCP log notification', { cause });
            }
          } else if (frame?.type === 'result') {
            result = frame.result;
            completed = true;
          } else throw new HileMcpError('PROVIDER_UNAVAILABLE', `MCP ${entry.kind} "${entry.publicName}" emitted an unknown frame`);
        }
        if (!completed) throw new Error(`MCP ${entry.kind} "${entry.publicName}" stream ended without a result`);
        return result as any;
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (completed || attempt === retries || error instanceof HileMcpError) throw error;
      }
    }
    throw new HileMcpError('PROVIDER_UNAVAILABLE', `MCP ${entry.kind} "${entry.publicName}" failed without an error`);
  }

  [GATEWAY_RUNTIME](request: McpRequestContext) {
    if (this.closed) throw new HileMcpError('GATEWAY_CLOSED', 'MCP gateway is closed');
    const server = new McpServer(this.options.info, {
      instructions: this.options.instructions,
      requestState: this.options.requestState,
      cacheHints: this.options.cacheHints,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
      },
    });
    const projection: LiveProjection = {
      server,
      executionContext: parseExecutionContext(this.options.executionContext(request)),
      authInfo: request.authInfo,
      principal: principal(request.authInfo),
      era: request.era ?? 'legacy',
      http: request.requestInfo !== undefined,
      resourceSubscriptions: new Set(),
      handles: [],
      names: { tools: '', resources: '', prompts: '' },
    };
    if (projection.era === 'legacy') {
      server.server.setRequestHandler('resources/subscribe', request => {
        projection.resourceSubscriptions.add(request.params.uri);
        return {};
      });
      server.server.setRequestHandler('resources/unsubscribe', request => {
        projection.resourceSubscriptions.delete(request.params.uri);
        return {};
      });
    }
    this.project(projection, false);
    this.liveProjections.add(projection);
    const detach = () => {
      this.liveProjections.delete(projection);
      projection.resourceSubscriptions.clear();
    };
    const lowLevelClose = server.server.onclose;
    server.server.onclose = () => {
      detach();
      lowLevelClose?.();
    };
    const close = server.close.bind(server);
    server.close = async () => {
      detach();
      projection.handles.length = 0;
      await close();
    };
    return server;
  }

  private project(projection: LiveProjection, notify: boolean) {
    const previous = projection.names;
    let tools: CatalogEntry[], resources: CatalogEntry[], prompts: CatalogEntry[];
    let next: LiveProjection['names'];
    try {
      const catalog = this.catalog();
      tools = catalog.tools.filter(item => this.visible(item, projection.principal));
      resources = catalog.resources.filter(item => this.visible(item, projection.principal));
      prompts = catalog.prompts.filter(item => this.visible(item, projection.principal));
      const signature = (entries: CatalogEntry[]) => entries
        .map(item => `${item.publicName}:${item.manifest.fingerprint}:${item.capability.name}`)
        .join('\0');
      next = { tools: signature(tools), resources: signature(resources), prompts: signature(prompts) };
    } catch (error) {
      this.report(error);
      return;
    }
    if (previous.tools === next.tools && previous.resources === next.resources && previous.prompts === next.prompts) return;
    const notificationMethods = {
      tools: projection.server.sendToolListChanged,
      resources: projection.server.sendResourceListChanged,
      prompts: projection.server.sendPromptListChanged,
    };
    projection.server.sendToolListChanged = () => undefined;
    projection.server.sendResourceListChanged = () => undefined;
    projection.server.sendPromptListChanged = () => undefined;
    for (const handle of projection.handles.splice(0)) {
      try { handle.remove(); } catch (error) { this.report(error); }
    }
    try {
      for (const entry of tools) {
        projection.handles.push(projection.server.registerTool(entry.publicName, {
        title: entry.capability.title, description: entry.capability.description,
        inputSchema: entry.inputSchema!,
        outputSchema: entry.outputSchema,
        annotations: entry.capability.annotations as any,
        icons: cloneIcons(entry.capability.icons),
        _meta: cloneMeta(entry.capability._meta),
        }, (input, ctx) => this.invoke(entry, input, projection.authInfo, ctx, projection.executionContext)));
      }
      for (const entry of resources) {
        const config = {
          title: entry.capability.title,
          description: entry.capability.description,
          mimeType: entry.capability.mimeType,
          icons: cloneIcons(entry.capability.icons),
          size: entry.capability.size,
          annotations: entry.capability.annotations ? structuredClone(entry.capability.annotations) as Annotations : undefined,
          _meta: cloneMeta(entry.capability._meta),
          cacheHint: entry.capability.cacheHint ? { ...entry.capability.cacheHint } : undefined,
        };
        if (entry.capability.uri) {
          projection.handles.push(projection.server.registerResource(entry.publicName, entry.capability.uri, config, (uri, ctx) =>
            this.invoke(entry, uri.toString(), projection.authInfo, ctx, projection.executionContext)));
        } else if (entry.capability.uriTemplate) {
          const completionArguments = entry.capability.completionArguments ?? [];
          const template = completionArguments.length ? new ResourceTemplate(entry.capability.uriTemplate, {
            list: undefined,
            complete: Object.fromEntries(completionArguments.map(argument => [argument, (value: string, context?: { arguments?: Record<string, string> }) =>
              this.complete(entry, argument, value, context, projection.authInfo, projection.executionContext)])),
          }) : entry.resourceTemplate!;
          projection.handles.push(projection.server.registerResource(entry.publicName, template, config, (_uri, variables, ctx) =>
            this.invoke(entry, variables, projection.authInfo, ctx, projection.executionContext)));
        }
      }
      for (const entry of prompts) {
        const argsSchema = promptSchemaWithCompletions(
          entry.capability.inputSchema ?? { type: 'object' },
          entry.capability.completionArguments,
          (argument, value, context) => this.complete(entry, argument, value, context, projection.authInfo, projection.executionContext),
        );
        projection.handles.push(projection.server.registerPrompt(entry.publicName, {
          title: entry.capability.title, description: entry.capability.description,
          argsSchema,
          icons: cloneIcons(entry.capability.icons),
          _meta: cloneMeta(entry.capability._meta),
        }, (input, ctx) => this.invoke(entry, input, projection.authInfo, ctx, projection.executionContext)));
      }
      projection.names = next;
    } catch (error) {
      for (const handle of projection.handles.splice(0)) {
        try { handle.remove(); } catch (cleanupError) { this.report(cleanupError); }
      }
      projection.names = { tools: '', resources: '', prompts: '' };
      this.report(error);
    } finally {
      projection.server.sendToolListChanged = notificationMethods.tools;
      projection.server.sendResourceListChanged = notificationMethods.resources;
      projection.server.sendPromptListChanged = notificationMethods.prompts;
    }
    if (notify && !projection.http) {
      const notifyChanged = (changed: boolean, send: () => Promise<void>) => {
        if (changed) void send().catch(error => this.report(error));
      };
      notifyChanged(previous.tools !== projection.names.tools, () => projection.server.server.sendToolListChanged());
      notifyChanged(previous.resources !== projection.names.resources, () => projection.server.server.sendResourceListChanged());
      notifyChanged(previous.prompts !== projection.names.prompts, () => projection.server.server.sendPromptListChanged());
    }
  }

  close() {
    if (!this.closing) this.closing = this.performClose().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async performClose() {
    this.closed = true;
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort(new HileMcpError('GATEWAY_CLOSED', 'MCP gateway is closed'));
    const errors: unknown[] = [];
    if (this.unsubscribePending) {
      try { this.unsubscribe(); this.catalogListeners.clear(); this.unsubscribePending = false; } catch (error) { errors.push(error); }
    }
    if (this.unsubscribeResourceUpdatesPending) {
      try { this.unsubscribeResourceUpdates(); this.unsubscribeResourceUpdatesPending = false; } catch (error) { errors.push(error); }
    }
    if (this.sourceClosePending) {
      await Promise.allSettled([...this.activeInvocations]);
      try { await this.options.source.close(); this.sourceClosePending = false; } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to close MCP gateway');
  }
}

export async function createMcpGateway(options: CreateMcpGatewayOptions): Promise<McpGateway> {
  if (!options.info || specTypeSchemas.Implementation['~standard'].validate(options.info).issues
    || !options.info.name || !options.info.version) {
    throw new TypeError('MCP gateway info must follow the MCP Implementation schema with non-empty name and version');
  }
  if (options.instructions !== undefined && typeof options.instructions !== 'string') throw new TypeError('MCP gateway instructions must be a string');
  if (options.startup !== undefined && !['allow-empty', 'require-provider'].includes(options.startup)) throw new TypeError('Invalid MCP gateway startup mode');
  if (options.naming?.separator !== undefined && !['.', '-', '_'].includes(options.naming.separator)) throw new TypeError('Invalid MCP gateway name separator');
  if (options.naming?.aliases !== undefined && (!options.naming.aliases || typeof options.naming.aliases !== 'object' || Array.isArray(options.naming.aliases))) {
    throw new TypeError('MCP gateway aliases must be a record');
  }
  if (options.isCapabilityExposed !== undefined && typeof options.isCapabilityExposed !== 'function') throw new TypeError('MCP isCapabilityExposed must be a function');
  if (options.onError !== undefined && typeof options.onError !== 'function') throw new TypeError('MCP gateway onError must be a function');
  if (typeof options.executionContext !== 'function') throw new TypeError('MCP gateway executionContext must be a function');
  const allowedCacheMethods = new Set(['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read', 'server/discover']);
  if (options.cacheHints !== undefined && (!options.cacheHints || typeof options.cacheHints !== 'object'
    || Object.entries(options.cacheHints).some(([method, hint]) => !allowedCacheMethods.has(method) || !hint || typeof hint !== 'object'
      || (hint.ttlMs !== undefined && (!Number.isSafeInteger(hint.ttlMs) || hint.ttlMs < 0))
      || (hint.cacheScope !== undefined && !['public', 'private'].includes(hint.cacheScope))))) {
    throw new TypeError('MCP gateway cacheHints contain an invalid method or cache hint');
  }
  if (!options.invocationSecurity || !['trusted-internal', 'credential'].includes(options.invocationSecurity.mode)
    || (options.invocationSecurity.mode === 'credential' && typeof options.invocationSecurity.credentials?.create !== 'function')) {
    throw new TypeError('MCP gateway invocationSecurity must be explicit');
  }
  const aliases = Object.assign(Object.create(null), options.naming?.aliases ?? {}) as Record<string, string>;
  for (const [providerId, alias] of Object.entries(aliases)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(providerId) || !/^[A-Za-z0-9._-]{1,128}$/.test(alias)) {
      throw new TypeError('MCP gateway aliases must contain legal provider and alias names');
    }
  }
  const invocationSecurity = options.invocationSecurity.mode === 'credential'
    ? Object.freeze({
      mode: 'credential' as const,
      credentials: Object.freeze({ create: options.invocationSecurity.credentials.create.bind(options.invocationSecurity.credentials) }),
    })
    : Object.freeze({ mode: 'trusted-internal' as const });
  const normalized: CreateMcpGatewayOptions = {
    ...options,
    info: Object.freeze({ ...options.info, icons: cloneIcons(options.info.icons) }),
    cacheHints: options.cacheHints ? Object.freeze(Object.fromEntries(
      Object.entries(options.cacheHints).map(([method, hint]) => [method, Object.freeze({ ...hint })]),
    )) : undefined,
    naming: options.naming ? Object.freeze({
      separator: options.naming.separator,
      aliases: Object.freeze(aliases),
    }) : undefined,
    requestState: options.requestState ? Object.freeze({ ...options.requestState }) : undefined,
    invocationSecurity,
  };
  const gateway = new McpGatewayRuntime(normalized);
  try {
    await gateway.start();
    gatewayFactories.set(gateway, context => gateway[GATEWAY_RUNTIME](context));
    gatewayChangeSubscriptions.set(gateway, listener => gateway.subscribeCatalogChanges(listener));
    return gateway;
  } catch (error) {
    await gateway.close().catch(() => undefined);
    throw error;
  }
}

export function mcpServerFactory(gateway: McpGateway) {
  const factory = gatewayFactories.get(gateway);
  if (!factory) throw new TypeError('MCP gateway must be created by createMcpGateway');
  return factory;
}

export function subscribeMcpGatewayChanges(gateway: McpGateway, listener: (change: McpGatewayCatalogChange) => void) {
  const subscribe = gatewayChangeSubscriptions.get(gateway);
  if (!subscribe) throw new TypeError('MCP gateway must be created by createMcpGateway');
  return subscribe(listener);
}
