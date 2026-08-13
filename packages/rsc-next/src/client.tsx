'use client';

import type { ReactNode } from 'react';
import { createServerReference } from 'next/dist/compiled/react-server-dom-turbopack/client.browser.js';
import {
  configureRscServerFunctionClient,
  installRscServerReferenceRuntime,
  type RscServerFunctionClientOptions,
} from '@hile/rsc/client';

installRscServerReferenceRuntime((id, callServer, name) =>
  createServerReference(id, callServer, undefined, undefined, name),
);

export interface RscNextClientRuntimeProps {
  children: ReactNode;
  serverFunctions?: RscServerFunctionClientOptions;
}

/** Installs the Next/Turbopack Server Reference adapter before remote client modules load. */
export function RscNextClientRuntime({ children, serverFunctions }: RscNextClientRuntimeProps) {
  if (serverFunctions) configureRscServerFunctionClient(serverFunctions);
  return children;
}
