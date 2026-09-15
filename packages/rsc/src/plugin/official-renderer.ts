import { PassThrough } from 'node:stream';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement, type ComponentType } from 'react';
import type { RscPluginManifest } from '../protocol';
import { HILE_REMOTE_CLIENT_MODULE_ID, HILE_REMOTE_CLIENT_REFERENCE } from '../protocol';
import type { PreparedRscRenderer } from './types';

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

export function createOfficialRscRenderer(artifactRoot: string): PreparedRscRenderer {
  let modulePromise: Promise<Record<string, unknown>> | undefined;
  let flightRuntimePromise: Promise<typeof import('react-server-dom-webpack/server.node')> | undefined;
  let readinessBuildId: string | undefined;
  let readinessPromise: Promise<void> | undefined;
  const loadModule = (manifest: RscPluginManifest) => {
    modulePromise ??= import(pathToFileURL(
      path.join(artifactRoot, manifest.server.entry),
    ).href) as Promise<Record<string, unknown>>;
    return modulePromise;
  };
  const loadFlightRuntime = () => {
    flightRuntimePromise ??= import('react-server-dom-webpack/server.node');
    return flightRuntimePromise;
  };
  const readinessFor = (manifest: RscPluginManifest) => {
    if (readinessPromise) {
      if (readinessBuildId !== manifest.buildId) {
        return Promise.reject(new Error(
          `RSC renderer is already bound to immutable build: ${readinessBuildId}`,
        ));
      }
      return readinessPromise;
    }
    readinessBuildId = manifest.buildId;
    readinessPromise = Promise.all([loadModule(manifest), loadFlightRuntime()]).then(([pluginModule]) => {
      for (const route of manifest.routes) {
        if (typeof pluginModule[route.entry] !== 'function') {
          throw new Error(`RSC route entry is not a component: ${route.entry}`);
        }
      }
    });
    return readinessPromise;
  };
  const waitForSignal = (preparation: Promise<void>, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void preparation.then(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
    });
  };
  const render: PreparedRscRenderer = async ({ manifest, routeEntry, request, signal }) => {
    await render.prepare({ manifest, signal });
    const pluginModule = await loadModule(manifest);
    const Component = pluginModule[routeEntry];
    if (typeof Component !== 'function') {
      throw new Error(`RSC route entry is not a component: ${routeEntry}`);
    }
    const { renderToPipeableStream } = await loadFlightRuntime();
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
  render.prepare = ({ manifest, signal }: Parameters<PreparedRscRenderer['prepare']>[0]) => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return waitForSignal(readinessFor(manifest), signal);
  };
  return render;
}
