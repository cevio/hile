'use client';

import React, { Suspense, lazy } from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { useRscAssetMountPath } from './runtime-provider';

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
  var __HILE_RSC_RESOLVE_CLIENT__: ((
    descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
    target: 'ssr' | 'browser',
  ) => RemoteClientAssetResolution | Promise<RemoteClientAssetResolution>) | undefined;
}

globalThis.__HILE_RSC_REACT__ = React;
globalThis.__HILE_RSC_JSX_RUNTIME__ = JsxRuntime;

const components = new Map<string, ReturnType<typeof lazy>>();

async function defaultBrowserResolution(
  descriptor: Omit<RemoteClientBoundaryProps, 'props'>,
  assetMountPath: string,
): Promise<RemoteClientAssetResolution> {
  const prefix = `${assetMountPath}/${encodeURIComponent(descriptor.pluginId)}/${encodeURIComponent(descriptor.buildId)}`;
  const response = await fetch(`${prefix}/plugin.json`, {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Failed to load RSC plugin manifest: ${response.status}`);
  }
  const manifest = await response.json() as {
    clients: Array<{ id: string; module: string }>;
    styles: Array<{ path: string; integrity: string }>;
  };
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
  const key = `${assetMountPath}:${descriptor.pluginId}:${descriptor.buildId}:${descriptor.referenceId}:${descriptor.exportName}`;
  let Component = components.get(key);
  if (Component) return Component;
  Component = lazy(async () => {
    const target = typeof window === 'undefined' ? 'ssr' : 'browser';
    const resolution = globalThis.__HILE_RSC_RESOLVE_CLIENT__
      ? await globalThis.__HILE_RSC_RESOLVE_CLIENT__(descriptor, target)
      : await defaultBrowserResolution(descriptor, assetMountPath);
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
  components.set(key, Component);
  return Component;
}

export default function RemoteClientBoundary({
  pluginId,
  buildId,
  referenceId,
  exportName,
  props,
}: RemoteClientBoundaryProps) {
  const assetMountPath = useRscAssetMountPath();
  const Component = componentFor({ pluginId, buildId, referenceId, exportName }, assetMountPath);
  return React.createElement(
    Suspense,
    { fallback: React.createElement('span', { 'data-hile-rsc-loading': referenceId }) },
    React.createElement(Component, props),
  );
}
