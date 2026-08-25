import type { RscPluginManifest } from '../protocol';
import { rscRouteParameterName, splitRscRoutePath } from '../protocol/route-pattern';
import {
  decodeRscServerFunctionValue,
  encodeRscServerFunctionValue,
  type RscServerFunctionWireValue,
} from '../server-functions/codec';
import {
  ModelActionRegistry,
  ModelActionRegistryError,
  type ModelActionLoadOptions,
} from '@hile/model';
import type {
  RscActionRequest,
  RscPluginServiceOptions,
  RscRenderRequest,
  RscServerFunctionRequest,
} from './types';

export type RscPluginServiceErrorCode =
  | 'ERR_RSC_PLUGIN_INACTIVE'
  | 'ERR_RSC_BUILD_MISMATCH'
  | 'ERR_RSC_ROUTE_NOT_FOUND'
  | 'ERR_RSC_ACTION_NOT_FOUND'
  | 'ERR_RSC_SERVER_FUNCTION_NOT_FOUND'
  | 'ERR_RSC_INVALID_REQUEST';

export class RscPluginServiceError extends Error {
  public readonly code: RscPluginServiceErrorCode;

  constructor(code: RscPluginServiceErrorCode, message: string) {
    super(message);
    this.name = 'RscPluginServiceError';
    this.code = code;
  }
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RscPluginServiceError('ERR_RSC_INVALID_REQUEST', `${name} must be an object`);
  }
}

function assertBuildId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RscPluginServiceError('ERR_RSC_INVALID_REQUEST', 'buildId must be a string');
  }
}

