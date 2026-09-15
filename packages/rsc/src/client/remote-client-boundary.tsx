'use client';

import React, { Component, Suspense, lazy, useCallback, useState, type ReactNode } from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import { selectRscClientStyles } from '../protocol/style-selection';
import {
  useRscClientRuntime,
  normalizeRscAssetMountPath,
  type RscClientErrorRenderer,
  type RscClientLoadingRenderer,
  type RscClientSuspensePolicy,
  type RscRemoteComponentIdentity,
} from './runtime-provider';

export interface RemoteClientBoundaryProps {
  pluginId: string;
  buildId: string;
  referenceId: string;
  exportName: string;
  props: Record<string, unknown>;
}

export interface RemoteClientAssetResolution {
  moduleUrl: string;
  styles: Array<{ href: string; integrity?: string }>;
}

interface RscPublicClientReference {
  id: string;
  module: string;
  chunks?: Array<{ path: string; integrity: string; size?: number }>;
  integrity?: string;
  size?: number;
  styles?: string[];
}

interface RscPublicPluginManifest {
  clients: RscPublicClientReference[];
  styles: Array<{
    path: string;
    integrity: string;
    size?: number;
    scope?: 'plugin' | 'client';
  }>;
  routes?: Array<{
    path: string;
    prefetch?: 'none' | 'assets' | 'route';
    clientReferences?: string[];
  }>;
}

export interface RscRouteAssetPreloadOptions {
  pluginId: string;
  buildId: string;
  path: string;
  assetMountPath?: string;
  /** Maximum total immutable bytes allowed for one route preload. Defaults to 256 KiB. */
  budgetBytes?: number;
  /** Maximum immutable files allowed for one route preload. Defaults to 128. */
  maxFiles?: number;
}

export interface RscRouteAssetPreloadResult {
  status: 'preloaded' | 'skipped';
  reason?: 'route' | 'policy' | 'metadata' | 'budget' | 'files' | 'unsupported';
  files: string[];
  bytes: number;
}

declare global {
  var __HILE_RSC_REACT__: typeof React | undefined;
  var __HILE_RSC_JSX_RUNTIME__: typeof JsxRuntime | undefined;
  var __HILE_RSC_REACT_DOM__: typeof ReactDom | undefined;
  var __HILE_RSC_REACT_DOM_CLIENT__: typeof ReactDomClient | undefined;
  var __HILE_RSC_RESOLVE_CLIENT__: ((
    descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
    target: 'ssr' | 'browser',
  ) => RemoteClientAssetResolution | Promise<RemoteClientAssetResolution>) | undefined;
}

globalThis.__HILE_RSC_REACT__ = React;
globalThis.__HILE_RSC_JSX_RUNTIME__ = JsxRuntime;
globalThis.__HILE_RSC_REACT_DOM__ = ReactDom;
globalThis.__HILE_RSC_REACT_DOM_CLIENT__ = ReactDomClient;

const components = new Map<string, ReturnType<typeof lazy>>();
const manifests = new Map<string, Promise<RscPublicPluginManifest>>();
const preloadedAssets = new Map<string, HTMLLinkElement>();
const MAX_MANIFESTS = 64;
const MAX_COMPONENTS = 256;
const MAX_PRELOADED_ASSETS = 1_024;
const DEFAULT_ROUTE_PRELOAD_FILES = 128;

function removePreloadLink(link: HTMLLinkElement): void {
  if (typeof link.remove === 'function') link.remove();
  else link.parentNode?.removeChild(link);
}

function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}

export function clearRscClientCaches(): void {
  manifests.clear();
  components.clear();
  for (const link of preloadedAssets.values()) removePreloadLink(link);
  preloadedAssets.clear();
}

export function clearRscClientBuildCache(
  pluginId: string,
  buildId: string,
  assetMountPath: string,
): void {
  assetMountPath = normalizeRscAssetMountPath(assetMountPath);
  manifests.delete(buildKey(assetMountPath, pluginId, buildId));
  const prefix = `${JSON.stringify([assetMountPath, pluginId, buildId]).slice(0, -1)},`;
  for (const key of components.keys()) {
    if (key.startsWith(prefix)) components.delete(key);
  }
  const assetPrefix = `${assetMountPath}/${encodeURIComponent(pluginId)}/${encodeURIComponent(buildId)}/`;
  for (const [href, link] of preloadedAssets) {
    if (!href.startsWith(assetPrefix)) continue;
    removePreloadLink(link);
    preloadedAssets.delete(href);
  }
}

