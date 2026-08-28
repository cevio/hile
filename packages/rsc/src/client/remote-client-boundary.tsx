'use client';

import React, { Component, Suspense, lazy, useCallback, useState, type ReactNode } from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import {
  useRscClientRuntime,
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
const manifests = new Map<string, Promise<{
  clients: Array<{ id: string; module: string }>;
  styles: Array<{ path: string; integrity: string }>;
}>>();
const MAX_MANIFESTS = 64;
const MAX_COMPONENTS = 256;

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
}

export function clearRscClientBuildCache(
  pluginId: string,
  buildId: string,
  assetMountPath: string,
): void {
  manifests.delete(buildKey(assetMountPath, pluginId, buildId));
  const prefix = `${JSON.stringify([assetMountPath, pluginId, buildId]).slice(0, -1)},`;
  for (const key of components.keys()) {
    if (key.startsWith(prefix)) components.delete(key);
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

export async function resolveRemoteClientAssets(
  descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
  assetMountPath: string,
): Promise<RemoteClientAssetResolution> {
  const prefix = `${assetMountPath}/${encodeURIComponent(descriptor.pluginId)}/${encodeURIComponent(descriptor.buildId)}`;
  const manifestKey = buildKey(assetMountPath, descriptor.pluginId, descriptor.buildId);
  let manifestPromise = lruGet(manifests, manifestKey);
  if (!manifestPromise) {
    manifestPromise = fetch(`${prefix}/plugin.json`, {
      credentials: 'same-origin',
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to load RSC plugin manifest: ${response.status}`);
      }
      return response.json() as Promise<{
        clients: Array<{ id: string; module: string }>;
        styles: Array<{ path: string; integrity: string }>;
      }>;
    }).catch((error) => {
      if (manifests.get(manifestKey) === manifestPromise) manifests.delete(manifestKey);
      throw error;
    });
    lruSet(manifests, manifestKey, manifestPromise, MAX_MANIFESTS);
  }
  const manifest = await manifestPromise;
  const reference = manifest.clients.find(({ id }) => id === descriptor.referenceId);
  if (!reference) throw new Error(`Remote client reference not found: ${descriptor.referenceId}`);
  const fileUrl = (artifactPath: string) =>
    `${prefix}/file/${artifactPath.split('/').map(encodeURIComponent).join('/')}`;
  return {
    moduleUrl: fileUrl(reference.module),
    styles: manifest.styles.map((style) => ({
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
