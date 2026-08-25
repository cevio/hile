import type { RscRuntimeCompatibility } from '@hile/rsc/protocol';
import {
  MissingExecutionContextError,
  parseExecutionContext,
  type ExecutionContext,
} from '@hile/context';
import { createRscDiscoveryTopic } from '@hile/rsc-discovery';
import type { MutableRscArtifactCatalog } from '@hile/rsc/host/registry';
import {
  InMemoryRscDeploymentCatalog,
  type RscPluginDeployment,
} from '@hile/rsc/host/catalog';
import { RscDeploymentManager } from '@hile/rsc/host/deployment-manager';
import {
  RscDiscoveryManager,
  type RscDiscoveryAnnouncement,
  type RscDiscoveryDeployment,
  type RscDiscoveryGenerationHighWater,
  type RscDiscoverySnapshot,
} from '@hile/rsc-discovery';
import {
  downloadHileRscArtifact,
  type HileRscArtifactClient,
} from './downloader';
import {
  readHileRscDiscoverySnapshot,
  type HileRscDiscoverySnapshot,
  type HileRscRegistryReader,
} from './reader';

export interface HileRscDiscoveryHostApplication extends HileRscRegistryReader, HileRscArtifactClient {}

export interface HileRscDiscoveryHostOptions {
  context: ExecutionContext;
  application: HileRscDiscoveryHostApplication;
  artifacts: MutableRscArtifactCatalog;
  deployments: InMemoryRscDeploymentCatalog;
  runtime: RscRuntimeCompatibility;
  pollIntervalMs?: number;
  missingReconciliations?: number;
  /** Reusable across sequential Hosts; the previous Host must close before handoff. */
  generationHighWater?: Map<string, RscDiscoveryGenerationHighWater>;
  generationHistorySize?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxManifestBytes?: number;
  maxArtifactFiles?: number;
  maxPathBytes?: number;
  maxPathDepth?: number;
  select?: (candidates: readonly RscDiscoveryAnnouncement[]) => RscDiscoveryAnnouncement;
  authorize: (announcement: RscDiscoveryAnnouncement) => boolean | Promise<boolean>;
  operationTimeoutMs?: number;
  snapshotConcurrency?: number;
  onRejected?: (topic: string, error: unknown) => void;
  onEnabled?: (announcement: RscDiscoveryAnnouncement) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

interface HileRscDiscoveryDeployment extends RscDiscoveryDeployment {
  deployment: RscPluginDeployment;
}

/** Registry is the source of truth: discovered services are automatically active. */
export class HileRscDiscoveryHost {
  private readonly options: HileRscDiscoveryHostOptions;
  private readonly deployments: RscDeploymentManager;
  private readonly discovery: RscDiscoveryManager<HileRscDiscoveryDeployment>;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshPromise?: Promise<void>;
  private snapshotPromise?: Promise<HileRscDiscoverySnapshot>;
  private refreshController?: AbortController;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;

  private reportError(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* observers cannot alter runtime state */ }
  }

