declare module 'react-server-dom-webpack/server.node' {
  import type { ReactNode } from 'react';
  import type { Writable } from 'node:stream';

  export interface ClientManifestEntry {
    id: string;
    chunks: string[];
    name: string;
    async?: boolean;
  }

  export interface RenderOptions {
    onError?: (error: unknown) => void;
    identifierPrefix?: string;
    environmentName?: string;
  }

  export function renderToPipeableStream(
    model: ReactNode,
    webpackMap: Record<string, ClientManifestEntry>,
    options?: RenderOptions,
  ): { pipe(destination: Writable): void; abort(reason?: unknown): void };

  export function registerClientReference<T extends Function>(
    proxyImplementation: T,
    id: string,
    exportName: string,
  ): T;
}

declare module 'react-server-dom-webpack/client.node' {
  import type { Readable } from 'node:stream';
  import type { ReactNode } from 'react';

  export interface ServerConsumerManifest {
    moduleMap: Record<string, Record<string, {
      id: string | number;
      chunks: string[];
      name: string;
      async?: boolean;
    }>>;
    serverModuleMap: unknown;
    moduleLoading: unknown;
  }

  export function createFromNodeStream(
    stream: Readable,
    manifest: ServerConsumerManifest,
    options?: Record<string, unknown>,
  ): Promise<ReactNode>;
}
