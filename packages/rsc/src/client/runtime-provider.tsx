'use client';

import React, { createContext, useContext, type ReactNode } from 'react';

const DEFAULT_ASSET_MOUNT_PATH = '/_hile/rsc/assets';
const RscAssetMountContext = createContext(DEFAULT_ASSET_MOUNT_PATH);

function normalizeAssetMountPath(value: string): string {
  if (!value.startsWith('/')) throw new TypeError('RSC asset mount path must be absolute');
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC asset mount path must not be the root path');
  return normalized;
}

export interface RscClientRuntimeProviderProps {
  assetMountPath?: string;
  children: ReactNode;
}

export function RscClientRuntimeProvider({
  assetMountPath = DEFAULT_ASSET_MOUNT_PATH,
  children,
}: RscClientRuntimeProviderProps) {
  return React.createElement(
    RscAssetMountContext.Provider,
    { value: normalizeAssetMountPath(assetMountPath) },
    children,
  );
}

export function useRscAssetMountPath(): string {
  return useContext(RscAssetMountContext);
}