function buildKey(assetMountPath: string, pluginId: string, buildId: string): string {
  return JSON.stringify([assetMountPath, pluginId, buildId]);
}

function remoteKey(
  assetMountPath: string,
  descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
): string {
  return JSON.stringify([
    assetMountPath,
    descriptor.pluginId,
    descriptor.buildId,
    descriptor.referenceId,
    descriptor.exportName,
  ]);
}

function manifestFor(
  pluginId: string,
  buildId: string,
  assetMountPath: string,
): Promise<RscPublicPluginManifest> {
  const prefix = `${assetMountPath}/${encodeURIComponent(pluginId)}/${encodeURIComponent(buildId)}`;
  const manifestKey = buildKey(assetMountPath, pluginId, buildId);
  let manifestPromise = lruGet(manifests, manifestKey);
  if (!manifestPromise) {
    manifestPromise = fetch(`${prefix}/plugin.json`, {
      credentials: 'same-origin',
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load RSC plugin manifest: ${response.status}`);
      }
      return response.json() as Promise<RscPublicPluginManifest>;
    }).catch((error) => {
      if (manifests.get(manifestKey) === manifestPromise) manifests.delete(manifestKey);
      throw error;
    });
    lruSet(manifests, manifestKey, manifestPromise, MAX_MANIFESTS);
  }
  return manifestPromise;
}

function routeMatches(pattern: string, requestedPath: string): boolean {
  const patternSegments = pattern === '/' ? [] : pattern.slice(1).split('/');
  const requestedSegments = requestedPath === '/' ? [] : requestedPath.slice(1).split('/');
  return patternSegments.length === requestedSegments.length
    && patternSegments.every((segment, index) => (
      /^\[[A-Za-z][A-Za-z0-9_]*\]$/.test(segment)
        ? requestedSegments[index].length > 0
        : segment === requestedSegments[index]
    ));
}

function routeSpecificity(pattern: string): number {
  return (pattern === '/' ? [] : pattern.slice(1).split('/'))
    .filter((segment) => !/^\[[A-Za-z][A-Za-z0-9_]*\]$/.test(segment))
    .length;
}

function appendPreloadLink(
  href: string,
  asset: { integrity?: string },
  kind: 'style' | 'module',
): void {
  if (lruGet(preloadedAssets, href)) return;
  const ownerDocument = typeof document === 'undefined' ? undefined : document;
  if (!ownerDocument?.head) return;
  const link = ownerDocument.createElement('link');
  link.rel = kind === 'style' ? 'preload' : 'modulepreload';
  if (kind === 'style') link.as = 'style';
  link.href = href;
  if (asset.integrity) {
    link.integrity = asset.integrity;
    link.crossOrigin = 'anonymous';
  }
  ownerDocument.head.appendChild(link);
  preloadedAssets.set(href, link);
  while (preloadedAssets.size > MAX_PRELOADED_ASSETS) {
    const oldestHref = preloadedAssets.keys().next().value!;
    const oldestLink = preloadedAssets.get(oldestHref);
    if (oldestLink) removePreloadLink(oldestLink);
    preloadedAssets.delete(oldestHref);
  }
}

/** Preloads safe, immutable browser assets for one manifest-declared route. */
export async function preloadRscRouteAssets(
  options: RscRouteAssetPreloadOptions,
): Promise<RscRouteAssetPreloadResult> {
  const assetMountPath = normalizeRscAssetMountPath(
    options.assetMountPath ?? '/_hile/rsc/assets',
  );
  const budgetBytes = options.budgetBytes ?? 256 * 1024;
  const maxFiles = options.maxFiles ?? DEFAULT_ROUTE_PRELOAD_FILES;
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
    throw new TypeError('RSC route preload budget must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_PRELOADED_ASSETS) {
    throw new TypeError(`RSC route preload maxFiles must be between 1 and ${MAX_PRELOADED_ASSETS}`);
  }
  const manifest = await manifestFor(options.pluginId, options.buildId, assetMountPath);
  const route = manifest.routes
    ?.filter((candidate) => routeMatches(candidate.path, options.path))
    .sort((left, right) => routeSpecificity(right.path) - routeSpecificity(left.path))[0];
  if (!route) return { status: 'skipped', reason: 'route', files: [], bytes: 0 };
  if (route.prefetch === 'none') {
    return { status: 'skipped', reason: 'policy', files: [], bytes: 0 };
  }
  if (!route.clientReferences) {
    return { status: 'skipped', reason: 'metadata', files: [], bytes: 0 };
  }
  const clients = route.clientReferences
    .map((id) => manifest.clients.find((candidate) => candidate.id === id))
    .filter((client): client is RscPublicClientReference => client !== undefined);
  if (clients.length !== route.clientReferences.length) {
    return { status: 'skipped', reason: 'metadata', files: [], bytes: 0 };
  }
  const styles = selectRscClientStyles(manifest.styles, clients);
  if (!styles) return { status: 'skipped', reason: 'metadata', files: [], bytes: 0 };
  const prefix = `${assetMountPath}/${encodeURIComponent(options.pluginId)}/${encodeURIComponent(options.buildId)}`;
  const fileUrl = (artifactPath: string) =>
    `${prefix}/file/${artifactPath.split('/').map(encodeURIComponent).join('/')}`;
  const assets = [
    ...styles.map((asset) => ({ ...asset, kind: 'style' as const })),
    ...clients.flatMap((client) => [
        { path: client.module, integrity: client.integrity, size: client.size, kind: 'module' as const },
        ...(client.chunks ?? []).map((asset) => ({ ...asset, kind: 'module' as const })),
      ]),
  ];
  const unique = [...new Map(assets.map((asset) => [asset.path, asset])).values()];
  if (unique.length > maxFiles) {
    return { status: 'skipped', reason: 'files', files: [], bytes: 0 };
  }
  if (unique.some(({ size }) => size === undefined)) {
    return { status: 'skipped', reason: 'metadata', files: [], bytes: 0 };
  }
  const bytes = unique.reduce((total, asset) => total + asset.size!, 0);
  if (bytes > budgetBytes) {
    return { status: 'skipped', reason: 'budget', files: [], bytes };
  }
  if (typeof document === 'undefined' || !document.head) {
    return { status: 'skipped', reason: 'unsupported', files: [], bytes };
  }
  const files = unique.map((asset) => fileUrl(asset.path));
  unique.forEach((asset, index) => appendPreloadLink(files[index], asset, asset.kind));
  return { status: 'preloaded', files, bytes };
}

export async function resolveRemoteClientAssets(
  descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
  assetMountPath: string,
): Promise<RemoteClientAssetResolution> {
  assetMountPath = normalizeRscAssetMountPath(assetMountPath);
  const prefix = `${assetMountPath}/${encodeURIComponent(descriptor.pluginId)}/${encodeURIComponent(descriptor.buildId)}`;
  const manifest = await manifestFor(descriptor.pluginId, descriptor.buildId, assetMountPath);
  const reference = manifest.clients.find(({ id }) => id === descriptor.referenceId);
  if (!reference) throw new Error(`Remote client reference not found: ${descriptor.referenceId}`);
  const styles = selectRscClientStyles(manifest.styles, [reference]);
  if (!styles) throw new Error(`Remote client style metadata is incomplete: ${descriptor.referenceId}`);
  const fileUrl = (artifactPath: string) =>
    `${prefix}/file/${artifactPath.split('/').map(encodeURIComponent).join('/')}`;
  return {
    moduleUrl: fileUrl(reference.module),
    styles: styles.map((style) => ({
      href: fileUrl(style.path),
      integrity: style.integrity,
    })),
  };
}

function importModule(moduleUrl: string): Promise<Record<string, unknown>> {
  return import(/* webpackIgnore: true */ moduleUrl) as Promise<Record<string, unknown>>;
}

function componentFor(
  descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
  assetMountPath: string,
) {
  const key = remoteKey(assetMountPath, descriptor);
  let Component = lruGet(components, key);
  if (Component) return Component;
  Component = lazy(async () => {
    const target = typeof window === 'undefined' ? 'ssr' : 'browser';
    const resolution = globalThis.__HILE_RSC_RESOLVE_CLIENT__
      ? await globalThis.__HILE_RSC_RESOLVE_CLIENT__(descriptor, target)
      : await resolveRemoteClientAssets(descriptor, assetMountPath);
    const moduleExports = await importModule(resolution.moduleUrl);
    const RemoteComponent = moduleExports[descriptor.exportName];
    if (typeof RemoteComponent !== 'function' && typeof RemoteComponent !== 'object') {
      throw new Error(`Remote client export not found: ${descriptor.referenceId}`);
    }
    return {
      default: function ResolvedRemoteComponent(props: Record<string, unknown>) {
        return React.createElement(
          React.Fragment,
          null,
          resolution.styles.map((style) => React.createElement('link', {
            key: style.href,
            rel: 'stylesheet',
            href: style.href,
            integrity: style.integrity,
            crossOrigin: style.integrity ? 'anonymous' : undefined,
            precedence: 'hile-rsc-plugin',
          })),
          React.createElement(RemoteComponent as React.ComponentType<any>, props),
        );
      },
    };
  });
  lruSet(components, key, Component, MAX_COMPONENTS);
  return Component;
}

function componentKey(
  descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
  assetMountPath: string,
): string {
  return remoteKey(assetMountPath, descriptor);
}

export function renderRemoteClientErrorFallback(
  error: unknown,
  identity: RscRemoteComponentIdentity,
  retry: () => void,
  renderError?: RscClientErrorRenderer,
): ReactNode {
  if (renderError) return renderError(error, identity, retry);
  return React.createElement('span', {
    role: 'alert',
    'data-hile-rsc-error': identity.referenceId,
  }, 'Remote component failed to load');
}

export function renderRemoteClientSuspense(
  suspensePolicy: RscClientSuspensePolicy,
  identity: RscRemoteComponentIdentity,
  children: ReactNode,
  renderLoading?: RscClientLoadingRenderer,
): ReactNode {
  if (suspensePolicy === 'host') return children;
  return React.createElement(
    Suspense,
    {
      fallback: renderLoading
        ? renderLoading(identity)
        : React.createElement('span', { 'data-hile-rsc-loading': identity.referenceId }),
    },
    children,
  );
}

interface RemoteClientErrorBoundaryProps {
  identity: RscRemoteComponentIdentity;
  renderError?: RscClientErrorRenderer;
  onRetry(): void;
  children?: ReactNode;
}

class RemoteClientErrorBoundary extends Component<
  RemoteClientErrorBoundaryProps,
  { failed: boolean; error?: unknown }
> {
  public state = { failed: false, error: undefined };

  public static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  private readonly retry = () => {
    this.props.onRetry();
    this.setState({ failed: false, error: undefined });
  };

  public render() {
    if (this.state.failed) {
      return renderRemoteClientErrorFallback(
        this.state.error,
        this.props.identity,
        this.retry,
        this.props.renderError,
      );
    }
    return this.props.children;
  }
}

export default function RemoteClientBoundary({
  pluginId,
  buildId,
  referenceId,
  exportName,
  props,
}: RemoteClientBoundaryProps) {
  const { assetMountPath, suspensePolicy, renderLoading, renderError } = useRscClientRuntime();
  const identity = { pluginId, buildId, referenceId, exportName };
  const key = componentKey(identity, assetMountPath);
  const [attempt, setAttempt] = useState(0);
  const Component = componentFor(identity, assetMountPath);
  const retry = useCallback(() => {
    clearRscClientBuildCache(pluginId, buildId, assetMountPath);
    setAttempt((value) => value + 1);
  }, [pluginId, buildId, assetMountPath]);
  return React.createElement(
    RemoteClientErrorBoundary,
    { key, identity, renderError, onRetry: retry },
    renderRemoteClientSuspense(
      suspensePolicy,
      identity,
      React.createElement(Component, { ...props, key: attempt }),
      renderLoading,
    ),
  );
}
