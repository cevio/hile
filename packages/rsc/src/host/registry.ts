import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RscPluginManifest } from '../protocol';
import type { RemoteClientAssetResolution, RemoteClientBoundaryProps } from '../client';

export interface RegisteredRscArtifacts {
  root: string;
  manifest: RscPluginManifest;
  registration?: number;
}

export interface RscArtifactCatalog {
  get(pluginId: string, buildId: string): RegisteredRscArtifacts | undefined;
}

export interface MutableRscArtifactCatalog extends RscArtifactCatalog {
  register(root: string, manifest: RscPluginManifest): () => void;
}

export interface RscAssetUrls {
  manifest(pluginId: string, buildId: string): string;
  file(pluginId: string, buildId: string, artifactPath: string): string;
}

export type RemoteClientResolver = (
  descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
  target: 'ssr' | 'browser',
) => RemoteClientAssetResolution | Promise<RemoteClientAssetResolution>;

const resolverStackKey = Symbol.for('@hile/rsc/remote-client-resolvers');
interface ResolverStack {
  base: RemoteClientResolver | undefined;
  entries: Array<{ token: symbol; resolver: RemoteClientResolver }>;
}

function resolverStack(): ResolverStack {
  const target = globalThis as typeof globalThis & { [resolverStackKey]?: ResolverStack };
  return target[resolverStackKey] ??= {
    base: globalThis.__HILE_RSC_RESOLVE_CLIENT__,
    entries: [],
  };
}

function key(pluginId: string, buildId: string): string {
  return `${pluginId}\0${buildId}`;
}

function encodeArtifactPath(artifactPath: string): string {
  return artifactPath.split('/').map(encodeURIComponent).join('/');
}

function normalizeMountPath(mountPath: string): string {
  if (!mountPath.startsWith('/')) throw new TypeError('RSC asset mount path must be absolute');
  const normalized = mountPath.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC asset mount path must not be the root path');
  return normalized;
}

export function createRscAssetUrls(mountPath = '/_hile/rsc/assets'): RscAssetUrls {
  const mount = normalizeMountPath(mountPath);
  const prefix = (pluginId: string, buildId: string) =>
    `${mount}/${encodeURIComponent(pluginId)}/${encodeURIComponent(buildId)}`;
  return {
    manifest(pluginId, buildId) {
      return `${prefix(pluginId, buildId)}/plugin.json`;
    },
    file(pluginId, buildId, artifactPath) {
      return `${prefix(pluginId, buildId)}/file/${encodeArtifactPath(artifactPath)}`;
    },
  };
}

export class InMemoryRscArtifactCatalog implements MutableRscArtifactCatalog {
  private readonly artifacts = new Map<string, RegisteredRscArtifacts>();
  private nextRegistration = 1;

  public register(root: string, manifest: RscPluginManifest): () => void {
    const registryKey = key(manifest.pluginId, manifest.buildId);
    if (this.artifacts.has(registryKey)) {
      throw new Error(`RSC artifacts already registered: ${manifest.pluginId}@${manifest.buildId}`);
    }
    this.artifacts.set(registryKey, {
      root: path.resolve(root),
      manifest: structuredClone(manifest),
      registration: this.nextRegistration++,
    });
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.artifacts.delete(registryKey);
    };
  }

  public get(pluginId: string, buildId: string): RegisteredRscArtifacts | undefined {
    const value = this.artifacts.get(key(pluginId, buildId));
    if (!value) return undefined;
    return {
      root: value.root,
      manifest: structuredClone(value.manifest),
      registration: value.registration,
    };
  }
}

export function createRemoteClientResolver(
  catalog: RscArtifactCatalog,
  urls: RscAssetUrls = createRscAssetUrls(),
): RemoteClientResolver {
  return (descriptor, target) => {
    const registered = catalog.get(descriptor.pluginId, descriptor.buildId);
    if (!registered) {
      throw new Error(`RSC plugin artifacts are not registered: ${descriptor.pluginId}@${descriptor.buildId}`);
    }
    const reference = registered.manifest.clients.find(({ id }) => id === descriptor.referenceId);
    if (!reference || reference.exportName !== descriptor.exportName) {
      throw new Error(`RSC client reference is not registered: ${descriptor.referenceId}`);
    }
    return {
      moduleUrl: target === 'ssr'
        ? pathToFileURL(path.join(registered.root, reference.ssrModule)).href
        : urls.file(descriptor.pluginId, descriptor.buildId, reference.module),
      styles: registered.manifest.styles.map((style) => ({
        href: urls.file(descriptor.pluginId, descriptor.buildId, style.path),
        integrity: style.integrity,
      })),
    };
  };
}

export function installRemoteClientResolver(resolver: RemoteClientResolver): () => void {
  const stack = resolverStack();
  if (stack.entries.length === 0) stack.base = globalThis.__HILE_RSC_RESOLVE_CLIENT__;
  const token = Symbol('hile-rsc-resolver');
  stack.entries.push({ token, resolver });
  globalThis.__HILE_RSC_RESOLVE_CLIENT__ = resolver;
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const index = stack.entries.findIndex((entry) => entry.token === token);
    if (index >= 0) stack.entries.splice(index, 1);
    const current = stack.entries.at(-1)?.resolver ?? stack.base;
    if (current) globalThis.__HILE_RSC_RESOLVE_CLIENT__ = current;
    else delete globalThis.__HILE_RSC_RESOLVE_CLIENT__;
  };
}

const defaultCatalog = new InMemoryRscArtifactCatalog();

export function registerRscPluginArtifacts(root: string, manifest: RscPluginManifest): () => void {
  return defaultCatalog.register(root, manifest);
}

export function getRscPluginArtifacts(
  pluginId: string,
  buildId: string,
): RegisteredRscArtifacts | undefined {
  return defaultCatalog.get(pluginId, buildId);
}

export function getDefaultRscArtifactCatalog(): RscArtifactCatalog {
  return defaultCatalog;
}
