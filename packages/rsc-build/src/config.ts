import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildRscPluginOptions } from './build-plugin';

export async function loadRscBuildConfig(configInput: string): Promise<BuildRscPluginOptions> {
  const configPath = path.resolve(configInput);
  const extension = path.extname(configPath);
  const raw = extension === '.json'
    ? JSON.parse(await readFile(configPath, 'utf8'))
    : (await import(`${pathToFileURL(configPath).href}?t=${Date.now()}`)).default;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('RSC build config must export an object');
  }
  const config = raw as BuildRscPluginOptions;
  const configDirectory = path.dirname(configPath);
  return {
    ...config,
    cwd: path.resolve(configDirectory, config.cwd),
    outdir: path.resolve(configDirectory, config.outdir),
  };
}
