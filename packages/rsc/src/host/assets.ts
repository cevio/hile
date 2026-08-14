import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { RscPluginManifest } from '../protocol';
import {
  getDefaultRscArtifactCatalog,
  type RscArtifactCatalog,
} from './registry';

export interface RscAssetContext {
  path: string;
  status: number;
  type?: string;
  body?: unknown;
  set(name: string, value: string): void;
}

export interface RscAssetMiddlewareOptions {
  catalog?: RscArtifactCatalog;
  mountPath?: string;
  metadataCacheSize?: number;
}

interface PublicAssetMetadata {
  source: string;
  files: Set<string>;
  manifest: ReturnType<typeof publicManifest>;
}

function assetMetadata(manifest: RscPluginManifest): PublicAssetMetadata {
  const files = new Set<string>();
  const clients = manifest.clients;
  for (const client of clients) {
    files.add(client.module);
    for (const chunk of client.chunks) files.add(chunk.path);
  }
  for (const style of manifest.styles) files.add(style.path);
  return {
    source: '',
    files,
    manifest: publicManifest(manifest, clients),
  };
}

function publicManifest(manifest: RscPluginManifest, clients = manifest.clients) {
  return {
    protocolVersion: manifest.protocolVersion,
    pluginId: manifest.pluginId,
    buildId: manifest.buildId,
    clients: clients.map(({ id, module, exportName, chunks, integrity }) => ({
      id, module, exportName, chunks, integrity,
    })),
    styles: manifest.styles,
  };
}

function decodeSegments(value: string): string | undefined {
  try {
    const decoded = value.split('/').map(decodeURIComponent);
    if (decoded.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
      return undefined;
    }
    return decoded.join('/');
  } catch {
    return undefined;
  }
}

function contentType(artifactPath: string): string {
  if (artifactPath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (artifactPath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (artifactPath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function normalizeMountPath(mountPath: string): string {
  if (!mountPath.startsWith('/')) throw new TypeError('RSC asset mount path must be absolute');
  const normalized = mountPath.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC asset mount path must not be the root path');
  return normalized;
}

export function createRscAssetMiddleware(options: RscAssetMiddlewareOptions = {}) {
  const catalog = options.catalog ?? getDefaultRscArtifactCatalog();
  const prefix = `${normalizeMountPath(options.mountPath ?? '/_hile/rsc/assets')}/`;
  const cacheLimit = options.metadataCacheSize ?? 256;
  if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 1) {
    throw new TypeError('RSC asset metadata cache size must be a positive safe integer');
  }
  const metadataCache = new Map<string, PublicAssetMetadata>();
  return async (ctx: RscAssetContext, next: () => Promise<unknown>) => {
    if (!ctx.path.startsWith(prefix)) return next();
    const segments = ctx.path.slice(prefix.length).split('/');
    if (segments.length < 3) {
      ctx.status = 404;
      return;
    }
    let pluginId: string;
    let buildId: string;
    try {
      pluginId = decodeURIComponent(segments.shift()!);
      buildId = decodeURIComponent(segments.shift()!);
    } catch {
      ctx.status = 400;
      return;
    }
    const registered = catalog.get(pluginId, buildId);
    if (!registered) {
      metadataCache.delete(`${pluginId}\0${buildId}`);
      ctx.status = 404;
      return;
    }
    const cacheKey = `${pluginId}\0${buildId}`;
    const cacheable = registered.registration !== undefined;
    const metadataSource = `${registered.root}\0${registered.registration ?? ''}`;
    let metadata = cacheable ? metadataCache.get(cacheKey) : undefined;
    if (metadata?.source !== metadataSource) {
      metadataCache.delete(cacheKey);
      metadata = undefined;
    }
    if (metadata) {
      metadataCache.delete(cacheKey);
      metadataCache.set(cacheKey, metadata);
    } else {
      metadata = assetMetadata(registered.manifest);
      metadata.source = metadataSource;
      if (cacheable) {
        metadataCache.set(cacheKey, metadata);
        while (metadataCache.size > cacheLimit) {
          metadataCache.delete(metadataCache.keys().next().value!);
        }
      }
    }
    if (segments.length === 1 && segments[0] === 'plugin.json') {
      ctx.status = 200;
      ctx.type = 'application/json; charset=utf-8';
      ctx.set('Cache-Control', 'public, max-age=31536000, immutable');
      ctx.set('X-Content-Type-Options', 'nosniff');
      ctx.body = metadata.manifest;
      return;
    }
    if (segments.shift() !== 'file') {
      ctx.status = 404;
      return;
    }
    const artifactPath = decodeSegments(segments.join('/'));
    if (!artifactPath || !metadata.files.has(artifactPath)) {
      ctx.status = 404;
      return;
    }
    const absolute = path.resolve(registered.root, artifactPath);
    if (!absolute.startsWith(`${registered.root}${path.sep}`)) {
      ctx.status = 404;
      return;
    }
    ctx.status = 200;
    ctx.type = contentType(artifactPath);
    ctx.set('Cache-Control', 'public, max-age=31536000, immutable');
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.set('Cross-Origin-Resource-Policy', 'same-origin');
    ctx.body = createReadStream(absolute);
  };
}
