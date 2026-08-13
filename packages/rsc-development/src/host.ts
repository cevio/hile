import { Readable } from 'node:stream';
import { watchRscDevelopmentState } from './state';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import type { RscRuntimeCompatibility } from '@hile/rsc/protocol';
import { createHileRscPluginClient, type HileRscApplication } from '@hile/rsc/transport';
import type { InMemoryRscDeploymentCatalog } from '@hile/rsc/host/catalog';
import type { MutableRscArtifactCatalog } from '@hile/rsc/host/registry';

export interface RscDevelopmentRevisionEvent {
  pluginId: string;
  buildId: string;
  revision: number;
}

export interface RscDevelopmentEventsOptions {
  onListenerError?: (error: unknown, event: RscDevelopmentRevisionEvent) => void;
}

type Listener = (event: RscDevelopmentRevisionEvent) => void;

function assertEvent(event: RscDevelopmentRevisionEvent): void {
  if (!event.pluginId || !event.buildId) throw new TypeError('RSC development event identities are required');
  if (!Number.isSafeInteger(event.revision) || event.revision < 1) {
    throw new TypeError('RSC development event revision must be a positive safe integer');
  }
}

export class RscDevelopmentEvents {
  private readonly active = new Map<string, RscDevelopmentRevisionEvent>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly options: RscDevelopmentEventsOptions = {}) {}

  public publish(input: RscDevelopmentRevisionEvent): void {
    assertEvent(input);
    const event: RscDevelopmentRevisionEvent = {
      pluginId: input.pluginId,
      buildId: input.buildId,
      revision: input.revision,
    };
    const previous = this.active.get(event.pluginId);
    if (previous && event.revision < previous.revision) {
      throw new Error(`RSC development revision must be newer than ${previous.revision}`);
    }
    if (previous && event.revision === previous.revision) {
      if (event.buildId !== previous.buildId) throw new Error('RSC development revision conflicts with the active build');
      return;
    }
    this.active.set(event.pluginId, event);
    for (const listener of this.listeners) {
      try {
        listener({ ...event });
      } catch (error) {
        try {
          this.options.onListenerError?.(error, { ...event });
        } catch {
          // Diagnostics must not turn an activated revision back into a failed activation.
        }
      }
    }
  }

  public current(pluginId: string): RscDevelopmentRevisionEvent | undefined {
    const value = this.active.get(pluginId);
    return value ? { ...value } : undefined;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public subscriberCount(): number {
    return this.listeners.size;
  }
}

export interface RscDevelopmentCoordinatorOptions {
  events: RscDevelopmentEvents;
  activate(event: RscDevelopmentRevisionEvent): void | Promise<void>;
}

