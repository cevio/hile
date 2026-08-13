import { PassThrough } from 'node:stream';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, type ComponentType } from 'react';
import type { RscPluginManifest } from '../protocol';
import { HILE_REMOTE_CLIENT_MODULE_ID, HILE_REMOTE_CLIENT_REFERENCE } from '../protocol';
import type { RscRenderer } from './types';

function createClientManifest(manifest: RscPluginManifest) {
  void manifest;
  return {
    [HILE_REMOTE_CLIENT_REFERENCE]: {
      id: HILE_REMOTE_CLIENT_MODULE_ID,
      chunks: [],
      name: 'default',
    },
  };
}

export function createOfficialRscRenderer(artifactRoot: string): RscRenderer {
  let modulePromise: Promise<Record<string, unknown>> | undefined;
  return async function render({ manifest, routeEntry, request, signal }) {
    modulePromise ??= import(pathToFileURL(
      path.join(artifactRoot, manifest.server.entry),
    ).href) as Promise<Record<string, unknown>>;
    const pluginModule = await modulePromise;
    const Component = pluginModule[routeEntry];
    if (typeof Component !== 'function') {
      throw new Error(`RSC route entry is not a component: ${routeEntry}`);
    }
    const { renderToPipeableStream } = await import('react-server-dom-webpack/server.node');
    const output = new PassThrough();
    let flight: ReturnType<typeof renderToPipeableStream> | undefined;
    const abort = () => {
      flight?.abort(signal.reason);
      output.destroy(signal.reason instanceof Error ? signal.reason : undefined);
    };
    if (!signal.aborted) signal.addEventListener('abort', abort, { once: true });
    output.once('close', () => signal.removeEventListener('abort', abort));
    flight = renderToPipeableStream(
      createElement(Component as ComponentType<any>, {
        params: request.params ?? {},
        searchParams: request.searchParams ?? {},
        rsc: {
          pluginId: manifest.pluginId,
          buildId: manifest.buildId,
        },
      }),
      createClientManifest(manifest),
      {
        identifierPrefix: `${manifest.pluginId}:${manifest.buildId}:`,
        environmentName: `hile-rsc:${manifest.pluginId}`,
        onError(error) {
          if (!output.destroyed) {
            output.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        },
      },
    );
    if (signal.aborted) {
      abort();
      return output;
    }
    flight.pipe(output);
    return output;
  };
}
