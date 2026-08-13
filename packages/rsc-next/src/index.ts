import { Readable } from 'node:stream';
import type { ReactNode } from 'react';
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
  const stream = flight instanceof Readable ? flight : Readable.from(flight);
  return createFromNodeStream(stream, {
    moduleMap: {
      [HILE_REMOTE_CLIENT_MODULE_ID]: remoteBoundaryMapping(),
    },
    serverModuleMap: getServerModuleMap(),
    moduleLoading: null,
  });
}
