import { realpathSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  context,
  type BuildContext,
  type BuildOptions,
  type BuildResult,
} from 'esbuild';
import {
  HILE_RSC_RUNTIME,
  HILE_RSC_PROTOCOL_VERSION,
  validateRscPluginManifest,
  type RscPluginManifest,
  type RscPluginMetadata,
  type RscRouteDefinition,
  type RscRuntimeCompatibility,
} from '@hile/rsc/protocol';
import {
  assembleRscClientArtifacts,
  assembleRscSharedStyleArtifacts,
  buildRscServerFunctionArtifacts,
  createRscClientBuildOptions,
  isPathInside,
  RSC_BUILD_EXTERNALS,
  rscArtifactIntegrity,
  RscModuleGraph,
  toRscArtifactPath,
} from '@hile/rsc-build';

export interface RscDevelopmentCompilerOptions {
  pluginId: string;
  buildId: string;
  cwd: string;
  entry: string;
  outdir: string;
  routes: readonly RscRouteDefinition[];
  styles?: string[];
  metadata?: RscPluginMetadata;
  runtime: RscRuntimeCompatibility;
  sessionId?: string;
  initialRevision?: number;
  /** Immutable revisions retained for this compiler session. Must be at least 2. */
  maxRevisions?: number;
  /** Compiler-session artifact directories retained across process restarts. Must be at least 2. */
  maxSessions?: number;
}

export type RscDevelopmentContextState = 'created' | 'reused' | 'cached';

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

interface ContextSlot {
  signature: string;
  context: BuildContext;
  result: BuildResult;
}

const EXTERNAL = [...RSC_BUILD_EXTERNALS];

