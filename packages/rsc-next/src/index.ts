import { Readable } from 'node:stream';
import type { ReactNode } from 'react';
import nextPackage from 'next/package.json' with { type: 'json' };
import reactPackage from 'react/package.json' with { type: 'json' };
import reactDomPackage from 'react-dom/package.json' with { type: 'json' };
import { createFromNodeStream } from 'next/dist/compiled/react-server-dom-turbopack/client.node.js';
import {
  getClientReferenceManifest,
  getServerModuleMap,
} from 'next/dist/server/app-render/manifests-singleton.js';
import {
  HILE_REMOTE_CLIENT_MODULE_ID,
} from '@hile/rsc/protocol';
import { RemoteClientBoundary } from '@hile/rsc/client';

// Keep a static server-to-client edge so Next includes this package client boundary
// in the host route client reference manifest.
void RemoteClientBoundary;

export const HILE_RSC_NEXT_COMPATIBILITY = Object.freeze({
  next: '16.3.0',
  react: '19.2.8',
  reactDom: '19.2.8',
});

export interface RscNextRuntimeVersions {
  next: string;
  react: string;
  reactDom: string;
}

export function assertRscNextCompatibility(
  runtime: RscNextRuntimeVersions = {
    next: nextPackage.version,
    react: reactPackage.version,
    reactDom: reactDomPackage.version,
  },
): void {
  if (
    runtime.next !== HILE_RSC_NEXT_COMPATIBILITY.next
    || runtime.react !== HILE_RSC_NEXT_COMPATIBILITY.react
    || runtime.reactDom !== HILE_RSC_NEXT_COMPATIBILITY.reactDom
  ) {
    throw new Error(
      `Unsupported RSC Next runtime: Next ${runtime.next} + React ${runtime.react} + ReactDOM ${runtime.reactDom}; `
      + `supported tuple is Next ${HILE_RSC_NEXT_COMPATIBILITY.next} `
      + `+ React ${HILE_RSC_NEXT_COMPATIBILITY.react} `
      + `+ ReactDOM ${HILE_RSC_NEXT_COMPATIBILITY.reactDom}`,
    );
  }
}

function remoteBoundaryMapping() {
  const manifest = getClientReferenceManifest();
  const sourceId = (RemoteClientBoundary as unknown as { $$id?: string }).$$id;
  const sourceModule = sourceId?.replace(/#default$/, '');
  const clientEntry = sourceModule ? manifest.clientModules[sourceModule] : undefined;
  if (!sourceId || !clientEntry) {
    throw new Error(
      `RemoteClientBoundary is missing from the Next client reference manifest: ${String(sourceId)}`,
    );
  }
  const browserModuleId = clientEntry.id;
  const mapping = manifest.rscModuleMapping[browserModuleId];
  if (!mapping) {
    throw new Error(`RemoteClientBoundary has no Next RSC module mapping: ${String(browserModuleId)}`);
  }
  return mapping;
}

export async function decodePluginFlight(
  flight: AsyncIterable<Uint8Array> | Readable,
): Promise<ReactNode> {
  assertRscNextCompatibility();
  const stream = flight instanceof Readable ? flight : Readable.from(flight);
  return createFromNodeStream(stream, {
    moduleMap: {
      [HILE_REMOTE_CLIENT_MODULE_ID]: remoteBoundaryMapping(),
    },
    serverModuleMap: getServerModuleMap(),
    moduleLoading: null,
  });
}
