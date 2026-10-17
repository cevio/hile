import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import type { OnResolveArgs, Plugin } from 'esbuild';
import { createBrowserExclusionCheck } from './browser-exclusions';
import { inspectModule, inspectModuleDirectives, type ModuleInspection } from './directives';
import {
  createBrowserServerReferenceSource,
  createClientReferenceSource,
  createServerReferenceSource,
} from './reference-sources';

export interface RscGraphEntry {
  pluginId: string;
  buildId: string;
  absolutePath: string;
  referenceBase: string;
  exports: string[];
  entryName: string;
}

export interface RscModuleGraphOptions {
  pluginId: string;
  cwd: string;
  buildId(): string;
  clearOnServerBuild?: boolean;
}

const SOURCE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mts']);

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function entryName(relativePath: string): string {
  const readable = relativePath
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'client';
  return `${readable}-${createHash('sha256').update(relativePath).digest('hex').slice(0, 10)}`;
}

function sortedExports(exports: string[]): string[] {
  return [...exports].sort((left, right) => {
    if (left === 'default') return -1;
    if (right === 'default') return 1;
    return left.localeCompare(right);
  });
}

/** Owns directive discovery and reference substitution for both production and incremental compilers. */
export class RscModuleGraph {
  readonly #options: RscModuleGraphOptions;
  readonly #clients = new Map<string, RscGraphEntry>();
  readonly #serverFunctions = new Map<string, RscGraphEntry>();
  readonly #inspection = new Map<string, Awaited<ReturnType<typeof inspectModule>>>();

  public constructor(options: RscModuleGraphOptions) {
    this.#options = options;
  }