async function buildInputFingerprint(results: readonly BuildResult[]): Promise<string> {
  const inputs = new Set(results.flatMap((result) => Object.keys(result.metafile?.inputs ?? {})));
  const fingerprints = await Promise.all([...inputs].sort().map(async (input) => {
    try {
      const metadata = await stat(path.resolve(input), { bigint: true });
      return `${input}\0${metadata.size}\0${metadata.mtimeNs}`;
    } catch {
      return `${input}\0virtual`;
    }
  }));
  return fingerprints.join('\n');
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${label} contains unsupported path characters`);
  return value;
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
  manifest.serverFunctions.forEach((reference) => files.add(reference.module));
  for (const relative of files) {
    const source = path.resolve(workdir, relative);
    const destination = path.resolve(temporary, relative);
    if (!isPathInside(workdir, source) || !isPathInside(temporary, destination)) throw new Error('RSC artifact path escaped revision root');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
  await rename(temporary, target);
}

async function pruneRevisionDirectories(revisionsDir: string, retain: number): Promise<void> {
  const revisions = (await readdir(revisionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^r\d+$/.test(entry.name))
    .map((entry) => ({ name: entry.name, revision: Number(entry.name.slice(1)) }))
    .sort((left, right) => right.revision - left.revision);
  await Promise.all(revisions.slice(retain).map(({ name }) =>
    rm(path.join(revisionsDir, name), { recursive: true, force: true })));
}

async function pruneSessionDirectories(root: string, current: string, retain: number): Promise<void> {
  const sessions = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== current);
  const dated = await Promise.all(sessions.map(async (entry) => ({
    name: entry.name,
    mtimeMs: (await stat(path.join(root, entry.name))).mtimeMs,
  })));
  dated.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(dated.slice(Math.max(0, retain - 1)).map(({ name }) =>
    rm(path.join(root, name), { recursive: true, force: true })));
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
  if (!isPathInside(cwd, entryInput) || entryInput === cwd) throw new Error('RSC plugin entry must be a file inside cwd');
  if (isPathInside(requestedOutdir, cwd)) throw new Error('RSC plugin outdir must not contain or overwrite cwd');
  await access(entryInput);
  const entry = realpathSync(entryInput);
  if (!isPathInside(cwd, entry) || entry === cwd) throw new Error('RSC plugin entry must not escape cwd through a symbolic link');
  await mkdir(requestedOutdir, { recursive: true });
  const outdir = realpathSync(requestedOutdir);
  if (isPathInside(outdir, cwd)) {
    throw new Error('RSC plugin outdir must not contain or overwrite cwd through a symbolic link');
  }
  const sessionId = safeSegment(options.sessionId ?? `${process.pid}`, 'RSC development sessionId');
  if (!Number.isSafeInteger(options.initialRevision ?? 0) || (options.initialRevision ?? 0) < 0) {
    throw new TypeError('RSC development initialRevision must be a non-negative safe integer');
  }
  const maxRevisions = options.maxRevisions ?? 5;
  const maxSessions = options.maxSessions ?? 3;
  if (!Number.isSafeInteger(maxRevisions) || maxRevisions < 2) {
    throw new TypeError('RSC development maxRevisions must be a safe integer of at least 2');
  }
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 2) {
    throw new TypeError('RSC development maxSessions must be a safe integer of at least 2');
  }
  const workdir = path.join(outdir, '.work', sessionId);
  const revisionsDir = path.join(outdir, 'revisions', sessionId);
  await mkdir(workdir, { recursive: true });
  await mkdir(revisionsDir, { recursive: true });
  await Promise.all([
    pruneSessionDirectories(path.join(outdir, '.work'), sessionId, maxSessions),
    pruneSessionDirectories(path.join(outdir, 'revisions'), sessionId, maxSessions),
  ]);

  let activeBuildId = options.buildId;
  const graph = new RscModuleGraph({
    pluginId: options.pluginId,
    cwd,
    buildId: () => activeBuildId,
    clearOnServerBuild: true,
  });

  const serverFile = path.join(workdir, 'server-rsc/index.js');
  await mkdir(path.dirname(serverFile), { recursive: true });
  const slots = new Map<'server' | 'browser' | 'ssr', ContextSlot>();
  const execute = async (
    key: 'server' | 'browser' | 'ssr', signature: string, buildOptions: BuildOptions,
  ): Promise<{ result: BuildResult; state: RscDevelopmentContextState }> => {
    const existing = slots.get(key);
    if (existing?.signature === signature) {
      const result = await existing.context.rebuild();
      existing.result = result;
      return { result, state: 'reused' };
    }
    const next = await context(buildOptions);
    try {
      const result = await next.rebuild();
      await existing?.context.dispose();
      slots.set(key, { signature, context: next, result });
      return { result, state: 'created' };
    } catch (error) {
      await next.dispose();
      throw error;
    }
  };

  let latest: RscDevelopmentRevision | undefined;
  let latestGraphSignature: string | undefined;
  let latestClientInputFingerprint: string | undefined;
  let successfulRevision = options.initialRevision ?? 0;
  let disposed = false;
  let queue = Promise.resolve<RscDevelopmentRevision | undefined>(undefined);

  const compile = async (): Promise<RscDevelopmentRevision> => {
    const revision = successfulRevision + 1;
    activeBuildId = `${options.buildId}-dev-${sessionId}-r${revision}`;
    const sharedStyles = await assembleRscSharedStyleArtifacts(cwd, workdir, options.styles);
    const server = await execute('server', 'server', {
      absWorkingDir: cwd, entryPoints: [entry], outfile: serverFile, bundle: true, format: 'esm', platform: 'node',
      target: 'node20', jsx: 'automatic', external: EXTERNAL, plugins: [graph.boundaryPlugin('server')], logLevel: 'silent',
    });
    const entries = graph.clientEntries();
    if (entries.length === 0) throw new Error('RSC plugin must expose at least one use client boundary');
    const graphSignature = JSON.stringify(entries.map(({ absolutePath, entryName, exports: names }) => [absolutePath, entryName, names]));
    const clientGraphChanged = latestGraphSignature !== undefined && latestGraphSignature !== graphSignature;
    const serverReferenceSignature = JSON.stringify(graph.serverFunctionEntries()
      .map(({ absolutePath, exports: names }) => [absolutePath, names]));
    const clientContextSignature = `${graphSignature}:${serverReferenceSignature}`;
    const browserOptions = createRscClientBuildOptions(
      entries,
      path.join(workdir, 'client-browser'),
      'browser',
      [graph.boundaryPlugin('client')],
    );
    const ssrOptions = createRscClientBuildOptions(
      entries,
      path.join(workdir, 'client-ssr'),
      'ssr',
      [graph.boundaryPlugin('client')],
    );
    const browserSlot = slots.get('browser');
    const ssrSlot = slots.get('ssr');
    const currentClientInputFingerprint = browserSlot && ssrSlot
      ? await buildInputFingerprint([browserSlot.result, ssrSlot.result])
      : undefined;
    const mayReuseClientArtifacts = latestGraphSignature === graphSignature
      && graph.serverFunctionEntries().length === 0
      && currentClientInputFingerprint === latestClientInputFingerprint
      && browserSlot?.signature === clientContextSignature
      && ssrSlot?.signature === clientContextSignature;
    const [browser, ssr] = mayReuseClientArtifacts
      ? [
          { result: browserSlot.result, state: 'cached' as const },
          { result: ssrSlot.result, state: 'cached' as const },
        ]
      : await Promise.all([
          execute('browser', clientContextSignature, browserOptions),
          execute('ssr', clientContextSignature, ssrOptions),
        ]);
    const browserMeta = browser.result.metafile!;
    const ssrMeta = ssr.result.metafile!;
    const { clients, styles: clientStyles } = await assembleRscClientArtifacts(workdir, entries, browserMeta, ssrMeta);
    const serverFunctions = await buildRscServerFunctionArtifacts({
      cwd,
      root: workdir,
      entries: graph.serverFunctionEntries(),
    });
    const manifest = validateRscPluginManifest({
      protocolVersion: HILE_RSC_PROTOCOL_VERSION,
      pluginId: options.pluginId,
      buildId: activeBuildId,
      runtime: options.runtime,
      server: {
        entry: toRscArtifactPath(workdir, serverFile),
        integrity: await rscArtifactIntegrity(serverFile),
      },
      serverFunctions,
      clients,
      styles: [...sharedStyles, ...clientStyles],
      routes: [...options.routes],
      metadata: options.metadata,
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
    latestClientInputFingerprint = await buildInputFingerprint([browser.result, ssr.result]);
    successfulRevision = revision;
    await pruneRevisionDirectories(revisionsDir, maxRevisions);
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
      await rm(workdir, { recursive: true, force: true });
    },
  };
}
