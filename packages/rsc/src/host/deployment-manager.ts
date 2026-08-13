import {
  verifyRscPluginArtifact,
  type RscArtifactVerification,
} from '../artifact';
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RscPluginManifest, RscRuntimeCompatibility } from '../protocol';
import {
  InMemoryRscDeploymentCatalog,
  type RscPluginDeployment,
} from './catalog';
import type { MutableRscArtifactCatalog } from './registry';

export interface RscManagedPluginRuntime {
  deactivate(): void | Promise<void>;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export interface RscManagedRuntimeContext {
  artifactRoot: string;
  manifest: RscPluginManifest;
  deployment: RscPluginDeployment;
}

export interface RscDeploymentInstallRequest {
  artifactRoot: string;
  namespace: string;
  activate?: boolean;
  expected?: { pluginId: string; buildId: string };
}

export interface RscDeploymentManagerOptions {
  artifacts: MutableRscArtifactCatalog;
  deployments: InMemoryRscDeploymentCatalog;
  runtime: RscRuntimeCompatibility;
  verify?: (
    artifactRoot: string,
    runtime: RscRuntimeCompatibility,
  ) => Promise<RscArtifactVerification>;
  stage?: (
    artifactRoot: string,
    verification: RscArtifactVerification,
    runtime: RscRuntimeCompatibility,
  ) => Promise<RscStagedPluginArtifact>;
  start(context: RscManagedRuntimeContext): Promise<RscManagedPluginRuntime>;
}

export interface RscStagedPluginArtifact {
  artifactRoot: string;
  verification: RscArtifactVerification;
  cleanup(): void | Promise<void>;
}

interface ManagedDeployment {
  deployment: RscPluginDeployment;
  runtime?: RscManagedPluginRuntime;
  unregisterArtifacts: () => void;
  cleanupArtifacts: () => void | Promise<void>;
}

export async function stageRscPluginArtifact(
  artifactRoot: string,
  verification: RscArtifactVerification,
  runtime: RscRuntimeCompatibility,
): Promise<RscStagedPluginArtifact> {
  const input = path.resolve(artifactRoot);
  const sourceRoot = (await lstat(input)).isDirectory() ? input : path.dirname(input);
  const stagedRoot = await mkdtemp(path.join(tmpdir(), 'hile-rsc-managed-artifact-'));
  try {
    await writeFile(path.join(stagedRoot, 'plugin.json'), `${JSON.stringify(verification.manifest, null, 2)}\n`);
    for (const relative of verification.files) {
      const source = path.resolve(sourceRoot, relative);
      const destination = path.resolve(stagedRoot, relative);
      const sourceRelative = path.relative(sourceRoot, source);
      const destinationRelative = path.relative(stagedRoot, destination);
      if (
        sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)
        || destinationRelative.startsWith('..') || path.isAbsolute(destinationRelative)
      ) {
        throw new Error(`RSC staged artifact path escapes its root: ${relative}`);
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    const stagedVerification = await verifyRscPluginArtifact(stagedRoot, runtime);
    return {
      artifactRoot: stagedRoot,
      verification: stagedVerification,
      cleanup: () => rm(stagedRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(stagedRoot, { recursive: true, force: true });
    throw error;
  }
}

function key(target: { pluginId: string; buildId: string }): string {
  return `${target.pluginId}\0${target.buildId}`;
}

async function stopManagedRuntime(runtime: RscManagedPluginRuntime): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of [
    () => runtime.deactivate(),
    () => runtime.drain(),
    () => runtime.stop(),
  ]) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'RSC managed runtime cleanup failed');
}

export class RscDeploymentManager {
  private readonly artifacts: MutableRscArtifactCatalog;
  private readonly deployments: InMemoryRscDeploymentCatalog;
  private readonly runtimeCompatibility: RscRuntimeCompatibility;
  private readonly verify: NonNullable<RscDeploymentManagerOptions['verify']>;
  private readonly start: RscDeploymentManagerOptions['start'];
  private readonly stage: NonNullable<RscDeploymentManagerOptions['stage']>;
  private readonly managed = new Map<string, ManagedDeployment>();
  private shutdownPromise?: Promise<void>;
  private shuttingDown = false;
  private readonly lifecycle = new Map<string, Promise<unknown>>();
  private readonly pendingInstalls = new Set<Promise<void>>();

  constructor(options: RscDeploymentManagerOptions) {
    this.artifacts = options.artifacts;
    this.deployments = options.deployments;
    this.runtimeCompatibility = { ...options.runtime };
    this.verify = options.verify ?? verifyRscPluginArtifact;
    this.stage = options.stage ?? stageRscPluginArtifact;
    this.start = options.start;
  }

