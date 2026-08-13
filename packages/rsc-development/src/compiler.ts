import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  context,
  type BuildContext,
  type BuildOptions,
  type BuildResult,
  type Metafile,
  type Plugin,
} from 'esbuild';
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
import { inspectModule, createSharedReactPlugin } from '@hile/rsc-build';

export interface RscDevelopmentCompilerOptions {
  pluginId: string;
  buildId: string;
  cwd: string;
  entry: string;
  outdir: string;
  routes: readonly RscRouteDefinition[];
  runtime: RscRuntimeCompatibility;
  sessionId?: string;
  initialRevision?: number;
}

export type RscDevelopmentContextState = 'created' | 'reused';

export interface RscDevelopmentRevision {
  revision: number;
  artifactRoot: string;
  manifest: RscPluginManifest;
  clientGraphChanged: boolean;
  contexts: {
    server: RscDevelopmentContextState;
    browser: RscDevelopmentContextState;
    ssr: RscDevelopmentContextState;
  };
}

export interface RscDevelopmentCompiler {
  rebuild(): Promise<RscDevelopmentRevision>;
  current(): RscDevelopmentRevision | undefined;
  dispose(): Promise<void>;
}

interface ClientEntry {
  pluginId: string;
  buildId: string;
  absolutePath: string;
  referenceBase: string;
  exports: string[];
  entryName: string;
}

interface ContextSlot {
  signature: string;
  context: BuildContext;
}

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mts'];
const EXTERNAL = [
  'react', 'react/*', 'react-dom', 'react-dom/*',
  'react-server-dom-webpack', 'react-server-dom-webpack/*',
];

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${label} contains unsupported path characters`);
  return value;
}

function sanitizeEntryName(relativePath: string): string {
  const readable = relativePath.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
  return `${readable}-${createHash('sha256').update(relativePath).digest('hex').slice(0, 10)}`;
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
    const local = exportName === 'default' ? '__hileDefault' : `__hile_${exportName}`;
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
      exportName === 'default' ? `export default ${local};` : `export { ${local} as ${exportName} };`,
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
  if (!match) throw new Error(`No output was generated for client entry ${absoluteEntry}`);
  return match[0];
}

async function integrity(file: string): Promise<string> {
  return `sha256-${createHash('sha256').update(await readFile(file)).digest('base64')}`;
}

function clientOptions(entries: ClientEntry[], outdir: string, target: 'browser' | 'ssr'): BuildOptions {
  return {
    absWorkingDir: process.cwd(),
    entryPoints: Object.fromEntries(entries.map((entry) => [entry.entryName, entry.absolutePath])),
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
  };
}

async function copyRevision(workdir: string, target: string, manifest: RscPluginManifest) {
  const temporary = `${target}.${process.pid}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  const files = new Set<string>(['plugin.json', manifest.server.entry]);
  for (const client of manifest.clients) {
    files.add(client.module);
    files.add(client.ssrModule);
    client.chunks.forEach((chunk) => files.add(chunk.path));
    client.ssrChunks.forEach((chunk) => files.add(chunk.path));
  }
  manifest.styles.forEach((style) => files.add(style.path));
  for (const relative of files) {
    const source = path.resolve(workdir, relative);
    const destination = path.resolve(temporary, relative);
    if (!isInside(workdir, source) || !isInside(temporary, destination)) throw new Error('RSC artifact path escaped revision root');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
  await rename(temporary, target);
}

