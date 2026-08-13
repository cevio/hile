import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { build, type BuildOptions, type Metafile, type Plugin } from 'esbuild';
import type {
  RscClientReference,
  RscPluginManifest,
  RscServerFunctionReference,
} from '@hile/rsc/protocol';
import { createSharedReactPlugin } from './shared-react';
import type { RscGraphEntry } from './module-graph';

export const RSC_BUILD_EXTERNALS = [
  'react', 'react/*', 'react-dom', 'react-dom/*',
  'react-server-dom-webpack', 'react-server-dom-webpack/*',
  '@hile/rsc', '@hile/rsc/*',
] as const;

function relativeArtifactPath(root: string, output: string): string {
  return path.relative(root, path.resolve(output)).split(path.sep).join('/');
}

function outputForEntry(metafile: Metafile, absoluteEntry: string): string {
  const normalized = realpathSync(path.resolve(absoluteEntry));
  const match = Object.entries(metafile.outputs).find(([, value]) =>
    value.entryPoint && realpathSync(path.resolve(value.entryPoint)) === normalized);
  if (!match) throw new Error(`No output was generated for RSC graph entry: ${absoluteEntry}`);
  return match[0];
}

async function integrity(file: string): Promise<string> {
  return `sha256-${createHash('sha256').update(await readFile(file)).digest('base64')}`;
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
    external: RSC_BUILD_EXTERNALS.filter((specifier) => !specifier.startsWith('react')),
    plugins: [...plugins, createSharedReactPlugin()],
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

export async function assembleRscClientArtifacts(
  root: string,
  entries: readonly RscGraphEntry[],
  browser: Metafile,
  ssr: Metafile,
): Promise<RscClientArtifactAssembly> {
  await Promise.all(Object.keys(ssr.outputs).filter((output) => output.endsWith('.css'))
    .map((output) => rm(path.resolve(output), { force: true })));
  const primaryBrowser = new Set(entries.map((entry) => outputForEntry(browser, entry.absolutePath)));
  const browserChunks = await Promise.all(Object.entries(browser.outputs)
    .filter(([output]) => output.endsWith('.js') && !primaryBrowser.has(output))
    .map(async ([output]) => ({
      path: relativeArtifactPath(root, output),
      integrity: await integrity(path.resolve(output)),
    })));
  browserChunks.sort((left, right) => left.path.localeCompare(right.path));
  const primarySsr = new Set(entries.map((entry) => outputForEntry(ssr, entry.absolutePath)));
  const ssrChunks = await Promise.all(Object.entries(ssr.outputs)
    .filter(([output]) => output.endsWith('.js') && !primarySsr.has(output))
    .map(async ([output]) => ({
      path: relativeArtifactPath(root, output),
      integrity: await integrity(path.resolve(output)),
    })));
  ssrChunks.sort((left, right) => left.path.localeCompare(right.path));
  const clients: RscClientReference[] = [];
  for (const entry of entries) {
    const browserModule = relativeArtifactPath(root, outputForEntry(browser, entry.absolutePath));
    const ssrModule = relativeArtifactPath(root, outputForEntry(ssr, entry.absolutePath));
    for (const exportName of entry.exports) clients.push({
      id: `${entry.referenceBase}#${exportName}`,
      module: browserModule,
      ssrModule,
      exportName,
      chunks: browserChunks.map((chunk) => ({ ...chunk })),
      ssrChunks: ssrChunks.map((chunk) => ({ ...chunk })),
      integrity: await integrity(path.join(root, browserModule)),
      ssrIntegrity: await integrity(path.join(root, ssrModule)),
    });
  }
  const styles = await Promise.all(Object.keys(browser.outputs)
    .filter((output) => output.endsWith('.css'))
    .sort()
    .map(async (output) => ({
      path: relativeArtifactPath(root, output),
      integrity: await integrity(path.resolve(output)),
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
