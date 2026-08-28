import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build, type BuildOptions, type Metafile, type Plugin } from 'esbuild';
import type {
  RscClientReference,
  RscPluginManifest,
  RscServerFunctionReference,
} from '@hile/rsc/protocol';
import { createSharedReactPlugin } from './shared-react';
import { createRscClientImportsPlugin } from './rsc-client-imports';
import type { RscGraphEntry } from './module-graph';

export const RSC_BUILD_EXTERNALS = [
  'react', 'react/*', 'react-dom', 'react-dom/*',
  'react-server-dom-webpack', 'react-server-dom-webpack/*',
  '@hile/rsc', '@hile/rsc/*',
] as const;

function relativeArtifactPath(root: string, output: string): string {
  return path.relative(root, path.resolve(output)).split(path.sep).join('/');
}

function entryOutputs(metafile: Metafile): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const [output, value] of Object.entries(metafile.outputs)) {
    if (value.entryPoint) outputs.set(realpathSync(path.resolve(value.entryPoint)), output);
  }
  return outputs;
}

function outputForEntry(outputs: ReadonlyMap<string, string>, absoluteEntry: string): string {
  const output = outputs.get(realpathSync(path.resolve(absoluteEntry)));
  if (!output) throw new Error(`No output was generated for RSC graph entry: ${absoluteEntry}`);
  return output;
}

async function integrity(file: string): Promise<string> {
  return `sha256-${createHash('sha256').update(await readFile(file)).digest('base64')}`;
}

function reachableChunks(
  metafile: Metafile,
  outputsByAbsolutePath: ReadonlyMap<string, string>,
  entryOutput: string,
  primaryOutputs: ReadonlySet<string>,
): string[] {
  const visited = new Set<string>();
  const pending = [entryOutput];
  while (pending.length > 0) {
    const output = pending.pop()!;
    if (visited.has(output)) continue;
    visited.add(output);
    for (const imported of metafile.outputs[output]?.imports ?? []) {
      if (imported.external) continue;
      const target = outputsByAbsolutePath.get(path.resolve(path.dirname(output), imported.path))
        ?? outputsByAbsolutePath.get(path.resolve(imported.path));
      if (target && !visited.has(target)) pending.push(target);
    }
  }
  return [...visited]
    .filter((output) => output.endsWith('.js') && !primaryOutputs.has(output))
    .sort((left, right) => left.localeCompare(right));
}

async function chunkAssets(
  root: string,
  outputs: readonly string[],
  integrityFor: (file: string) => Promise<string>,
) {
  return Promise.all(outputs.map(async (output) => ({
    path: relativeArtifactPath(root, output),
    integrity: await integrityFor(path.resolve(output)),
  })));
}

export function createRscClientBuildOptions(
  entries: readonly RscGraphEntry[],
  outdir: string,
  target: 'browser' | 'ssr',
  plugins: readonly Plugin[] = [],
): BuildOptions {
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
    external: RSC_BUILD_EXTERNALS.filter((specifier) =>
      !specifier.startsWith('react') && !specifier.startsWith('@hile/rsc')),
    plugins: [...plugins, createSharedReactPlugin(), createRscClientImportsPlugin()],
    metafile: true,
    write: true,
    sourcemap: false,
    logLevel: 'silent',
  };
}

export interface RscClientArtifactAssembly {
  clients: RscClientReference[];
  styles: RscPluginManifest['styles'];
}

export async function assembleRscSharedStyleArtifacts(
  cwd: string,
  root: string,
  configuredInputs: readonly string[] = [],
): Promise<RscPluginManifest['styles']> {
  if (!Array.isArray(configuredInputs)
    || configuredInputs.some((input) => typeof input !== 'string' || input.trim() === '')) {
    throw new TypeError('RSC styles must be an array of non-empty strings');
  }
  const directory = path.join(root, 'styles');
  await rm(directory, { recursive: true, force: true });
  if (configuredInputs.length === 0) return [];
  const require = createRequire(path.join(cwd, 'package.json'));
  const emitted = new Map<string, RscPluginManifest['styles'][number]>();
  await mkdir(directory, { recursive: true });
  for (const configuredInput of configuredInputs) {
    const input = configuredInput.trim();
    const resolved = input.startsWith('.') || path.isAbsolute(input)
      ? path.resolve(cwd, input)
      : require.resolve(input);
    const source = realpathSync(resolved);
    if (path.extname(source) !== '.css') {
      throw new TypeError(`RSC shared style must resolve to a CSS file: ${input}`);
    }
    const content = await readFile(source);
    const digest = createHash('sha256').update(content).digest('hex');
    if (emitted.has(digest)) continue;
    const target = path.join(directory, `${digest}.css`);
    await writeFile(target, content);
    emitted.set(digest, {
      path: relativeArtifactPath(root, target),
      integrity: await integrity(target),
    });
  }
  return [...emitted.values()];
}

