import { createReadStream } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import type { RscPluginManifest } from '@hile/rsc/protocol';
import {
  createRscDiscoveryTopic,
  canonicalizeRscDiscoveryAnnouncement,
  validateRscDiscoveryAnnouncement,
  type RscDiscoveryAnnouncement,
} from '@hile/rsc-discovery';

interface DiscoveryPublication {
  update(payload: RscDiscoveryAnnouncement): Promise<unknown>;
  unpublish(): Promise<unknown>;
}

export interface HileRscDiscoveryPublisherApplication {
  register(operation: string, handler: (input: { data: unknown; signal?: AbortSignal }) => unknown): () => void;
  publish(topic: string, payload: RscDiscoveryAnnouncement): Promise<DiscoveryPublication>;
}

export interface RegisterHileRscPluginDiscoveryOptions {
  application: HileRscDiscoveryPublisherApplication;
  namespace: string;
  instanceId: string;
  priority: number;
  artifactRoot: string;
  artifactOperation?: string;
  retainedArtifacts?: number;
  authentication: { keyId: string; secret: string | Uint8Array };
}

export interface HileRscPluginDiscoveryRegistration {
  readonly topic: string;
  announcement(): RscDiscoveryAnnouncement;
  update(artifactRoot: string): Promise<RscDiscoveryAnnouncement>;
  close(): Promise<void>;
}

interface PublishedArtifact {
  root: string;
  manifest: RscPluginManifest;
  files: ReadonlySet<string>;
}

function createAnnouncement(
  options: RegisterHileRscPluginDiscoveryOptions,
  manifest: RscPluginManifest,
  artifactOperation: string,
): RscDiscoveryAnnouncement {
  const unsigned = {
    schemaVersion: 1,
    capability: '@hile/rsc',
    instanceId: options.instanceId,
    pluginId: manifest.pluginId,
    buildId: manifest.buildId,
    namespace: options.namespace,
    priority: options.priority,
    protocolVersion: manifest.protocolVersion,
    runtime: manifest.runtime,
    artifactOperation,
  } as const;
  const signature = createHmac('sha256', options.authentication.secret)
    .update(canonicalizeRscDiscoveryAnnouncement(unsigned))
    .digest('base64url');
  return validateRscDiscoveryAnnouncement({
    ...unsigned,
    authentication: {
      scheme: 'hmac-sha256',
      keyId: options.authentication.keyId,
      signature,
    },
  });
}

async function inspectPublishedArtifact(root: string): Promise<PublishedArtifact> {
  const initial = await import('@hile/rsc/artifact').then(({ inspectRscPluginArtifact }) =>
    inspectRscPluginArtifact(root));
  const verification = await verifyRscPluginArtifact(root, initial.runtime);
  return {
    root: path.resolve(root),
    manifest: verification.manifest,
    files: new Set([...verification.files, 'plugin.json']),
  };
}

function artifactRequest(value: unknown): { pluginId: string; buildId: string; path: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('RSC artifact request must be an object');
  }
  const request = value as Record<string, unknown>;
  for (const name of ['pluginId', 'buildId', 'path'] as const) {
    if (typeof request[name] !== 'string' || request[name].length === 0) {
      throw new TypeError(`RSC artifact request ${name} must not be empty`);
    }
  }
  return request as { pluginId: string; buildId: string; path: string };
}

export async function registerHileRscPluginDiscovery(
  options: RegisterHileRscPluginDiscoveryOptions,
): Promise<HileRscPluginDiscoveryRegistration> {
  if (!options.authentication.keyId || Buffer.byteLength(options.authentication.keyId) > 1024) {
    throw new TypeError('RSC discovery authentication keyId must not be empty or oversized');
  }
  if (
    (typeof options.authentication.secret === 'string' && options.authentication.secret.length === 0)
    || (options.authentication.secret instanceof Uint8Array && options.authentication.secret.byteLength === 0)
  ) {
    throw new TypeError('RSC discovery authentication secret must not be empty');
  }
  const retainedArtifacts = options.retainedArtifacts ?? 2;
  if (!Number.isSafeInteger(retainedArtifacts) || retainedArtifacts < 1) {
    throw new TypeError('retainedArtifacts must be a positive safe integer');
  }
  const artifactOperation = options.artifactOperation ?? '/-/rsc/artifact';
  const first = await inspectPublishedArtifact(options.artifactRoot);
  const topic = createRscDiscoveryTopic(options.instanceId);
  const artifacts = new Map<string, PublishedArtifact>([[first.manifest.buildId, first]]);
  let current = createAnnouncement(options, first.manifest, artifactOperation);
  let closed = false;
  let closing = false;
  const unregister = options.application.register(artifactOperation, ({ data, signal }) => {
    const request = artifactRequest(data);
    const artifact = artifacts.get(request.buildId);
    if (
      !artifact
      || artifact.manifest.pluginId !== request.pluginId
      || !artifact.files.has(request.path)
    ) {
      throw new TypeError(`RSC artifact path is not declared: ${request.path}`);
    }
    return createReadStream(path.join(artifact.root, request.path), { signal });
  });
  let publication: DiscoveryPublication;
  try {
    publication = await options.application.publish(topic, current);
  } catch (error) {
    unregister();
    throw error;
  }
  let queue: Promise<unknown> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let unpublished = false;
  let unregistered = false;
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    topic,
    announcement: () => structuredClone(current),
    async update(artifactRoot) {
      if (closing || closed) throw new Error('RSC discovery registration is closed');
      return enqueue(async () => {
        const nextArtifact = await inspectPublishedArtifact(artifactRoot);
        if (nextArtifact.manifest.pluginId !== current.pluginId) {
          throw new TypeError('RSC discovery update pluginId must remain stable');
        }
        const next = createAnnouncement(options, nextArtifact.manifest, artifactOperation);
        const previous = artifacts.get(next.buildId);
        if (previous) {
          if (JSON.stringify(previous.manifest) !== JSON.stringify(nextArtifact.manifest)) {
            throw new TypeError(`RSC discovery buildId is immutable: ${next.buildId}`);
          }
          return structuredClone(current);
        }
        artifacts.set(next.buildId, nextArtifact);
        try {
          await publication.update(next);
        } catch (error) {
          artifacts.delete(next.buildId);
          throw error;
        }
        current = next;
        while (artifacts.size > retainedArtifacts) {
          const oldest = artifacts.keys().next().value as string;
          if (oldest === current.buildId) break;
          artifacts.delete(oldest);
        }
        return structuredClone(current);
      });
    },
    async close() {
      if (closed) return;
      if (closePromise) return closePromise;
      closing = true;
      const operation = (async () => {
        await queue.catch(() => undefined);
        if (!unpublished) {
          await publication.unpublish();
          unpublished = true;
        }
        if (!unregistered) {
          unregister();
          unregistered = true;
        }
        artifacts.clear();
        closed = true;
      })();
      const tracked = operation.catch((error) => {
        if (closePromise === tracked) closePromise = undefined;
        throw error;
      });
      closePromise = tracked;
      return tracked;
    },
  };
}
