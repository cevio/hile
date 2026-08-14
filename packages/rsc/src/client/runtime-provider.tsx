'use client';

import React, { createContext, useContext, useMemo, type ReactNode } from 'react';

const DEFAULT_ASSET_MOUNT_PATH = '/_hile/rsc/assets';

export interface RscRemoteComponentIdentity {
  pluginId: string;
  buildId: string;
  referenceId: string;
  exportName: string;
}

export type RscClientLoadingRenderer = (identity: RscRemoteComponentIdentity) => ReactNode;
export type RscClientErrorRenderer = (
  error: unknown,
  identity: RscRemoteComponentIdentity,
  retry: () => void,
) => ReactNode;

interface RscClientRuntime {
  assetMountPath: string;
  renderLoading?: RscClientLoadingRenderer;
  renderError?: RscClientErrorRenderer;
}

const RscClientRuntimeContext = createContext<RscClientRuntime>({
  assetMountPath: DEFAULT_ASSET_MOUNT_PATH,
});

function normalizeAssetMountPath(value: string): string {
  if (!value.startsWith('/')) throw new TypeError('RSC asset mount path must be absolute');
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC asset mount path must not be the root path');
  return normalized;
}

export interface RscClientRuntimeProviderProps {
  assetMountPath?: string;
  renderLoading?: RscClientLoadingRenderer;
  renderError?: RscClientErrorRenderer;
  children: ReactNode;
}

export function RscClientRuntimeProvider({
  assetMountPath = DEFAULT_ASSET_MOUNT_PATH,
  renderLoading,
  renderError,
  children,
}: RscClientRuntimeProviderProps) {
  const value = useMemo(() => ({
    assetMountPath: normalizeAssetMountPath(assetMountPath),
    renderLoading,
    renderError,
  }), [assetMountPath, renderLoading, renderError]);
  return React.createElement(
    RscClientRuntimeContext.Provider,
    { value },
    children,
  );
}

export function useRscAssetMountPath(): string {
  return useContext(RscClientRuntimeContext).assetMountPath;
}

export function useRscClientRuntime(): Readonly<RscClientRuntime> {
  return useContext(RscClientRuntimeContext);
}
