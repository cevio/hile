import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  MissingExecutionContextError,
  parseExecutionContext,
  type ExecutionContext,
} from '@hile/context';
import { getRscPluginArtifactFiles, verifyRscPluginArtifact } from '@hile/rsc/artifact';
import {
  validateRscPluginManifest,
  type RscPluginManifest,
  type RscRuntimeCompatibility,
} from '@hile/rsc/protocol';
import {
  validateRscDiscoveryAnnouncement,
  type RscDiscoveryAnnouncement,
} from '@hile/rsc-discovery';

export interface HileRscArtifactClient {
  stream(
    namespace: string,
    operation: string,
    data: unknown,
    options: { context: ExecutionContext; signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>>;
}

export interface DownloadHileRscArtifactOptions {
  context: ExecutionContext;
  runtime: RscRuntimeCompatibility;
  signal?: AbortSignal;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxManifestBytes?: number;
  maxArtifactFiles?: number;
  maxPathBytes?: number;
  maxPathDepth?: number;
}

export interface DownloadedHileRscArtifact {
  artifactRoot: string;
  manifest: RscPluginManifest;
  cleanup(): Promise<void>;
}

export async function downloadHileRscArtifact(
  application: HileRscArtifactClient,
  input: RscDiscoveryAnnouncement,
  options: DownloadHileRscArtifactOptions,
): Promise<DownloadedHileRscArtifact> {
  if (!options?.context) throw new MissingExecutionContextError('RSC artifact download');
  const context = parseExecutionContext(options.context);
  const announcement = validateRscDiscoveryAnnouncement(input);
  const maxManifestBytes = options.maxManifestBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxManifestBytes) || maxManifestBytes < 1) {
    throw new TypeError('maxManifestBytes must be positive');
  }
  const maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new TypeError('maxFileBytes must be positive');
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new TypeError('maxTotalBytes must be positive');
  const maxArtifactFiles = options.maxArtifactFiles ?? 4096;
  const maxPathBytes = options.maxPathBytes ?? 1024;
  const maxPathDepth = options.maxPathDepth ?? 32;
  for (const [name, value] of Object.entries({ maxArtifactFiles, maxPathBytes, maxPathDepth })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`);
  }
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-discovered-'));
  try {
    const manifestStream = await application.stream(
      announcement.namespace,
      announcement.artifactOperation,
      { pluginId: announcement.pluginId, buildId: announcement.buildId, path: 'plugin.json' },
      { context, signal: options.signal },
    );
    let manifestBytes = 0;
    const boundedManifest = async function* () {
      for await (const chunk of manifestStream) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError('RSC artifact stream must yield Uint8Array chunks');
        manifestBytes += chunk.byteLength;
        if (manifestBytes > maxManifestBytes) throw new Error('RSC artifact manifest size limit exceeded');
        yield chunk;
      }
    };
    await pipeline(boundedManifest(), createWriteStream(path.join(root, 'plugin.json'), { flags: 'wx' }));
    let rawManifest: unknown;
    try { rawManifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8')); }
    catch { throw new TypeError('RSC artifact manifest must be valid JSON'); }
    const manifest = validateRscPluginManifest(rawManifest, options.runtime);
    if (manifest.pluginId !== announcement.pluginId || manifest.buildId !== announcement.buildId) {
      throw new Error(
        `RSC discovery identity mismatch: announcement=${announcement.pluginId}@${announcement.buildId}, manifest=${manifest.pluginId}@${manifest.buildId}`,
      );
    }
    const artifactPaths = [...getRscPluginArtifactFiles(manifest).keys()].sort();
    if (artifactPaths.length > maxArtifactFiles) throw new Error('RSC artifact file count limit exceeded');
    for (const artifactPath of artifactPaths) {
      if (Buffer.byteLength(artifactPath) > maxPathBytes || artifactPath.split('/').length > maxPathDepth) {
        throw new Error(`RSC artifact path complexity limit exceeded: ${artifactPath}`);
      }
    }
    let total = manifestBytes;
    for (const artifactPath of artifactPaths) {
      const stream = await application.stream(
        announcement.namespace,
        announcement.artifactOperation,
        { pluginId: manifest.pluginId, buildId: manifest.buildId, path: artifactPath },
        { context, signal: options.signal },
      );
      let fileBytes = 0;
      const bounded = async function* () {
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array)) throw new TypeError('RSC artifact stream must yield Uint8Array chunks');
          fileBytes += chunk.byteLength;
          total += chunk.byteLength;
          if (fileBytes > maxFileBytes || total > maxTotalBytes) {
            throw new Error(`RSC artifact size limit exceeded: ${artifactPath}`);
          }
          yield chunk;
        }
      };
      const destination = path.join(root, artifactPath);
      await mkdir(path.dirname(destination), { recursive: true });
      await pipeline(bounded(), createWriteStream(destination, { flags: 'wx' }));
    }
    const verification = await verifyRscPluginArtifact(root, options.runtime);
    return {
      artifactRoot: root,
      manifest: verification.manifest,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