  public clientEntries(): RscGraphEntry[] {
    return [...this.#clients.values()].sort((left, right) => left.referenceBase.localeCompare(right.referenceBase));
  }

  public serverFunctionEntries(): RscGraphEntry[] {
    return [...this.#serverFunctions.values()].sort((left, right) => left.referenceBase.localeCompare(right.referenceBase));
  }

  public boundaryPlugin(mode: 'server' | 'client'): Plugin {
    const graph = this;
    return {
      name: `hile-rsc-boundary-${mode}`,
      setup(build) {
        const implementationSpecifiers = new Map<string, string>();
        const isAliased = (specifier: string): boolean => Object.keys(build.initialOptions.alias ?? {})
          .some((alias) => specifier === alias || specifier.startsWith(`${alias}/`));
        const isBrowserDisabled = createBrowserExclusionCheck(build);
        const inspectSource = async (
          canonical: string,
          args: OnResolveArgs,
          validateExports: boolean,
        ): Promise<ModuleInspection | undefined> => {
          try {
            const source = await readFile(canonical, 'utf8');
            return validateExports
              ? inspectModule(source, canonical)
              : { ...inspectModuleDirectives(source, canonical), exports: [] };
          } catch (error) {
            if (await isBrowserDisabled(canonical, args)) return undefined;
            throw error;
          }
        };
        if (mode === 'server' && graph.#options.clearOnServerBuild) build.onStart(() => {
          graph.#clients.clear();
          graph.#serverFunctions.clear();
          graph.#inspection.clear();
        });
        build.onResolve({ filter: /^hile-rsc-server-implementation:/ }, (args) => {
          const implementation = implementationSpecifiers.get(args.path);
          if (!implementation) throw new Error(`Unknown RSC server implementation: ${args.path}`);
          return { path: implementation, namespace: 'file' };
        });
        build.onResolve({ filter: /.*/ }, async (args) => {
          if (args.kind === 'entry-point' || (args.pluginData as { hileRscResolved?: boolean } | undefined)?.hileRscResolved) {
            return undefined;
          }
          const resolved = await build.resolve(args.path, {
            importer: args.importer,
            kind: args.kind,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
            pluginData: { hileRscResolved: true },
            with: args.with,
          });
          // Preserve esbuild's private state for browser-map disabled modules.
          if (!resolved.errors.length && !resolved.external
            && (!resolved.namespace || (resolved.namespace === 'file' && !existsSync(resolved.path)))) {
            return undefined;
          }
          if (resolved.errors.length > 0) {
            if (build.initialOptions.platform === 'browser' && isBuiltin(args.path) && !isAliased(args.path)) {
              return { path: args.path.replace(/^node:/, ''), namespace: 'hile-rsc-browser-builtin' };
            }
            // Native esbuild preserves optional requires guarded by try/catch.
            return undefined;
          }
          if (resolved.external || resolved.namespace !== 'file') return resolved;
          const canonical = realpathSync(resolved.path);
          if (!SOURCE_EXTENSIONS.has(path.extname(canonical))) return undefined;
          const insidePlugin = isPathInside(graph.#options.cwd, canonical);
          const bareSpecifier = !args.path.startsWith('.') && !path.isAbsolute(args.path);
          if (!insidePlugin && !bareSpecifier) {
            const importerInsidePlugin = args.importer ? isPathInside(graph.#options.cwd, realpathSync(args.importer)) : true;
            if (importerInsidePlugin) throw new Error(`Plugin source escapes cwd through a relative import: ${resolved.path}`);
            if (mode === 'client' && (await inspectSource(canonical, args, false))?.useServer
              && !await isBrowserDisabled(canonical, args)) {
              throw new Error(`External use server modules are unsupported in plugin client graphs: ${canonical}`);
            }
            return undefined;
          }
          if (mode === 'client' && !insidePlugin) {
            if ((await inspectSource(canonical, args, false))?.useServer && !await isBrowserDisabled(canonical, args)) {
              throw new Error(`External use server modules are unsupported in plugin client graphs: ${canonical}`);
            }
            return undefined;
          }
          let inspection = graph.#inspection.get(canonical);
          if (!inspection) {
            inspection = await inspectSource(canonical, args, true);
            if (!inspection) return undefined;
            graph.#inspection.set(canonical, inspection);
          }
          if (!inspection.useClient && !inspection.useServer) return undefined;
          if (await isBrowserDisabled(canonical, args)) return undefined;
          const logicalPath = insidePlugin
            ? path.relative(graph.#options.cwd, canonical).split(path.sep).join('/')
            : `@dependency/${args.path}`;
          if (inspection.useServer) {
            let value = graph.#serverFunctions.get(canonical);
            if (!value) {
              const buildId = graph.#options.buildId();
              value = {
                pluginId: graph.#options.pluginId,
                buildId,
                absolutePath: canonical,
                referenceBase: `${graph.#options.pluginId}/${buildId}/${logicalPath.replace(/\.[^.]+$/, '')}`,
                exports: sortedExports(inspection.exports),
                entryName: entryName(logicalPath),
              };
              graph.#serverFunctions.set(canonical, value);
            }
            return { path: canonical, namespace: 'hile-rsc-server-reference', pluginData: value };
          }
          if (mode === 'client') return undefined;
          let value = graph.#clients.get(canonical);
          if (!value) {
            value = {
              pluginId: graph.#options.pluginId,
              buildId: graph.#options.buildId(),
              absolutePath: canonical,
              referenceBase: `${graph.#options.pluginId}/${logicalPath.replace(/\.[^.]+$/, '')}`,
              exports: sortedExports(inspection.exports),
              entryName: entryName(logicalPath),
            };
            graph.#clients.set(canonical, value);
          }
          return { path: canonical, namespace: 'hile-rsc-client-reference', pluginData: value };
        });
        build.onLoad({ filter: /.*/, namespace: 'hile-rsc-browser-builtin' }, () => ({
          contents: 'module.exports = {};',
          loader: 'js',
        }));
        build.onLoad({ filter: /.*/, namespace: 'hile-rsc-client-reference' }, (args) => ({
          contents: createClientReferenceSource(args.pluginData as RscGraphEntry),
          loader: 'js',
          resolveDir: path.dirname(args.path),
        }));
        build.onLoad({ filter: /.*/, namespace: 'hile-rsc-server-reference' }, (args) => {
          const entry = args.pluginData as RscGraphEntry;
          if (mode === 'client') return {
            contents: createBrowserServerReferenceSource(entry),
            loader: 'js',
            resolveDir: path.dirname(args.path),
          };
          const specifier = `hile-rsc-server-implementation:${entry.entryName}`;
          implementationSpecifiers.set(specifier, entry.absolutePath);
          return {
            contents: createServerReferenceSource(entry, specifier),
            loader: 'js',
            resolveDir: path.dirname(entry.absolutePath),
          };
        });
      },
    };
  }
}
