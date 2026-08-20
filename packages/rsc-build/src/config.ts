import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import type { BuildRscPluginOptions } from './build-plugin';

type BuildRscPluginConfig = Omit<BuildRscPluginOptions, 'buildId' | 'outdir' | 'runtime'> & {
  buildId?: string;
  outdir?: string;
  runtime?: BuildRscPluginOptions['runtime'];
};

export async function loadRscBuildConfig(configInput: string): Promise<BuildRscPluginConfig & {
  outdir: string;
  runtime: BuildRscPluginOptions['runtime'];
}> {
  const configPath = path.resolve(configInput);
  const extension = path.extname(configPath);
  const raw = extension === '.json'
    ? JSON.parse(await readFile(configPath, 'utf8'))
    : (await import(`${pathToFileURL(configPath).href}?t=${Date.now()}`)).default;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('RSC build config must export an object');
  }
  const config = raw as BuildRscPluginConfig;
  if (config.outdir !== undefined && typeof config.outdir !== 'string') {
    throw new TypeError('RSC outdir must be a string');
  }
  if (config.runtime !== undefined && (
    config.runtime === null
    || typeof config.runtime !== 'object'
    || Array.isArray(config.runtime)
  )) {
    throw new TypeError('RSC runtime must be an object');
  }
  const configuredBuildId = typeof config.buildId === 'string' && config.buildId.trim() !== ''
    ? config.buildId.trim()
    : undefined;
  const outdir = typeof config.outdir === 'string' && config.outdir.trim() !== ''
    ? config.outdir
    : configuredBuildId ? path.join('.hile-rsc', configuredBuildId) : '.hile-rsc';
  const configDirectory = path.dirname(configPath);
  return {
    ...config,
    cwd: path.resolve(configDirectory, config.cwd),
    outdir: path.resolve(configDirectory, outdir),
    runtime: config.runtime ?? { ...HILE_RSC_RUNTIME },
  };
}
