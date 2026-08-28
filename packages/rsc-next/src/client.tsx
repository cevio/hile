'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { createServerReference } from 'next/dist/compiled/react-server-dom-turbopack/client.browser.js';
import {
  configureRscServerFunctionClient,
  installRscServerReferenceRuntime,
  installRscNavigationRuntime,
  type RscClientNavigation,
  type RscServerFunctionClientOptions,
} from '@hile/rsc/client';

installRscServerReferenceRuntime((id, callServer, name) =>
  createServerReference(id, callServer, undefined, undefined, name),
);

export interface RscNextClientRuntimeProps {
  children: ReactNode;
  serverFunctions?: RscServerFunctionClientOptions;
}

/** Installs the Next Server Reference and browser navigation adapters for remote client modules. */
export function RscNextClientRuntime({ children, serverFunctions }: RscNextClientRuntimeProps) {
  const router = useRouter();
  const navigation = useMemo<RscClientNavigation>(() => ({
    push: (href, options) => router.push(href, options),
    replace: (href, options) => router.replace(href, options),
    refresh: () => router.refresh(),
    prefetch: (href) => router.prefetch(href),
  }), [router]);
  useEffect(() => installRscNavigationRuntime(navigation), [navigation]);
  if (serverFunctions) configureRscServerFunctionClient(serverFunctions);
  return children;
}
