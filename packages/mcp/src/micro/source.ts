import { isDeepStrictEqual } from 'node:util';
import { HileMcpError } from '../errors.js';
import { assertTimerMs } from '../limits.js';
import { compareText } from '../ordering.js';
import { parseMcpProviderManifest } from './manifest.js';
import {
  MCP_PROVIDER_TOPIC_PREFIX,
  MCP_RESOURCE_UPDATE_TOPIC,
  type HileMcpDiscoveryApplication,
  type McpProviderManifest,
  type McpProviderSnapshotListener,
  type McpProviderSource,
  type McpResourceUpdate,
  type McpResourceUpdateListener,
} from './types.js';

export class HileMcpProviderSource implements McpProviderSource {
  private readonly instances = new Map<string, McpProviderManifest>();
  private readonly listeners = new Set<McpProviderSnapshotListener>();
  private readonly resourceUpdateListeners = new Set<McpResourceUpdateListener>();
  private readonly seenResourceUpdates = new Set<string>();
  private resourceUnsubscribe?: () => Promise<void>;
  private timer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private refreshPromise?: Promise<void>;
  private closed = false;
  private readonly lifecycle = new AbortController();
  private closing?: Promise<void>;

  private signature(items: readonly McpProviderManifest[]) {
    return items.map(item => `${item.providerId}/${item.instanceId}/${item.fingerprint}/${item.address.host}:${item.address.port}`).join('|');
  }

  constructor(
    private readonly application: HileMcpDiscoveryApplication,
    private readonly pollIntervalMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  start() {
    if (this.closed) throw new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP provider source is closed');
    if (!this.starting) this.starting = this.performStart().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async performStart() {
    if (!this.resourceUnsubscribe) {
      const unsubscribe = await this.application.subscribe<unknown>(MCP_RESOURCE_UPDATE_TOPIC, payload => {
        const update = this.parseResourceUpdate(payload);
        if (!update || this.seenResourceUpdates.has(update.eventId)) return;
        this.seenResourceUpdates.add(update.eventId);
        if (this.seenResourceUpdates.size > 1_024) this.seenResourceUpdates.delete(this.seenResourceUpdates.values().next().value!);
        for (const listener of this.resourceUpdateListeners) {
          try { listener(update); } catch (error) { this.report(error); }
        }
      });
      this.resourceUnsubscribe = unsubscribe;
      if (this.closed) throw new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP provider source is closed');
    }
    await this.refresh();
    if (this.closed) throw new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP provider source is closed');
    if (!this.timer) {
      this.timer = setInterval(() => { void this.refresh().catch(error => this.report(error)); }, this.pollIntervalMs);
      this.timer.unref();
    }
  }

  snapshot(): readonly McpProviderManifest[] {
    return [...this.instances.values()].sort((a, b) => compareText(a.providerId, b.providerId) || compareText(a.instanceId, b.instanceId));
  }

  subscribe(listener: McpProviderSnapshotListener) {
    if (this.closed) throw new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP provider source is closed');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeResourceUpdates(listener: McpResourceUpdateListener) {
    if (this.closed) throw new HileMcpError('PROVIDER_UNAVAILABLE', 'MCP provider source is closed');
    this.resourceUpdateListeners.add(listener);
    return () => { this.resourceUpdateListeners.delete(listener); };
  }

  private parseResourceUpdate(value: unknown): McpResourceUpdate | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const update = value as Record<string, unknown>;
    if (typeof update.eventId !== 'string' || !update.eventId || typeof update.providerId !== 'string'
      || typeof update.instanceId !== 'string' || typeof update.fingerprint !== 'string' || typeof update.uri !== 'string') return undefined;
    try { new URL(update.uri); } catch { return undefined; }
    const manifest = this.instances.get(`${update.providerId}/${update.instanceId}`);
    return manifest?.fingerprint === update.fingerprint ? Object.freeze({
      eventId: update.eventId,
      providerId: update.providerId,
      instanceId: update.instanceId,
      fingerprint: update.fingerprint,
      uri: update.uri,
    }) : undefined;
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const run = (async () => {
      const topics = await this.application.listRegistryTopicSnapshots(MCP_PROVIDER_TOPIC_PREFIX, { signal: this.lifecycle.signal });
      const next = new Map<string, McpProviderManifest>();
      for (const { topic, payload, publishers } of topics) {
        const record = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : undefined;
        const key = typeof record?.providerId === 'string' && typeof record.instanceId === 'string'
          ? `${record.providerId}/${record.instanceId}`
          : undefined;
        const previous = key ? this.instances.get(key) : undefined;
        const manifest = previous
          && topic === `${MCP_PROVIDER_TOPIC_PREFIX}${previous.providerId}/${previous.instanceId}`
          && isDeepStrictEqual(payload, previous)
          ? previous
          : parseMcpProviderManifest(payload, topic);
        const publisher = publishers.length === 1 ? publishers[0] : undefined;
        if (manifest && publisher && manifest.address.host === publisher.host && manifest.address.port === publisher.port) {
          next.set(`${manifest.providerId}/${manifest.instanceId}`, manifest);
        }
      }
      if (this.closed) return;
      const before = this.signature(this.snapshot());
      this.instances.clear();
      for (const [key, manifest] of next) this.instances.set(key, manifest);
      const current = this.snapshot();
      if (this.signature(current) !== before) {
        for (const listener of this.listeners) {
          try { listener(current); } catch (error) { this.report(error); }
        }
      }
    })();
    this.refreshPromise = run.finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }

  stream(instance: McpProviderManifest, operation: string, data: unknown, options: {
    context: import('@hile/context').ExecutionContext;
    timeout?: number;
    idleTimeout?: number;
    signal?: AbortSignal;
  }) {
    return this.application.streamPeer(instance.address, operation, data, options);
  }

  close() {
    if (!this.closing) this.closing = this.performClose().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async performClose() {
    if (!this.closed) {
      this.closed = true;
      this.lifecycle.abort(new Error('MCP provider source closed'));
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.listeners.clear();
      this.resourceUpdateListeners.clear();
    }
    try { await this.starting; } catch {
      // A concurrent start owns its own error; close only waits for its cleanup boundary.
    }
    try { await this.refreshPromise; } catch (error) {
      const cancellation = error === this.lifecycle.signal.reason
        || (!!error && typeof error === 'object' && ((error as any).status === 'ECONNABORTED' || (error as any).name === 'AbortError'));
      if (!this.lifecycle.signal.aborted || !cancellation) throw error;
    }
    if (this.resourceUnsubscribe) {
      const unsubscribe = this.resourceUnsubscribe;
      await unsubscribe();
      if (this.resourceUnsubscribe === unsubscribe) this.resourceUnsubscribe = undefined;
    }
  }

  private report(error: unknown) {
    try { this.onError(error); } catch { /* diagnostics must not break discovery */ }
  }
}

export function createHileMcpProviderSource(
  application: HileMcpDiscoveryApplication,
  options: { pollIntervalMs?: number; onError?: (error: unknown) => void } = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  assertTimerMs(pollIntervalMs, 'pollIntervalMs', 100);
  if (options.onError !== undefined && typeof options.onError !== 'function') throw new TypeError('MCP provider source onError must be a function');
  return new HileMcpProviderSource(application, pollIntervalMs, options.onError ?? (() => undefined));
}
