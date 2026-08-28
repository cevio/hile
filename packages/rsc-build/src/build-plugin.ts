import { realpathSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, type BuildResult, type Metafile, type Plugin } from 'esbuild';
import {
  HILE_RSC_RUNTIME,
  HILE_RSC_PROTOCOL_VERSION,
  validateRscPluginManifest,
  type RscPluginManifest,
  type RscPluginMetadata,
  type RscRouteDefinition,
  type RscRuntimeCompatibility,
} from '@hile/rsc/protocol';
import { isPathInside, RscModuleGraph, type RscGraphEntry } from './module-graph';
import { createRscServerImportsPlugin } from './rsc-client-imports';
import {
  assembleRscClientArtifacts,
  assembleRscSharedStyleArtifacts,
  buildRscServerFunctionArtifacts,
  createRscClientBuildOptions,
  RSC_BUILD_EXTERNALS,
  rscArtifactIntegrity,
  toRscArtifactPath,
} from './artifact-assembler';

export interface BuildRscPluginOptions {
  pluginId: string;
  buildId: string;
  cwd: string;
  entry: string;
  outdir: string;
  routes: RscRouteDefinition[];
  /** Build-scoped CSS copied once into the immutable artifact. Package export specifiers are supported. */
  styles?: string[];
  metadata?: RscPluginMetadata;
  runtime: RscRuntimeCompatibility;
}

async function buildClients(
  entries: RscGraphEntry[],
  outdir: string,
  target: 'browser' | 'ssr',
  plugins: Plugin[],
): Promise<BuildResult & { metafile: Metafile }> {
  return build(createRscClientBuildOptions(entries, outdir, target, plugins)) as Promise<BuildResult & { metafile: Metafile }>;
}

async function buildRscPluginIntoEmptyDirectory(options: BuildRscPluginOptions): Promise<RscPluginManifest> {
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
  if (!isPathInside(cwd, entryInput) || entryInput === cwd) {
    throw new Error('RSC plugin entry must be a file inside cwd');
  }
  if (isPathInside(outdir, cwd)) {
    throw new Error('RSC plugin outdir must not contain or overwrite cwd');
  }
  await access(entryInput);
  const entry = realpathSync(entryInput);
  if (!isPathInside(cwd, entry) || entry === cwd) {
    throw new Error('RSC plugin entry must not escape cwd through a symbolic link');
  }
  await mkdir(outdir, { recursive: true });
  const canonicalOutdir = realpathSync(outdir);
  if (isPathInside(canonicalOutdir, cwd)) {
    throw new Error('RSC plugin outdir must not contain or overwrite cwd through a symbolic link');
  }
  if ((await readdir(outdir)).length > 0) {
    throw new Error('RSC plugin outdir must be empty so immutable builds cannot retain stale files');
  }
  const sharedStyles = await assembleRscSharedStyleArtifacts(cwd, outdir, options.styles);

  const graph = new RscModuleGraph({
    pluginId: options.pluginId,
    cwd,
    buildId: () => options.buildId,
  });

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
    external: RSC_BUILD_EXTERNALS.filter((specifier) => !specifier.startsWith('@hile/rsc')),
    plugins: [graph.boundaryPlugin('server'), createRscServerImportsPlugin()],
    logLevel: 'silent',
  });

  const entries = graph.clientEntries();
  if (entries.length === 0) {
    throw new Error('RSC plugin must expose at least one use client boundary');
  }
  const browserDir = path.join(outdir, 'client-browser');
  const ssrDir = path.join(outdir, 'client-ssr');
  const browserBuild = await buildClients(
    entries,
    browserDir,
    'browser',
    [graph.boundaryPlugin('client')],
  );
  const ssrBuild = await buildClients(
    entries,
    ssrDir,
    'ssr',
    [graph.boundaryPlugin('client')],
  );
  const { clients, styles: clientStyles } = await assembleRscClientArtifacts(
    outdir,
    entries,
    browserBuild.metafile,
    ssrBuild.metafile,
  );
  const serverFunctions = await buildRscServerFunctionArtifacts({
    cwd,
    root: outdir,
    entries: graph.serverFunctionEntries(),
  });

  const manifest = validateRscPluginManifest({
    protocolVersion: HILE_RSC_PROTOCOL_VERSION,
    pluginId: options.pluginId,
    buildId: options.buildId,
    runtime: options.runtime,
    server: {
      entry: toRscArtifactPath(outdir, serverFile),
      integrity: await rscArtifactIntegrity(serverFile),
    },
    serverFunctions,
    clients,
    styles: [...sharedStyles, ...clientStyles],
    routes: options.routes,
    metadata: options.metadata,
  }, options.runtime);

  const manifestPath = path.join(outdir, 'plugin.json');
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporaryPath, manifestPath);
  return manifest;
}

/** Builds an immutable artifact transactionally, so a failed build never poisons its final buildId directory. */
export async function buildRscPlugin(options: BuildRscPluginOptions): Promise<RscPluginManifest> {
  const cwd = realpathSync(path.resolve(options.cwd));
  const target = path.resolve(options.outdir);
  if (isPathInside(target, cwd)) {
    throw new Error('RSC plugin outdir must not contain or overwrite cwd');
  }
  await mkdir(target, { recursive: true });
  const canonicalTarget = realpathSync(target);
  if (isPathInside(canonicalTarget, cwd)) {
    throw new Error('RSC plugin outdir must not contain or overwrite cwd through a symbolic link');
  }
  if ((await readdir(canonicalTarget)).length > 0) {
    throw new Error('RSC plugin outdir must be empty so immutable builds cannot retain stale files');
  }

  const staging = await mkdtemp(path.join(path.dirname(canonicalTarget), `.${path.basename(canonicalTarget)}.hile-rsc-`));
  try {
    const manifest = await buildRscPluginIntoEmptyDirectory({ ...options, outdir: staging });
    if ((await readdir(canonicalTarget)).length > 0) {
      throw new Error('RSC plugin outdir changed while the immutable build was running');
    }
    await rmdir(canonicalTarget);
    try {
      await rename(staging, canonicalTarget);
    } catch (error) {
      await mkdir(canonicalTarget, { recursive: true });
      throw error;
    }
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
