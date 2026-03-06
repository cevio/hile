declare module 'react-server-dom-webpack/server.node' {
  import type { ReactNode } from 'react';
  import type { Writable } from 'stream';

  export interface PipeableStream {
    pipe(destination: Writable): void;
    abort(reason?: unknown): void;
  }

  export function renderToPipeableStream(
    model: ReactNode,
    webpackMap: Record<string, unknown>,
    options?: Record<string, unknown>
  ): PipeableStream;
}