export async function createRscDevelopmentCompiler(
  options: RscDevelopmentCompilerOptions,
): Promise<RscDevelopmentCompiler> {
  for (const key of ['react', 'reactDom', 'rsc'] as const) {
    if (options.runtime[key] !== HILE_RSC_RUNTIME[key]) {
      throw new Error(`RSC build runtime mismatch: configured ${key}=${options.runtime[key]}, compiler=${HILE_RSC_RUNTIME[key]}`);
    }
  }
  const cwd = realpathSync(path.resolve(options.cwd));
  const entryInput = path.resolve(cwd, options.entry);
  const requestedOutdir = path.resolve(options.outdir);
  if (!isInside(cwd, entryInput) || entryInput === cwd) throw new Error('RSC plugin entry must be a file inside cwd');
  if (isInside(requestedOutdir, cwd)) throw new Error('RSC plugin outdir must not contain or overwrite cwd');
  await access(entryInput);
  const entry = realpathSync(entryInput);
  if (!isInside(cwd, entry) || entry === cwd) throw new Error('RSC plugin entry must not escape cwd through a symbolic link');
  await mkdir(requestedOutdir, { recursive: true });
  const outdir = realpathSync(requestedOutdir);
  if (isInside(outdir, cwd)) {
    throw new Error('RSC plugin outdir must not contain or overwrite cwd through a symbolic link');
  }
  const sessionId = safeSegment(options.sessionId ?? `${process.pid}`, 'RSC development sessionId');
  if (!Number.isSafeInteger(options.initialRevision ?? 0) || (options.initialRevision ?? 0) < 0) {
    throw new TypeError('RSC development initialRevision must be a non-negative safe integer');
  }
  const workdir = path.join(outdir, '.work', sessionId);
  const revisionsDir = path.join(outdir, 'revisions', sessionId);
  await mkdir(workdir, { recursive: true });
  await mkdir(revisionsDir, { recursive: true });

  let activeBuildId = options.buildId;
  const clientEntries = new Map<string, ClientEntry>();
  const boundaryPlugin: Plugin = {
    name: 'hile-rsc-client-boundary',
    setup(build) {
      build.onStart(() => { clientEntries.clear(); });
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point' || (args.pluginData as { hileRscResolved?: boolean } | undefined)?.hileRscResolved) return undefined;
        const resolved = await build.resolve(args.path, {
          importer: args.importer, kind: args.kind, namespace: args.namespace, resolveDir: args.resolveDir,
          pluginData: { hileRscResolved: true }, with: args.with,
        });
        if (resolved.errors.length > 0 || resolved.external || resolved.namespace !== 'file') return resolved;
        const canonical = realpathSync(resolved.path);
        if (!SOURCE_EXTENSIONS.includes(path.extname(canonical))) return resolved;
        const insidePlugin = isInside(cwd, canonical);
        const bareSpecifier = !args.path.startsWith('.') && !path.isAbsolute(args.path);
        if (!insidePlugin && !bareSpecifier) throw new Error(`Plugin source escapes cwd through a relative import: ${resolved.path}`);
        const inspection = inspectModule(await readFile(canonical, 'utf8'), canonical);
        if (!inspection.useClient) return resolved;
        const logicalPath = insidePlugin ? path.relative(cwd, canonical).split(path.sep).join('/') : `@dependency/${args.path}`;
        const existing = clientEntries.get(canonical);
        if (existing) return { path: canonical, namespace: 'hile-rsc-client-reference', pluginData: existing };
        const value: ClientEntry = {
          pluginId: options.pluginId,
          buildId: activeBuildId,
          absolutePath: canonical,
          referenceBase: `${options.pluginId}/${logicalPath.replace(/\.[^.]+$/, '')}`,
          exports: [...inspection.exports].sort((a, b) => a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)),
          entryName: sanitizeEntryName(logicalPath),
        };
        clientEntries.set(canonical, value);
        return { path: canonical, namespace: 'hile-rsc-client-reference', pluginData: value };
      });
      build.onLoad({ filter: /.*/, namespace: 'hile-rsc-client-reference' }, (args) => ({
        contents: registerSource(args.pluginData as ClientEntry), loader: 'js', resolveDir: path.dirname(args.path),
      }));
    },
  };

  const serverFile = path.join(workdir, 'server-rsc/index.js');
  await mkdir(path.dirname(serverFile), { recursive: true });
  const slots = new Map<'server' | 'browser' | 'ssr', ContextSlot>();
  const execute = async (
    key: 'server' | 'browser' | 'ssr', signature: string, buildOptions: BuildOptions,
  ): Promise<{ result: BuildResult; state: RscDevelopmentContextState }> => {
    const existing = slots.get(key);
    if (existing?.signature === signature) return { result: await existing.context.rebuild(), state: 'reused' };
    const next = await context(buildOptions);
    try {
      const result = await next.rebuild();
      await existing?.context.dispose();
      slots.set(key, { signature, context: next });
      return { result, state: 'created' };
    } catch (error) {
      await next.dispose();
      throw error;
    }
  };

  let latest: RscDevelopmentRevision | undefined;
  let latestGraphSignature: string | undefined;
  let successfulRevision = options.initialRevision ?? 0;
  let disposed = false;
  let queue = Promise.resolve<RscDevelopmentRevision | undefined>(undefined);

  const compile = async (): Promise<RscDevelopmentRevision> => {
    const revision = successfulRevision + 1;
    activeBuildId = `${options.buildId}-dev-${sessionId}-r${revision}`;
    const server = await execute('server', 'server', {
      absWorkingDir: cwd, entryPoints: [entry], outfile: serverFile, bundle: true, format: 'esm', platform: 'node',
      target: 'node20', jsx: 'automatic', external: EXTERNAL, plugins: [boundaryPlugin], logLevel: 'silent',
    });
    const entries = [...clientEntries.values()].sort((a, b) => a.referenceBase.localeCompare(b.referenceBase));
    if (entries.length === 0) throw new Error('RSC plugin must expose at least one use client boundary');
    const graphSignature = JSON.stringify(entries.map(({ absolutePath, entryName, exports: names }) => [absolutePath, entryName, names]));
    const clientGraphChanged = latestGraphSignature !== undefined && latestGraphSignature !== graphSignature;
    const browser = await execute('browser', graphSignature, clientOptions(entries, path.join(workdir, 'client-browser'), 'browser'));
    const ssr = await execute('ssr', graphSignature, clientOptions(entries, path.join(workdir, 'client-ssr'), 'ssr'));
    const browserMeta = browser.result.metafile!;
    const ssrMeta = ssr.result.metafile!;
    await Promise.all(Object.keys(ssrMeta.outputs).filter((output) => output.endsWith('.css'))
      .map((output) => rm(path.resolve(output), { force: true })));

    const primaryBrowser = new Set(entries.map((value) => outputForEntry(browserMeta, value.absolutePath)));
    const browserChunks = await Promise.all(Object.entries(browserMeta.outputs)
      .filter(([output]) => output.endsWith('.js') && !primaryBrowser.has(output))
      .map(async ([output]) => ({ path: toRelative(workdir, output), integrity: await integrity(path.resolve(output)) })));
    browserChunks.sort((a, b) => a.path.localeCompare(b.path));
    const primarySsr = new Set(entries.map((value) => outputForEntry(ssrMeta, value.absolutePath)));
    const ssrChunks = await Promise.all(Object.entries(ssrMeta.outputs)
      .filter(([output]) => output.endsWith('.js') && !primarySsr.has(output))
      .map(async ([output]) => ({ path: toRelative(workdir, output), integrity: await integrity(path.resolve(output)) })));
    ssrChunks.sort((a, b) => a.path.localeCompare(b.path));
    const clients: RscClientReference[] = [];
    for (const value of entries) {
      const browserModule = toRelative(workdir, outputForEntry(browserMeta, value.absolutePath));
      const ssrModule = toRelative(workdir, outputForEntry(ssrMeta, value.absolutePath));
      for (const exportName of value.exports) clients.push({
        id: `${value.referenceBase}#${exportName}`,
        module: browserModule,
        ssrModule,
        exportName,
        chunks: browserChunks.map((chunk) => ({ ...chunk })),
        ssrChunks: ssrChunks.map((chunk) => ({ ...chunk })),
        integrity: await integrity(path.join(workdir, browserModule)),
        ssrIntegrity: await integrity(path.join(workdir, ssrModule)),
      });
    }
    const styles = await Promise.all(Object.keys(browserMeta.outputs).filter((output) => output.endsWith('.css')).sort()
      .map(async (output) => ({ path: toRelative(workdir, output), integrity: await integrity(path.resolve(output)) })));
    const manifest = validateRscPluginManifest({
      protocolVersion: HILE_RSC_PROTOCOL_VERSION,
      pluginId: options.pluginId,
      buildId: activeBuildId,
      runtime: options.runtime,
      server: { entry: toRelative(workdir, serverFile), integrity: await integrity(serverFile) },
      clients,
      styles,
      routes: [...options.routes],
    }, options.runtime);
    await writeFile(path.join(workdir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const artifactRoot = path.join(revisionsDir, `r${revision}`);
    if ((await readdir(revisionsDir)).includes(`r${revision}`)) throw new Error(`RSC development revision already exists: ${revision}`);
    await copyRevision(workdir, artifactRoot, manifest);
    const result: RscDevelopmentRevision = {
      revision,
      artifactRoot,
      manifest,
      clientGraphChanged,
      contexts: { server: server.state, browser: browser.state, ssr: ssr.state },
    };
    latest = result;
    latestGraphSignature = graphSignature;
    successfulRevision = revision;
    return result;
  };

  return {
    rebuild() {
      if (disposed) return Promise.reject(new Error('RSC development compiler is disposed'));
      const result = queue.then(compile, compile);
      queue = result;
      return result;
    },
    current: () => latest,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await queue.catch(() => undefined);
      await Promise.all([...slots.values()].map((slot) => slot.context.dispose()));
      slots.clear();
    },
  };
}