export async function assembleRscClientArtifacts(
  root: string,
  entries: readonly RscGraphEntry[],
  browser: Metafile,
  ssr: Metafile,
): Promise<RscClientArtifactAssembly> {
  await Promise.all(Object.keys(ssr.outputs).filter((output) => output.endsWith('.css'))
    .map((output) => rm(path.resolve(output), { force: true })));
  const browserEntries = entryOutputs(browser);
  const ssrEntries = entryOutputs(ssr);
  const browserOutputs = new Map(Object.keys(browser.outputs)
    .map((output) => [path.resolve(output), output]));
  const ssrOutputs = new Map(Object.keys(ssr.outputs)
    .map((output) => [path.resolve(output), output]));
  const integrityCache = new Map<string, Promise<string>>();
  const integrityFor = (file: string) => {
    const absolute = path.resolve(file);
    let value = integrityCache.get(absolute);
    if (!value) {
      value = integrity(absolute);
      integrityCache.set(absolute, value);
    }
    return value;
  };
  const primaryBrowser = new Set(entries.map((entry) => outputForEntry(browserEntries, entry.absolutePath)));
  const primarySsr = new Set(entries.map((entry) => outputForEntry(ssrEntries, entry.absolutePath)));
  const clients: RscClientReference[] = [];
  for (const entry of entries) {
    const browserOutput = outputForEntry(browserEntries, entry.absolutePath);
    const ssrOutput = outputForEntry(ssrEntries, entry.absolutePath);
    const browserModule = relativeArtifactPath(root, browserOutput);
    const ssrModule = relativeArtifactPath(root, ssrOutput);
    const browserChunks = await chunkAssets(root,
      reachableChunks(browser, browserOutputs, browserOutput, primaryBrowser), integrityFor);
    const ssrChunks = await chunkAssets(root,
      reachableChunks(ssr, ssrOutputs, ssrOutput, primarySsr), integrityFor);
    for (const exportName of entry.exports) clients.push({
      id: `${entry.referenceBase}#${exportName}`,
      module: browserModule,
      ssrModule,
      exportName,
      chunks: browserChunks.map((chunk) => ({ ...chunk })),
      ssrChunks: ssrChunks.map((chunk) => ({ ...chunk })),
      integrity: await integrityFor(path.join(root, browserModule)),
      ssrIntegrity: await integrityFor(path.join(root, ssrModule)),
    });
  }
  const styles = await Promise.all(Object.keys(browser.outputs)
    .filter((output) => output.endsWith('.css'))
    .sort()
    .map(async (output) => ({
      path: relativeArtifactPath(root, output),
      integrity: await integrityFor(path.resolve(output)),
    })));
  return { clients, styles };
}

export async function buildRscServerFunctionArtifacts(options: {
  cwd: string;
  root: string;
  entries: readonly RscGraphEntry[];
}): Promise<RscServerFunctionReference[]> {
  const directory = path.join(options.root, 'server-functions');
  await mkdir(directory, { recursive: true });
  const references: RscServerFunctionReference[] = [];
  for (const entry of options.entries) {
    const output = path.join(directory, `${entry.entryName}.js`);
    await build({
      absWorkingDir: options.cwd,
      entryPoints: [entry.absolutePath],
      outfile: output,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      external: [...RSC_BUILD_EXTERNALS],
      logLevel: 'silent',
    });
    const module = relativeArtifactPath(options.root, output);
    const artifactIntegrity = await integrity(output);
    for (const exportName of entry.exports) references.push({
      id: `${entry.referenceBase}#${exportName}`,
      module,
      exportName,
      integrity: artifactIntegrity,
    });
  }
  return references;
}

export async function rscArtifactIntegrity(file: string): Promise<string> {
  return integrity(file);
}

export function toRscArtifactPath(root: string, output: string): string {
  return relativeArtifactPath(root, output);
}
