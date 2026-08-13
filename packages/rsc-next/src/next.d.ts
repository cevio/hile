declare module 'next/dist/compiled/react-server-dom-turbopack/client.node.js' {
  import type { Readable } from 'node:stream';
  import type { ReactNode } from 'react';
  export function createFromNodeStream(
    stream: Readable,
    manifest: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<ReactNode>;
}

declare module 'next/dist/compiled/react-server-dom-turbopack/client.browser.js' {
  export function createServerReference(
    id: string,
    callServer: (id: string, args: unknown[]) => Promise<unknown>,
    encodeFormAction?: unknown,
    findSourceMapURL?: unknown,
    functionName?: string,
  ): (...args: unknown[]) => Promise<unknown>;
}

declare module 'next/dist/server/app-render/manifests-singleton.js' {
  export function getClientReferenceManifest(): {
    clientModules: Record<string, { id: string | number; name: string; chunks: string[]; async?: boolean }>;
    rscModuleMapping: Record<string | number, Record<string, {
      id: string | number;
      name: string;
      chunks: string[];
      async?: boolean;
    }>>;
  };
  export function getServerModuleMap(): unknown;
}
