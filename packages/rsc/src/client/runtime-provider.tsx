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
export type RscClientSuspensePolicy = 'remote' | 'host';
export type RscClientErrorRenderer = (
  error: unknown,
  identity: RscRemoteComponentIdentity,
  retry: () => void,
) => ReactNode;

interface RscClientRuntime {
  assetMountPath: string;
  suspensePolicy: RscClientSuspensePolicy;
  renderLoading?: RscClientLoadingRenderer;
  renderError?: RscClientErrorRenderer;
}

const RscClientRuntimeContext = createContext<RscClientRuntime>({
  assetMountPath: DEFAULT_ASSET_MOUNT_PATH,
  suspensePolicy: 'remote',
});

function normalizeAssetMountPath(value: string): string {
  if (!value.startsWith('/')) throw new TypeError('RSC asset mount path must be absolute');
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC asset mount path must not be the root path');
  return normalized;
}

function normalizeSuspensePolicy(value: unknown): RscClientSuspensePolicy {
  if (value === 'remote' || value === 'host') return value;
  throw new TypeError('RSC suspensePolicy must be "remote" or "host"');
}

export interface RscClientRuntimeProviderProps {
  assetMountPath?: string;
  suspensePolicy?: RscClientSuspensePolicy;
  renderLoading?: RscClientLoadingRenderer;
  renderError?: RscClientErrorRenderer;
  children: ReactNode;
}

export function RscClientRuntimeProvider({
  assetMountPath = DEFAULT_ASSET_MOUNT_PATH,
  suspensePolicy = 'remote',
  renderLoading,
  renderError,
  children,
}: RscClientRuntimeProviderProps) {
  const value = useMemo(() => {
    const normalizedSuspensePolicy = normalizeSuspensePolicy(suspensePolicy);
    if (normalizedSuspensePolicy === 'host' && renderLoading !== undefined) {
      throw new TypeError('RSC renderLoading is unavailable when suspensePolicy is "host"');
    }
    return {
      assetMountPath: normalizeAssetMountPath(assetMountPath),
      suspensePolicy: normalizedSuspensePolicy,
      renderLoading,
      renderError,
    };
  }, [assetMountPath, suspensePolicy, renderLoading, renderError]);
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
