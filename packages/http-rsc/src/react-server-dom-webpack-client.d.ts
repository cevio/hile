declare module 'react-server-dom-webpack/client' {
  import type { ReactNode } from 'react';

  export function createFromFetch<T = ReactNode>(
    promiseForResponse: Promise<Response>,
    options?: {
      callServer?: (...args: unknown[]) => Promise<unknown>;
      temporaryReferences?: Map<string, unknown>;
    }
  ): Promise<T>;
}
