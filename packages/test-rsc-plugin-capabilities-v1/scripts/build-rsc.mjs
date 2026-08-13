import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildRscPlugin } from '@hile/rsc-build';

const packageRoot = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(path.join(packageRoot, 'hile-rsc.json'), 'utf8'));
const outdir = path.resolve(packageRoot, config.outdir);
await rm(outdir, { recursive: true, force: true });
const manifest = await buildRscPlugin({
  ...config,
  cwd: path.resolve(packageRoot, config.cwd),
  outdir,
});
console.log(`built ${manifest.pluginId}@${manifest.buildId} -> ${outdir}`);