/** Orders revision activation and publishes only revisions that became usable by the Host. */
export class RscDevelopmentCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RscDevelopmentCoordinatorOptions) {}

  public activate(event: RscDevelopmentRevisionEvent): Promise<void> {
    const apply = async () => {
      await this.options.activate({ ...event });
      this.options.events.publish(event);
    };
    const result = this.queue.then(apply, apply);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export interface RscHostDevelopmentBindingOptions {
  file: string;
  application: HileRscApplication;
  artifacts: MutableRscArtifactCatalog;
  deployments: InMemoryRscDeploymentCatalog;
  events: RscDevelopmentEvents;
  runtime: RscRuntimeCompatibility;
  readinessTimeoutMs?: number;
  /** Number of verified client artifact revisions kept per plugin for reload races. */
  retainedArtifactRevisions?: number;
  onError?: (error: unknown) => void;
  verify?: typeof verifyRscPluginArtifact;
  waitUntilReady?: (
    application: HileRscApplication,
    namespace: string,
    buildId: string,
    timeoutMs: number,
  ) => Promise<void>;
}

async function waitForBuild(
  application: HileRscApplication,
  namespace: string,
  buildId: string,
  timeoutMs: number,
): Promise<void> {
  const client = createHileRscPluginClient(application, namespace);
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`RSC plugin readiness timed out: ${namespace}@${buildId}`));
  }, timeoutMs);
  timeout.unref?.();
  let lastError: unknown;
  try {
    while (Date.now() < deadline && !controller.signal.aborted) {
      try {
        if ((await client.describe({ signal: controller.signal })).buildId === buildId) return;
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new Error(`RSC plugin did not activate ${namespace}@${buildId}`, { cause: lastError });
}

/** Activates verified dev artifacts after the plugin namespace reports the matching build. */
export async function bindRscHostDevelopmentState(options: RscHostDevelopmentBindingOptions): Promise<() => Promise<void>> {
  const installed: Array<{
    deployment: { pluginId: string; buildId: string; namespace: string };
    unregisterArtifacts: () => void;
    deploymentInstalled: boolean;
    artifactsRegistered: boolean;
  }> = [];
  const retainedArtifactRevisions = options.retainedArtifactRevisions ?? 2;
  if (!Number.isSafeInteger(retainedArtifactRevisions) || retainedArtifactRevisions < 1) {
    throw new TypeError('retainedArtifactRevisions must be a positive safe integer');
  }
  const retiring = new Set<string>();
  let retirementQueue = Promise.resolve();
  const verify = options.verify ?? verifyRscPluginArtifact;
  const waitUntilReady = options.waitUntilReady ?? waitForBuild;
  const cleanupInstalled = async () => {
    const errors: unknown[] = [];
    for (const item of installed.splice(0).reverse()) {
      try {
        const exists = item.deploymentInstalled && options.deployments.snapshot().some(({ pluginId, buildId }) =>
          pluginId === item.deployment.pluginId && buildId === item.deployment.buildId);
        if (exists) {
          options.deployments.deactivate(item.deployment);
          await options.deployments.drain(item.deployment);
          options.deployments.remove(item.deployment);
        }
        item.deploymentInstalled = false;
      } catch (error) {
        errors.push(error);
      }
      try {
        if (item.artifactsRegistered) item.unregisterArtifacts();
        item.artifactsRegistered = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'RSC development cleanup failed');
  };
  const scheduleRetirement = (current: typeof installed[number], replacesActivePlugin: boolean) => {
    const candidates = installed.filter((item) =>
      item !== current
      && item.deployment.pluginId === current.deployment.pluginId
      && (item.deployment.namespace === current.deployment.namespace || replacesActivePlugin)
      && item.deploymentInstalled);
    for (const item of candidates) {
      const identity = `${item.deployment.pluginId}\0${item.deployment.buildId}`;
      if (retiring.has(identity)) continue;
      retiring.add(identity);
      retirementQueue = retirementQueue.then(async () => {
        try {
          await options.deployments.drain(item.deployment);
          options.deployments.remove(item.deployment);
          item.deploymentInstalled = false;

          const retained = installed
            .filter((entry) => entry.deployment.pluginId === current.deployment.pluginId && entry.artifactsRegistered)
            .slice(-retainedArtifactRevisions);
          for (const entry of installed) {
            if (
              entry.deployment.pluginId === current.deployment.pluginId
              && entry.artifactsRegistered
              && !retained.includes(entry)
            ) {
              entry.unregisterArtifacts();
              entry.artifactsRegistered = false;
            }
          }
        } finally {
          retiring.delete(identity);
        }
      }).catch((error) => options.onError?.(error));
    }
  };
  const coordinator = new RscDevelopmentCoordinator({
    events: options.events,
    activate: async (event) => {
      const state = await import('./state').then(({ readRscDevelopmentState }) =>
        readRscDevelopmentState(options.file));
      const record = state.revisions.find(({ pluginId, buildId }) =>
        pluginId === event.pluginId && buildId === event.buildId);
      if (!record) throw new Error(`RSC development revision disappeared: ${event.pluginId}@${event.buildId}`);
      const { manifest } = await verify(record.artifactRoot, options.runtime);
      if (manifest.pluginId !== record.pluginId || manifest.buildId !== record.buildId) {
        throw new Error(`RSC development artifact identity mismatch: ${record.pluginId}@${record.buildId}`);
      }
      await waitUntilReady(options.application, record.namespace, record.buildId, options.readinessTimeoutMs ?? 5_000);
      const unregisterArtifacts = options.artifacts.register(record.artifactRoot, manifest);
      const deployment = {
        pluginId: record.pluginId,
        buildId: record.buildId,
        namespace: record.namespace,
      };
      const previousNamespaceDeployments = installed.filter((item) =>
        item.deployment.pluginId === deployment.pluginId
        && item.deployment.namespace === deployment.namespace
        && item.deploymentInstalled);
      const snapshot = options.deployments.snapshot();
      const shouldActivate = previousNamespaceDeployments.length === 0
        ? record.active !== false
        : previousNamespaceDeployments.some((item) => snapshot.some((entry) =>
          entry.pluginId === item.deployment.pluginId
          && entry.buildId === item.deployment.buildId
          && entry.state === 'active'));
      try {
        options.deployments.install(deployment, { activate: shouldActivate });
        const current = {
          deployment,
          unregisterArtifacts,
          deploymentInstalled: true,
          artifactsRegistered: true,
        };
        installed.push(current);
        scheduleRetirement(current, shouldActivate);
      } catch (error) {
        unregisterArtifacts();
        throw error;
      }
    },
  });
  const seen = new Map<string, number>();
  const activationSequence = new Map<string, number>();
  const watcher = watchRscDevelopmentState(options.file, async (state) => {
    for (const record of state.revisions) {
      const key = `${record.pluginId}\0${record.namespace}`;
      if ((seen.get(key) ?? 0) >= record.revision) continue;
      const revision = (activationSequence.get(record.pluginId) ?? 0) + 1;
      await coordinator.activate({ ...record, revision });
      seen.set(key, record.revision);
      activationSequence.set(record.pluginId, revision);
    }
  }, { onError: options.onError });
  try {
    await watcher.refresh();
  } catch (error) {
    await watcher.close();
    try {
      await cleanupInstalled();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'RSC development binding failed and cleanup was incomplete');
    }
    throw error;
  }
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await watcher.close();
    await retirementQueue;
    await cleanupInstalled();
  };
}

export interface RscDevelopmentEventContext {
  path: string;
  status: number;
  type?: string;
  body?: AsyncIterable<Uint8Array>;
  set(name: string, value: string): void;
}

export interface RscDevelopmentEventMiddlewareOptions {
  events: RscDevelopmentEvents;
  mountPath?: string;
  heartbeatMs?: number;
  /** Byte threshold used by the SSE stream before revision events are coalesced. */
  streamHighWaterMark?: number;
}

function normalizeMountPath(value: string): string {
  if (!value.startsWith('/')) throw new TypeError('RSC development event mount path must be absolute');
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC development event mount path must not be root');
  return normalized;
}

export function createRscDevelopmentEventMiddleware(options: RscDevelopmentEventMiddlewareOptions) {
  const mountPath = normalizeMountPath(options.mountPath ?? '/_hile/rsc/development');
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) throw new TypeError('heartbeatMs must be positive');
  const streamHighWaterMark = options.streamHighWaterMark;
  if (streamHighWaterMark !== undefined && (!Number.isSafeInteger(streamHighWaterMark) || streamHighWaterMark < 1)) {
    throw new TypeError('streamHighWaterMark must be a positive safe integer');
  }
  return async (context: RscDevelopmentEventContext, next: () => Promise<unknown>) => {
    if (context.path !== mountPath) return next();
    context.status = 200;
    context.type = 'text/event-stream; charset=utf-8';
    context.set('Cache-Control', 'no-cache, no-transform');
    context.set('Connection', 'keep-alive');
    context.set('X-Accel-Buffering', 'no');
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let blocked = false;
    const pendingRevisions = new Map<string, RscDevelopmentRevisionEvent>();
    const write = (value: string) => {
      if (blocked) return false;
      blocked = !body.push(value);
      return !blocked;
    };
    const flush = () => {
      blocked = false;
      for (const [pluginId, event] of pendingRevisions) {
        pendingRevisions.delete(pluginId);
        write(`event: revision\ndata: ${JSON.stringify(event)}\n\n`);
        if (blocked) return;
      }
    };
    const body = new Readable({
      ...(streamHighWaterMark === undefined ? {} : { highWaterMark: streamHighWaterMark }),
      read() { flush(); },
      destroy(error, callback) {
        if (timer) clearInterval(timer);
        unsubscribe();
        callback(error);
      },
    });
    unsubscribe = options.events.subscribe((event) => {
      if (blocked) {
        pendingRevisions.set(event.pluginId, event);
        return;
      }
      write(`event: revision\ndata: ${JSON.stringify(event)}\n\n`);
    });
    timer = setInterval(() => {
      if (!blocked) write(': heartbeat\n\n');
    }, heartbeatMs);
    timer.unref?.();
    write(': connected\n\n');
    context.body = body;
  };
}
