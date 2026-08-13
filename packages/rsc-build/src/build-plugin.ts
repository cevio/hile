import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, type BuildResult, type Metafile, type Plugin } from 'esbuild';
import {
  HILE_REMOTE_CLIENT_REFERENCE,
  HILE_RSC_RUNTIME,
  HILE_RSC_PROTOCOL_VERSION,
  validateRscPluginManifest,
  type RscClientReference,
  type RscPluginManifest,
  type RscRouteDefinition,
  type RscRuntimeCompatibility,
} from '@hile/rsc/protocol';
import { inspectModule } from './directives';
import { createSharedReactPlugin } from './shared-react';

export interface BuildRscPluginOptions {
  pluginId: string;
  buildId: string;
  cwd: string;
  entry: string;
  outdir: string;
  routes: RscRouteDefinition[];
  runtime: RscRuntimeCompatibility;
}

interface ClientEntry {
  pluginId: string;
  buildId: string;
  absolutePath: string;
  referenceBase: string;
  exports: string[];
  entryName: string;
}

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mts'];
const EXTERNAL = [
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  'react-server-dom-webpack',
  'react-server-dom-webpack/*',
];

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sanitizeEntryName(relativePath: string): string {
  const readable = relativePath
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'client';
  const identity = createHash('sha256').update(relativePath).digest('hex').slice(0, 10);
  return `${readable}-${identity}`;
}

function registerSource(entry: ClientEntry): string {
  const lines = [
    `import React from 'react';`,
    `import { registerClientReference as __hileRegisterClientReference } from 'react-server-dom-webpack/server.node';`,
    `const __hileRemoteClientBoundary = __hileRegisterClientReference(function () {`,
    `  throw new Error('RemoteClientBoundary cannot execute on the plugin RSC server');`,
    `}, ${JSON.stringify(HILE_REMOTE_CLIENT_REFERENCE)}, 'default');`,
  ];
  for (const exportName of entry.exports) {
    const local = exportName === 'default'
      ? '__hileDefault'
      : `__hile_${exportName}`;
    lines.push(
      `function ${local}(props) {`,
      `  return React.createElement(__hileRemoteClientBoundary, {`,
      `    pluginId: ${JSON.stringify(entry.pluginId)},`,
      `    buildId: ${JSON.stringify(entry.buildId)},`,
      `    referenceId: ${JSON.stringify(`${entry.referenceBase}#${exportName}`)},`,
      `    exportName: ${JSON.stringify(exportName)},`,
      `    props,`,
      `  });`,
      `}`,
      exportName === 'default'
        ? `export default ${local};`
        : `export { ${local} as ${exportName} };`,
    );
  }
  return lines.join('\n');
}

function toRelative(outdir: string, output: string): string {
  return path.relative(outdir, path.resolve(output)).split(path.sep).join('/');
}

function outputForEntry(metafile: Metafile, absoluteEntry: string): string {
  const normalized = realpathSync(path.resolve(absoluteEntry));
  const match = Object.entries(metafile.outputs).find(([, value]) =>
    value.entryPoint && realpathSync(path.resolve(value.entryPoint)) === normalized);
  if (!match) {
    const generated = Object.values(metafile.outputs).flatMap((value) => value.entryPoint ? [value.entryPoint] : []);
    throw new Error(`No output was generated for client entry ${absoluteEntry}; generated=${generated.join(',')}`);
  }
  return match[0];
}

async function integrity(file: string): Promise<string> {
  return `sha256-${createHash('sha256').update(await readFile(file)).digest('base64')}`;
}

async function buildClients(
  entries: ClientEntry[],
  outdir: string,
  target: 'browser' | 'ssr',
): Promise<BuildResult & { metafile: Metafile }> {
  const entryPoints = Object.fromEntries(entries.map((entry) => [entry.entryName, entry.absolutePath]));
  return build({
    absWorkingDir: process.cwd(),
    entryPoints,
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: target === 'browser' ? 'browser' : 'node',
    target: 'es2022',
    jsx: 'automatic',
    entryNames: '[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    external: EXTERNAL.filter((specifier) => !specifier.startsWith('react')),
    plugins: [createSharedReactPlugin()],
    metafile: true,
    write: true,
    sourcemap: false,
    logLevel: 'silent',
  });
}