  public async install(request: RscDeploymentInstallRequest): Promise<RscPluginDeployment> {
    if (this.shuttingDown) throw new Error('RSC deployment manager is shutting down');
    let finishInstall!: () => void;
    const pendingInstall = new Promise<void>((resolve) => { finishInstall = resolve; });
    this.pendingInstalls.add(pendingInstall);
    try {
      const verification = await this.verify(request.artifactRoot, this.runtimeCompatibility);
      const { manifest } = verification;
      if (this.shuttingDown) throw new Error('RSC deployment manager is shutting down');
      if (request.expected && (
        request.expected.pluginId !== manifest.pluginId
        || request.expected.buildId !== manifest.buildId
      )) {
        throw new Error(
          `RSC deployment identity mismatch: expected=${request.expected.pluginId}@${request.expected.buildId}, artifact=${manifest.pluginId}@${manifest.buildId}`,
        );
      }
      const deployment = {
        pluginId: manifest.pluginId,
        buildId: manifest.buildId,
        namespace: request.namespace,
      };
      return await this.enqueue(deployment, async () => {
        const deploymentKey = key(deployment);
        if (this.managed.has(deploymentKey)) {
          throw new Error(`RSC deployment is already managed: ${manifest.pluginId}@${manifest.buildId}`);
        }
        const staged = await this.stage(request.artifactRoot, verification, this.runtimeCompatibility);
        const stagedManifest = staged.verification.manifest;
        if (stagedManifest.pluginId !== manifest.pluginId || stagedManifest.buildId !== manifest.buildId) {
          await staged.cleanup();
          throw new Error('RSC staged artifact identity changed during installation');
        }
        const unregisterArtifacts = this.artifacts.register(staged.artifactRoot, stagedManifest);
        let managedRuntime: RscManagedPluginRuntime | undefined;
        let catalogInstalled = false;
        try {
          managedRuntime = await this.start({
            artifactRoot: staged.artifactRoot,
            manifest: stagedManifest,
            deployment,
          });
          if (this.shuttingDown) throw new Error('RSC deployment manager is shutting down');
          this.deployments.install(deployment, { activate: request.activate });
          catalogInstalled = true;
          this.managed.set(deploymentKey, {
            deployment,
            runtime: managedRuntime,
            unregisterArtifacts,
            cleanupArtifacts: staged.cleanup,
          });
          return { ...deployment };
        } catch (error) {
          if (catalogInstalled) this.deployments.remove(deployment);
          const cleanupErrors: unknown[] = [];
          if (managedRuntime) {
            try {
              await stopManagedRuntime(managedRuntime);
            } catch (caught) {
              cleanupErrors.push(caught);
            }
          }
          try {
            unregisterArtifacts();
          } catch (caught) {
            cleanupErrors.push(caught);
          }
          try {
            await staged.cleanup();
          } catch (caught) {
            cleanupErrors.push(caught);
          }
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [error, ...cleanupErrors],
              `RSC installation failed and cleanup reported errors: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          throw error;
        }
      });
    } finally {
      this.pendingInstalls.delete(pendingInstall);
      finishInstall();
    }
  }

  public upgrade(request: Omit<RscDeploymentInstallRequest, 'activate'>): Promise<RscPluginDeployment> {
    return this.install({ ...request, activate: true });
  }

  public activate(target: { pluginId: string; buildId: string }): void {
    if (this.shuttingDown) throw new Error('RSC deployment manager is shutting down');
    if (this.lifecycle.has(key(target))) throw new Error('RSC deployment is retiring');
    this.deployments.activate(target);
  }

  public async deactivate(target: { pluginId: string; buildId: string }): Promise<void> {
    if (this.shuttingDown) throw new Error('RSC deployment manager is shutting down');
    if (this.lifecycle.has(key(target))) throw new Error('RSC deployment is retiring');
    this.deployments.deactivate(target);
  }

  private enqueue<T>(target: { pluginId: string; buildId: string }, operation: () => Promise<T>): Promise<T> {
    const deploymentKey = key(target);
    const previous = this.lifecycle.get(deploymentKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.lifecycle.set(deploymentKey, next);
    void next.finally(() => {
      if (this.lifecycle.get(deploymentKey) === next) this.lifecycle.delete(deploymentKey);
    }).catch(() => undefined);
    return next as Promise<T>;
  }

  public retire(
    target: { pluginId: string; buildId: string },
    options: { removeArtifacts?: boolean } = {},
  ): Promise<void> {
    return this.enqueue(target, async () => {
      const deploymentKey = key(target);
      const managed = this.managed.get(deploymentKey);
      if (!managed) return;
      const snapshot = this.deployments.snapshot().find((entry) =>
        entry.pluginId === target.pluginId && entry.buildId === target.buildId);
      if (snapshot?.state === 'active') this.deployments.deactivate(target);
      if (snapshot) {
        await this.deployments.drain(target);
        if (managed.runtime) await stopManagedRuntime(managed.runtime);
        managed.runtime = undefined;
        this.deployments.remove(target);
      }
      if (options.removeArtifacts ?? true) {
        managed.unregisterArtifacts();
        await managed.cleanupArtifacts();
        this.managed.delete(deploymentKey);
      }
    });
  }

  public async removeArtifacts(target: { pluginId: string; buildId: string }): Promise<boolean> {
    const deploymentKey = key(target);
    const managed = this.managed.get(deploymentKey);
    if (!managed || managed.runtime) return false;
    managed.unregisterArtifacts();
    await managed.cleanupArtifacts();
    this.managed.delete(deploymentKey);
    return true;
  }

  public shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      await Promise.all([...this.pendingInstalls]);
      for (const managed of [...this.managed.values()]) {
        await this.retire(managed.deployment, { removeArtifacts: true });
      }
    })();
    return this.shutdownPromise;
  }
}