function resolveRoute(
  routes: RscPluginManifest['routes'],
  requestedPath: string,
): { route: RscPluginManifest['routes'][number]; params: Record<string, string> } | undefined {
  const requestedSegments = splitRscRoutePath(requestedPath);
  const matches: Array<{
    route: RscPluginManifest['routes'][number];
    params: Record<string, string>;
    dynamicSegments: number;
  }> = [];
  for (const route of routes) {
    const routeSegments = splitRscRoutePath(route.path);
    const parameterNames = routeSegments.map(rscRouteParameterName);
    if (route.path === requestedPath && parameterNames.every((name) => name === undefined)) {
      return { route, params: {} };
    }
    if (routeSegments.length !== requestedSegments.length) continue;
    const params: Record<string, string> = {};
    let dynamicSegments = 0;
    let matched = true;
    for (let index = 0; index < routeSegments.length; index++) {
      const parameterName = parameterNames[index];
      if (parameterName !== undefined) {
        if (requestedSegments[index].length === 0) {
          matched = false;
          break;
        }
        params[parameterName] = requestedSegments[index];
        dynamicSegments++;
        continue;
      }
      if (routeSegments[index] !== requestedSegments[index]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push({ route, params, dynamicSegments });
  }
  matches.sort((left, right) => left.dynamicSegments - right.dynamicSegments);
  const selected = matches[0];
  if (!selected) return undefined;
  if (matches[1]?.dynamicSegments === selected.dynamicSegments) {
    throw new RscPluginServiceError(
      'ERR_RSC_INVALID_REQUEST',
      `ambiguous parameterized RSC route: ${requestedPath}`,
    );
  }
  return { route: selected.route, params: selected.params };
}

function combineSignals(primary: AbortSignal | undefined, shutdown: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onPrimary = () => primary && abort(primary);
  const onShutdown = () => abort(shutdown);
  if (primary?.aborted) abort(primary);
  else primary?.addEventListener('abort', onPrimary, { once: true });
  if (shutdown.aborted) abort(shutdown);
  else shutdown.addEventListener('abort', onShutdown, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      primary?.removeEventListener('abort', onPrimary);
      shutdown.removeEventListener('abort', onShutdown);
    },
  };
}

export class RscPluginService {
  private manifest: RscPluginManifest;
  private renderer: RscPluginServiceOptions['renderer'];
  private readonly retainedRevisions: number;
  private readonly revisions = new Map<string, {
    manifest: RscPluginManifest;
    renderer: RscPluginServiceOptions['renderer'];
    serverFunctions?: RscPluginServiceOptions['serverFunctions'];
  }>();
  private actionModels = new ModelActionRegistry();
  private unloadActiveModels?: () => void;
  private modelLoadQueue: Promise<void> = Promise.resolve();
  private readonly shutdown = new AbortController();
  private active = true;
  private inFlight = 0;
  private readonly drainWaiters = new Set<() => void>();
  private readonly deactivateListeners = new Set<() => void>();

  constructor(options: RscPluginServiceOptions) {
    const retainedRevisions = options.retainedRevisions ?? 2;
    if (!Number.isSafeInteger(retainedRevisions) || retainedRevisions < 1) {
      throw new TypeError('RSC plugin retainedRevisions must be a positive safe integer');
    }
    this.retainedRevisions = retainedRevisions;
    this.manifest = structuredClone(options.manifest);
    this.renderer = options.renderer;
    this.revisions.set(this.manifest.buildId, {
      manifest: this.manifest,
      renderer: this.renderer,
      serverFunctions: options.serverFunctions,
    });
  }

  /** Scans domain-organized `*.model.*` files and mounts only defineActionModel exports. */
  public async load(directory: string, options: ModelActionLoadOptions = {}): Promise<() => void> {
    this.assertActive();
    let resolveUnload!: (unload: () => void) => void;
    let rejectLoad!: (error: unknown) => void;
    const result = new Promise<() => void>((resolve, reject) => {
      resolveUnload = resolve;
      rejectLoad = reject;
    });
    const replace = async () => {
      try {
        const nextRegistry = new ModelActionRegistry();
        const unloadRegistry = await nextRegistry.load(directory, options);
        if (!this.active) {
          unloadRegistry();
          throw new RscPluginServiceError('ERR_RSC_PLUGIN_INACTIVE', 'RSC plugin is inactive');
        }
        const previousUnload = this.unloadActiveModels;
        this.actionModels = nextRegistry;
        this.unloadActiveModels = unloadRegistry;
        previousUnload?.();

        let unloaded = false;
        resolveUnload(() => {
          if (unloaded) return;
          unloaded = true;
          if (this.actionModels === nextRegistry) {
            this.actionModels = new ModelActionRegistry();
            this.unloadActiveModels = undefined;
          }
          unloadRegistry();
        });
      } catch (error) {
        rejectLoad(error);
      }
    };
    const queued = this.modelLoadQueue.then(replace, replace);
    this.modelLoadQueue = queued.then(() => undefined, () => undefined);
    return result;
  }

  public describe(): RscPluginManifest {
    return structuredClone(this.manifest);
  }

  /** Atomically switches new requests to a compatible immutable RSC revision. */
  public activate(options: RscPluginServiceOptions): void {
    this.assertActive();
    if (options.manifest.pluginId !== this.manifest.pluginId) {
      throw new TypeError('RSC revision pluginId must match the active service');
    }
    for (const key of ['react', 'reactDom', 'rsc'] as const) {
      if (options.manifest.runtime[key] !== this.manifest.runtime[key]) {
        throw new TypeError(`RSC revision runtime ${key} must match the active service`);
      }
    }
    if (options.manifest.buildId === this.manifest.buildId) {
      throw new TypeError('RSC revision buildId must differ from the active immutable build');
    }
    this.manifest = structuredClone(options.manifest);
    this.renderer = options.renderer;
    this.revisions.set(this.manifest.buildId, {
      manifest: this.manifest,
      renderer: this.renderer,
      serverFunctions: options.serverFunctions,
    });
    while (this.revisions.size > this.retainedRevisions) {
      this.revisions.delete(this.revisions.keys().next().value!);
    }
  }

  private assertActive(): void {
    if (!this.active) {
      throw new RscPluginServiceError('ERR_RSC_PLUGIN_INACTIVE', 'RSC plugin is inactive');
    }
  }

  private requiredRevision(buildId: string) {
    const revision = this.revisions.get(buildId);
    if (!revision) {
      throw new RscPluginServiceError(
        'ERR_RSC_BUILD_MISMATCH',
        `RSC build mismatch: requested=${buildId}, active=${this.manifest.buildId}`,
      );
    }
    return revision;
  }

  private entered(): () => void {
    this.inFlight++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.inFlight--;
      if (this.inFlight === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    };
  }

  public render(value: unknown, remoteSignal?: AbortSignal): AsyncIterable<Uint8Array> {
    this.assertActive();
    assertRecord(value, 'render request');
    assertBuildId(value.buildId);
    if (typeof value.path !== 'string' || !value.path.startsWith('/')) {
      throw new RscPluginServiceError('ERR_RSC_INVALID_REQUEST', 'path must be absolute');
    }
    const revision = this.requiredRevision(value.buildId);
    const resolvedRoute = resolveRoute(revision.manifest.routes, value.path);
    if (!resolvedRoute) {
      throw new RscPluginServiceError('ERR_RSC_ROUTE_NOT_FOUND', `unknown RSC route: ${value.path}`);
    }
    const existingParams = value.params && typeof value.params === 'object' && !Array.isArray(value.params)
      ? value.params as Record<string, unknown>
      : {};
    for (const key of Object.keys(resolvedRoute.params)) {
      if (Object.hasOwn(existingParams, key)) {
        throw new RscPluginServiceError(
          'ERR_RSC_INVALID_REQUEST',
          `RSC route parameter conflicts with request params: ${key}`,
        );
      }
    }
    const request = {
      ...value,
      params: { ...existingParams, ...resolvedRoute.params },
    } as unknown as RscRenderRequest;
    const route = resolvedRoute.route;
    const { renderer, manifest } = revision;
    const service = this;
    return {
      async *[Symbol.asyncIterator]() {
        service.assertActive();
        const leave = service.entered();
        const combined = combineSignals(remoteSignal, service.shutdown.signal);
        try {
          const iterable = await renderer({
            manifest,
            routeEntry: route.entry,
            request,
            signal: combined.signal,
          });
          for await (const chunk of iterable) {
            if (combined.signal.aborted) {
              if (service.shutdown.signal.aborted) {
                throw service.shutdown.signal.reason;
              }
              return;
            }
            if (!(chunk instanceof Uint8Array)) {
              throw new TypeError('RSC renderer must yield Uint8Array chunks');
            }
            yield chunk;
          }
          if (service.shutdown.signal.aborted) {
            throw service.shutdown.signal.reason;
          }
        } catch (error) {
          if (service.shutdown.signal.aborted) {
            throw service.shutdown.signal.reason;
          }
          throw error;
        } finally {
          combined.cleanup();
          leave();
        }
      },
    };
  }

  public async action(value: unknown, remoteSignal?: AbortSignal): Promise<unknown> {
    this.assertActive();
    assertRecord(value, 'action request');
    assertBuildId(value.buildId);
    if (
      typeof value.actionId !== 'string' || value.actionId.length === 0 ||
      value.input === null || typeof value.input !== 'object' || Array.isArray(value.input)
    ) {
      throw new RscPluginServiceError('ERR_RSC_INVALID_REQUEST', 'actionId and object input are required');
    }
    this.requiredRevision(value.buildId);
    const request = value as unknown as RscActionRequest;
    const leave = this.entered();
    const combined = combineSignals(remoteSignal, this.shutdown.signal);
    try {
      try {
        return await this.actionModels.invoke(request.actionId, request.input, { signal: combined.signal });
      } catch (error) {
        if (
          error instanceof ModelActionRegistryError &&
          error.code === 'ERR_MODEL_ACTION_NOT_FOUND'
        ) {
          throw new RscPluginServiceError(
            'ERR_RSC_ACTION_NOT_FOUND',
            `unknown RSC action: ${request.actionId}`,
          );
        }
        throw error;
      }
    } finally {
      combined.cleanup();
      leave();
    }
  }

  public async serverFunction(
    value: unknown,
    remoteSignal?: AbortSignal,
  ): Promise<RscServerFunctionWireValue> {
    this.assertActive();
    assertRecord(value, 'server function request');
    assertBuildId(value.buildId);
    if (typeof value.referenceId !== 'string' || value.referenceId.length === 0) {
      throw new RscPluginServiceError(
        'ERR_RSC_INVALID_REQUEST',
        'server function referenceId is required',
      );
    }
    const revision = this.requiredRevision(value.buildId);
    const request = value as unknown as RscServerFunctionRequest;
    const reference = (revision.manifest.serverFunctions ?? [])
      .find(({ id }) => id === request.referenceId);
    if (!reference || !revision.serverFunctions) {
      throw new RscPluginServiceError(
        'ERR_RSC_SERVER_FUNCTION_NOT_FOUND',
        `unknown RSC server function: ${request.referenceId}`,
      );
    }
    const leave = this.entered();
    const combined = combineSignals(remoteSignal, this.shutdown.signal);
    try {
      const decoded = await decodeRscServerFunctionValue(request.args);
      combined.signal.throwIfAborted();
      if (!Array.isArray(decoded)) {
        throw new RscPluginServiceError(
          'ERR_RSC_INVALID_REQUEST',
          'server function args must decode to an array',
        );
      }
      const models = this.actionModels;
      const result = await revision.serverFunctions.invoke({
        manifest: revision.manifest,
        reference,
        args: decoded,
        signal: combined.signal,
        invokeModel: (id, input) => models.invoke(id, input, { signal: combined.signal }),
      });
      return encodeRscServerFunctionValue(result);
    } finally {
      combined.cleanup();
      leave();
    }
  }

  public onDeactivate(listener: () => void): () => void {
    if (!this.active) {
      listener();
      return () => undefined;
    }
    this.deactivateListeners.add(listener);
    return () => this.deactivateListeners.delete(listener);
  }

  public deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.shutdown.abort(new RscPluginServiceError('ERR_RSC_PLUGIN_INACTIVE', 'RSC plugin was deactivated'));
    const errors: unknown[] = [];
    if (this.unloadActiveModels) {
      try {
        this.unloadActiveModels();
      } catch (error) {
        errors.push(error);
      }
      this.unloadActiveModels = undefined;
      this.actionModels = new ModelActionRegistry();
    }
    for (const listener of this.deactivateListeners) {
      try {
        listener();
      } catch (error) {
        errors.push(error);
      }
    }
    this.deactivateListeners.clear();
    if (errors.length > 0) throw new AggregateError(errors, 'RSC plugin deactivation listeners failed');
  }

  public async drain(): Promise<void> {
    if (this.inFlight === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }
}