export async function buildRscPlugin(options: BuildRscPluginOptions): Promise<RscPluginManifest> {
  for (const key of ['react', 'reactDom', 'rsc'] as const) {
    if (options.runtime[key] !== HILE_RSC_RUNTIME[key]) {
      throw new Error(
        `RSC build runtime mismatch: configured ${key}=${options.runtime[key]}, compiler=${HILE_RSC_RUNTIME[key]}`,
      );
    }
  }
  const cwd = realpathSync(path.resolve(options.cwd));
  const entryInput = path.resolve(cwd, options.entry);
  const outdir = path.resolve(options.outdir);
  if (!isInside(cwd, entryInput) || entryInput === cwd) {
    throw new Error('RSC plugin entry must be a file inside cwd');
  }
  if (isInside(outdir, cwd)) {
    throw new Error('RSC plugin outdir must not contain or overwrite cwd');
  }
  await access(entryInput);
  const entry = realpathSync(entryInput);
  if (!isInside(cwd, entry) || entry === cwd) {
    throw new Error('RSC plugin entry must not escape cwd through a symbolic link');
  }
  await mkdir(outdir, { recursive: true });
  const canonicalOutdir = realpathSync(outdir);
  if (isInside(canonicalOutdir, cwd)) {
    throw new Error('RSC plugin outdir must not contain or overwrite cwd through a symbolic link');
  }
  if ((await readdir(outdir)).length > 0) {
    throw new Error('RSC plugin outdir must be empty so immutable builds cannot retain stale files');
  }

  const clientEntries = new Map<string, ClientEntry>();
  const boundaryPlugin: Plugin = {
    name: 'hile-rsc-client-boundary',
    setup(context) {
      context.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point' || (args.pluginData as { hileRscResolved?: boolean } | undefined)?.hileRscResolved) {
          return undefined;
        }
        const resolved = await context.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: { hileRscResolved: true },
          with: args.with,
        });
        if (resolved.errors.length > 0 || resolved.external || resolved.namespace !== 'file') return resolved;
        const canonical = realpathSync(resolved.path);
        if (!SOURCE_EXTENSIONS.includes(path.extname(canonical))) return resolved;
        const insidePlugin = isInside(cwd, canonical);
        const bareSpecifier = !args.path.startsWith('.') && !path.isAbsolute(args.path);
        if (!insidePlugin && !bareSpecifier) {
          throw new Error(`Plugin source escapes cwd through a relative import: ${resolved.path}`);
        }
        const inspection = inspectModule(await readFile(canonical, 'utf8'), canonical);
        if (!inspection.useClient) return resolved;

        const logicalPath = insidePlugin
          ? path.relative(cwd, canonical).split(path.sep).join('/')
          : `@dependency/${args.path}`;
        const existing = clientEntries.get(canonical);
        if (existing) {
          return {
            path: canonical,
            namespace: 'hile-rsc-client-reference',
            pluginData: existing,
          };
        }
        const referenceBase = `${options.pluginId}/${logicalPath.replace(/\.[^.]+$/, '')}`;
        const clientEntry: ClientEntry = {
          pluginId: options.pluginId,
          buildId: options.buildId,
          absolutePath: canonical,
          referenceBase,
          exports: [...inspection.exports].sort((a, b) => {
            if (a === 'default') return -1;
            if (b === 'default') return 1;
            return a.localeCompare(b);
          }),
          entryName: sanitizeEntryName(logicalPath),
        };
        clientEntries.set(canonical, clientEntry);
        return {
          path: canonical,
          namespace: 'hile-rsc-client-reference',
          pluginData: clientEntry,
        };
      });
      context.onLoad({ filter: /.*/, namespace: 'hile-rsc-client-reference' }, (args) => ({
        contents: registerSource(args.pluginData as ClientEntry),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      }));
    },
  };

  const serverDir = path.join(outdir, 'server-rsc');
  const serverFile = path.join(serverDir, 'index.js');
  await mkdir(serverDir, { recursive: true });
  await build({
    absWorkingDir: cwd,
    entryPoints: [entry],
    outfile: serverFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    external: EXTERNAL,
    plugins: [boundaryPlugin],
    logLevel: 'silent',
  });

  const entries = [...clientEntries.values()].sort((a, b) =>
    a.referenceBase.localeCompare(b.referenceBase));
  if (entries.length === 0) {
    throw new Error('RSC plugin must expose at least one use client boundary');
  }
  const browserDir = path.join(outdir, 'client-browser');
  const ssrDir = path.join(outdir, 'client-ssr');
  const browserBuild = await buildClients(entries, browserDir, 'browser');
  const ssrBuild = await buildClients(entries, ssrDir, 'ssr');
  await Promise.all(Object.keys(ssrBuild.metafile.outputs)
    .filter((output) => output.endsWith('.css'))
    .map((output) => unlink(path.resolve(output))));

  const primaryBrowserOutputs = new Set(entries.map((clientEntry) =>
    outputForEntry(browserBuild.metafile, clientEntry.absolutePath)));
  const browserChunkOutputs = await Promise.all(Object.entries(browserBuild.metafile.outputs)
    .filter(([output]) => output.endsWith('.js') && !primaryBrowserOutputs.has(output))
    .map(async ([output]) => {
      const chunkPath = toRelative(outdir, output);
      return { path: chunkPath, integrity: await integrity(path.join(outdir, chunkPath)) };
    }));
  browserChunkOutputs.sort((a, b) => a.path.localeCompare(b.path));
  const primarySsrOutputs = new Set(entries.map((clientEntry) =>
    outputForEntry(ssrBuild.metafile, clientEntry.absolutePath)));
  const ssrChunkOutputs = await Promise.all(Object.entries(ssrBuild.metafile.outputs)
    .filter(([output]) => output.endsWith('.js') && !primarySsrOutputs.has(output))
    .map(async ([output]) => {
      const chunkPath = toRelative(outdir, output);
      return { path: chunkPath, integrity: await integrity(path.join(outdir, chunkPath)) };
    }));
  ssrChunkOutputs.sort((a, b) => a.path.localeCompare(b.path));
  const clients: RscClientReference[] = [];
  for (const clientEntry of entries) {
    const browserOutput = outputForEntry(browserBuild.metafile, clientEntry.absolutePath);
    const ssrOutput = outputForEntry(ssrBuild.metafile, clientEntry.absolutePath);
    const browserModule = toRelative(outdir, browserOutput);
    const ssrModule = toRelative(outdir, ssrOutput);
    for (const exportName of clientEntry.exports) {
      clients.push({
        id: `${clientEntry.referenceBase}#${exportName}`,
        module: browserModule,
        ssrModule,
        exportName,
        chunks: browserChunkOutputs.map((chunk) => ({ ...chunk })),
        ssrChunks: ssrChunkOutputs.map((chunk) => ({ ...chunk })),
        integrity: await integrity(path.join(outdir, browserModule)),
        ssrIntegrity: await integrity(path.join(outdir, ssrModule)),
      });
    }
  }

  const styles = await Promise.all(
    Object.keys(browserBuild.metafile.outputs)
      .filter((output) => output.endsWith('.css'))
      .sort()
      .map(async (output) => {
        const stylePath = toRelative(outdir, output);
        return {
          path: stylePath,
          integrity: await integrity(path.join(outdir, stylePath)),
        };
      }),
  );

  const manifest = validateRscPluginManifest({
    protocolVersion: HILE_RSC_PROTOCOL_VERSION,
    pluginId: options.pluginId,
    buildId: options.buildId,
    runtime: options.runtime,
    server: {
      entry: toRelative(outdir, serverFile),
      integrity: await integrity(serverFile),
    },
    clients,
    styles,
    routes: options.routes,
  }, options.runtime);

  const manifestPath = path.join(outdir, 'plugin.json');
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporaryPath, manifestPath);
  return manifest;
}