  constructor(options: HileRscDiscoveryHostOptions) {
    if (!options?.context) throw new MissingExecutionContextError('RSC discovery host');
    const context = parseExecutionContext(options.context);
    this.options = { ...options, context };
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 25) {
      throw new TypeError('pollIntervalMs must be at least 25');
    }
    if (typeof options.authorize !== 'function') throw new TypeError('RSC discovery authorize policy is required');
    const operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs < 100) {
      throw new TypeError('operationTimeoutMs must be at least 100');
    }
    this.deployments = new RscDeploymentManager({
      artifacts: options.artifacts,
      deployments: options.deployments,
      runtime: options.runtime,
      start: async () => ({
        deactivate: () => undefined,
        drain: async () => undefined,
        stop: async () => undefined,
      }),
    });
    this.discovery = new RscDiscoveryManager<HileRscDiscoveryDeployment>({
      missingReconciliations: options.missingReconciliations,
      generationHighWater: options.generationHighWater,
      generationHistorySize: options.generationHistorySize,
      select: options.select,
      deploy: async (announcement) => {
        const downloaded = await downloadHileRscArtifact(options.application, announcement, {
          context,
          runtime: options.runtime,
          signal: this.refreshController?.signal,
          maxFileBytes: options.maxFileBytes,
          maxTotalBytes: options.maxTotalBytes,
          maxManifestBytes: options.maxManifestBytes,
          maxArtifactFiles: options.maxArtifactFiles,
          maxPathBytes: options.maxPathBytes,
          maxPathDepth: options.maxPathDepth,
        });
        try {
          const deployment = await this.deployments.upgrade({
            artifactRoot: downloaded.artifactRoot,
            namespace: announcement.namespace,
            expected: { pluginId: announcement.pluginId, buildId: announcement.buildId },
          });
          try {
            await options.onEnabled?.(structuredClone(announcement));
          } catch (error) {
            this.reportError(error);
          }
          return { announcement: structuredClone(announcement), deployment };
        } finally {
          await downloaded.cleanup();
        }
      },
      retire: ({ deployment }) => this.deployments.retire(deployment),
      replace: async (_current, announcement) => ({
        announcement: structuredClone(announcement),
        deployment: await this.deployments.rebind(announcement, announcement.namespace),
      }),
    });
    // Validate eagerly while keeping one canonical configured value.
    void pollIntervalMs;
  }

  public async refresh(): Promise<void> {
    if (this.closed) throw new Error('Hile RSC discovery host is closed');
    if (this.refreshPromise) return this.refreshPromise;
    if (this.snapshotPromise) {
      throw new Error('Previous RSC discovery snapshot read is still settling');
    }
    const controller = new AbortController();
    this.refreshController = controller;
    const timeoutMs = this.options.operationTimeoutMs ?? 30_000;
    const timeout = setTimeout(() => controller.abort(new Error('RSC discovery refresh timed out')), timeoutMs);
    timeout.unref?.();
    const operation = (async () => {
      const snapshotRead = readHileRscDiscoverySnapshot(this.options.application, {
        concurrency: this.options.snapshotConcurrency,
        signal: controller.signal,
      });
      const trackedSnapshot = snapshotRead.finally(() => {
        if (this.snapshotPromise === trackedSnapshot) this.snapshotPromise = undefined;
      });
      this.snapshotPromise = trackedSnapshot;
      const snapshot = await Promise.race([
        trackedSnapshot,
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () =>
          reject(controller.signal.reason), { once: true })),
      ]);
      for (const rejected of snapshot.rejected) {
        try { this.options.onRejected?.(rejected.topic, rejected.error); } catch (error) { this.reportError(error); }
      }
      const authorized: RscDiscoveryAnnouncement[] = [];
      for (const announcement of snapshot.announcements) {
        try {
          if (!await this.options.authorize(structuredClone(announcement))) {
            throw new Error(`Unauthorized RSC discovery announcement: ${announcement.pluginId}`);
          }
          if (Object.keys(this.options.runtime).some((key) =>
            announcement.runtime[key as keyof RscRuntimeCompatibility]
              !== this.options.runtime[key as keyof RscRuntimeCompatibility])) {
            throw new Error(`Incompatible RSC discovery runtime: ${announcement.pluginId}@${announcement.buildId}`);
          }
          authorized.push(announcement);
        } catch (error) {
          const topic = createRscDiscoveryTopic(announcement.instanceId);
          try { this.options.onRejected?.(topic, error); } catch (observerError) { this.reportError(observerError); }
        }
      }
      await this.discovery.reconcile(authorized);
    })();
    const tracked = operation.finally(() => {
      clearTimeout(timeout);
      if (this.refreshController === controller) this.refreshController = undefined;
      if (this.refreshPromise === tracked) this.refreshPromise = undefined;
    });
    this.refreshPromise = tracked;
    return this.refreshPromise;
  }

  public async start(): Promise<void> {
    if (this.closed) throw new Error('Hile RSC discovery host is closed');
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await this.refresh();
      const schedule = () => {
        if (this.closed) return;
        this.timer = setTimeout(async () => {
          this.timer = undefined;
          try { await this.refresh(); } catch (error) {
            if (!this.closed) this.reportError(error);
          }
          schedule();
        }, this.options.pollIntervalMs ?? 500);
        this.timer.unref?.();
      };
      schedule();
    })();
    return this.startPromise;
  }

  public snapshot(): RscDiscoverySnapshot[] {
    return this.discovery.snapshot();
  }

  public async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const operation = (async () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.refreshController?.abort(new Error('Hile RSC discovery host is closing'));
      const errors: unknown[] = [];
      try { await this.refreshPromise; } catch { /* closing intentionally aborts in-flight refresh */ }
      try { await this.discovery.close(); } catch (error) { errors.push(error); }
      try { await this.deployments.shutdown(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Hile RSC discovery host cleanup failed');
    })();
    this.closePromise = operation.catch((error) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
}
