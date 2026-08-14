import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpLoader } from './loader.js';

describe('McpLoader', () => {
  it('loads default exported definitions from a mcps directory and unloads the batch', async () => {
    const loader = new McpLoader({ id: 'fixture' });
    const directory = fileURLToPath(new URL('../../testdata/mcps', import.meta.url));

    const loaded = await loader.loadProvider(directory);
    expect(Object.keys(loaded.provider.tools)).toEqual(['echo']);
    expect(Object.keys(loaded.provider.resources)).toEqual(['manual']);
    expect(Object.keys(loaded.provider.prompts)).toEqual(['explain']);

    loaded.unload();
    expect(loader.snapshot()).toEqual({ tools: {}, resources: {}, prompts: {} });
  });

  it('rejects a matched MCP module without a default definition', async () => {
    const loader = new McpLoader({ id: 'fixture' });
    const directory = fileURLToPath(new URL('../../testdata/missing-default', import.meta.url));
    await expect(loader.loadProvider(directory)).rejects.toThrow(/default export/i);
  });
});
