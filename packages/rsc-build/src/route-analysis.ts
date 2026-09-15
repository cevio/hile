import path from 'node:path';
import { context, type BuildContext, type BuildResult, type Plugin } from 'esbuild';
import type { RscRouteDefinition } from '@hile/rsc/protocol';
import { RSC_BUILD_EXTERNALS } from './artifact-assembler';
import { createRscServerImportsPlugin } from './rsc-client-imports';
import { RscModuleGraph } from './module-graph';

export interface RscRouteAnalyzer {
  analyze(clientIds: readonly string[]): Promise<string[][]>;
  dispose(): Promise<void>;
}

/** Creates one incremental analyzer for the exact client-boundary graph of every route export. */
export async function createRscRouteAnalyzer(options: {
  cwd: string;
  entry: string;
  pluginId: string;
  buildId: () => string;
  routes: ReadonlyArray<Pick<RscRouteDefinition, 'entry'>>;
}): Promise<RscRouteAnalyzer> {
  if (options.routes.length === 0) {
    return {
      analyze: async () => [],
      dispose: async () => undefined,
    };
  }
  const graph = new RscModuleGraph({
    pluginId: options.pluginId,
    cwd: options.cwd,
    buildId: options.buildId,
    clearOnServerBuild: true,
  });
  const routeSources = new Map(options.routes.map((route, index) => [
    `hile-rsc-route:${index}`,
    `export { ${JSON.stringify(route.entry)} as default } from ${JSON.stringify(options.entry)};`,
  ]));
  const routeEntries: Plugin = {
    name: 'hile-rsc-route-entries',
    setup(context) {
      context.onResolve({ filter: /^hile-rsc-route:\d+$/ }, ({ path: specifier }) => ({
        path: specifier,
        namespace: 'hile-rsc-route-entry',
      }));
      context.onLoad({ filter: /.*/, namespace: 'hile-rsc-route-entry' }, ({ path: specifier }) => ({
        contents: routeSources.get(specifier),
        loader: 'js',
        resolveDir: options.cwd,
      }));
    },
  };
  const buildContext: BuildContext = await context({
    absWorkingDir: options.cwd,
    entryPoints: Object.fromEntries(options.routes.map((_route, index) => [
      `route-${index}`,
      `hile-rsc-route:${index}`,
    ])),
    outdir: path.join(options.cwd, '.hile-rsc-route-analysis'),
    bundle: true,
    write: false,
    entryNames: '[name]',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    external: RSC_BUILD_EXTERNALS.filter((specifier) => !specifier.startsWith('@hile/rsc')),
    plugins: [routeEntries, graph.boundaryPlugin('server'), createRscServerImportsPlugin()],
    logLevel: 'silent',
  });
  return {
    async analyze(clientIds) {
      const result: BuildResult = await buildContext.rebuild();
      return options.routes.map((_route, index) => {
        const output = result.outputFiles?.find((file) => path.basename(file.path) === `route-${index}.js`);
        if (!output) throw new Error(`RSC route analysis did not emit route-${index}.js`);
        return clientIds.filter((id) => output.text.includes(JSON.stringify(id)));
      });
    },
    dispose: () => buildContext.dispose(),
  };
}

/** One-shot route analysis for immutable production builds. */
export async function analyzeRouteClientReferences(options: {
  cwd: string;
  entry: string;
  pluginId: string;
  buildId: string;
  routes: ReadonlyArray<Pick<RscRouteDefinition, 'entry'>>;
  clientIds: readonly string[];
}): Promise<string[][]> {
  const analyzer = await createRscRouteAnalyzer({
    ...options,
    buildId: () => options.buildId,
  });
  try {
    return await analyzer.analyze(options.clientIds);
  } finally {
    await analyzer.dispose();
  }
}
