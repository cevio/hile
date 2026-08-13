import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelActionRegistry, ModelActionRegistryError } from './action-registry';

const modelModule = new URL('./model.ts', import.meta.url).href;

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hile-model-actions-'));
  for (const [relative, source] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

describe('ModelActionRegistry', () => {
  it('scans domain directories and mounts only defineActionModel exports', async () => {
    const root = await fixture({
      'counter/increment.model.mjs': `import { defineActionModel } from ${JSON.stringify(modelModule)}; export default defineActionModel(async ({ value }) => ({ value: value + 1 }));`,
      'counter/read.model.mjs': `import { defineModel } from ${JSON.stringify(modelModule)}; export default defineModel(async ({ value }) => ({ value }));`,
    });
    const registry = new ModelActionRegistry();
    await registry.load(root);

    expect(registry.ids()).toEqual(['counter/increment']);
    await expect(registry.invoke('counter/increment', { value: 2 })).resolves.toEqual({ value: 3 });
    await expect(registry.invoke('counter/read', { value: 2 })).rejects.toMatchObject({
      code: 'ERR_MODEL_ACTION_NOT_FOUND',
    });
  });

  it('uses index paths as the domain action id and supports idempotent unload', async () => {
    const root = await fixture({
      'counter/index.model.mjs': `import { defineActionModel } from ${JSON.stringify(modelModule)}; export default defineActionModel(async (input) => input);`,
    });
    const registry = new ModelActionRegistry();
    const unload = await registry.load(root);
    expect(registry.ids()).toEqual(['counter']);
    unload();
    unload();
    expect(registry.ids()).toEqual([]);
  });

  it.each([null, [], 'value', 1])('rejects non-object input: %j', async (input) => {
    const registry = new ModelActionRegistry();
    await expect(registry.invoke('missing', input)).rejects.toMatchObject({
      code: 'ERR_MODEL_ACTION_INVALID_INPUT',
    });
  });

  it('rejects malformed model modules without replacing an existing registry', async () => {
    const valid = await fixture({
      'valid.model.mjs': `import { defineActionModel } from ${JSON.stringify(modelModule)}; export default defineActionModel(async () => ({ ok: true }));`,
    });
    const invalid = await fixture({ 'broken.model.mjs': 'export default { handler() {} };' });
    const registry = new ModelActionRegistry();
    await registry.load(valid);

    await expect(registry.load(invalid)).rejects.toBeInstanceOf(ModelActionRegistryError);
    expect(registry.ids()).toEqual(['valid']);
  });

  it('rejects an already aborted invocation before executing a model', async () => {
    const root = await fixture({
      'run.model.mjs': `import { defineActionModel } from ${JSON.stringify(modelModule)}; export default defineActionModel(async () => ({ ran: true }));`,
    });
    const registry = new ModelActionRegistry();
    await registry.load(root);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(registry.invoke('run', {}, { signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('rejects duplicate ids atomically', async () => {
    const root = await fixture({
      'account/save.model.js': `import { defineActionModel } from ${JSON.stringify(modelModule)}; export default defineActionModel(async () => ({ source: 'js' }));`,
      'account/save.model.mjs': `import { defineActionModel } from ${JSON.stringify(modelModule)}; export default defineActionModel(async () => ({ source: 'mjs' }));`,
    });
    const registry = new ModelActionRegistry();
    await expect(registry.load(root)).rejects.toMatchObject({ code: 'ERR_MODEL_ACTION_DUPLICATE' });
    expect(registry.ids()).toEqual([]);
  });

  it('rejects a root index action because it has no stable public id', async () => {
    const root = await fixture({
      'index.model.mjs': `import { defineActionModel } from ${JSON.stringify(modelModule)}; export default defineActionModel(async () => ({}));`,
    });
    const registry = new ModelActionRegistry();
    await expect(registry.load(root)).rejects.toMatchObject({ code: 'ERR_MODEL_ACTION_INVALID_ID' });
  });

  it('uses @hile/loader path normalization for domain grouping directories', async () => {
    const root = await fixture({
      'account/(commands)/save.model.mjs': `import { defineActionModel } from ${JSON.stringify(modelModule)}; export default defineActionModel(async (input) => input);`,
    });
    const registry = new ModelActionRegistry();
    await registry.load(root);
    expect(registry.ids()).toEqual(['account/save']);
  });
});
