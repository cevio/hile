import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext } from '@hile/context';
import type { RscPluginManifest } from '../protocol';
import { RscArtifactServerFunctionRuntime } from './server-functions';

const directories: string[] = [];
const executionContext = createExecutionContext({ requestId: 'server-function-test' });
const runtimeModule = new URL('./server-functions.ts', import.meta.url).href;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-server-function-'));
  directories.push(root);
  await mkdir(path.join(root, 'server-functions'), { recursive: true });
  await writeFile(path.join(root, 'server-functions/actions.mjs'), `
    import { defineRscServerFunction } from ${JSON.stringify(runtimeModule)};
    ${source}
  `);
  return root;
}

function manifest(): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'com.example.plugin',
    buildId: 'build-1',
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: {
      entry: 'server-rsc/index.js',
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
    serverFunctions: [{
      id: 'com.example.plugin/build-1/src/actions#save',
      module: 'server-functions/actions.mjs',
      exportName: 'save',
      integrity: 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
    }],
    clients: [],
    styles: [],
    routes: [{ path: '/', entry: 'default' }],
  };
}

describe('RscArtifactServerFunctionRuntime', () => {
  it('loads and caches the allowlisted artifact export', async () => {
    const root = await fixture(`
      export const save = defineRscServerFunction(async (_api, value) => ({ value: value + 1 }));
    `);
    const runtime = new RscArtifactServerFunctionRuntime(root);
    const current = manifest();
    const invokeModel = vi.fn();

    await expect(runtime.invoke({
      manifest: current,
      reference: current.serverFunctions[0],
      args: [4],
      signal: new AbortController().signal,
      context: executionContext,
      invokeModel,
    })).resolves.toEqual({ value: 5 });
    await expect(runtime.invoke({
      manifest: current,
      reference: current.serverFunctions[0],
      args: [9],
      signal: new AbortController().signal,
      context: executionContext,
      invokeModel,
    })).resolves.toEqual({ value: 10 });
    expect(runtime.cachedModuleCount).toBe(1);
  });

  it('exposes Model invocation and AbortSignal through request-local context', async () => {
    const root = await fixture(`
      export const save = defineRscServerFunction(async (api, value) => {
        const result = await api.invokeModel('counter/save', { value });
        return { result, aborted: api.signal.aborted, requestId: api.context.values.requestId };
      });
    `);
    const runtime = new RscArtifactServerFunctionRuntime(root);
    const current = manifest();
    const invokeModel = vi.fn(async (id, input) => ({ id, input }));

    await expect(runtime.invoke({
      manifest: current,
      reference: current.serverFunctions[0],
      args: [3],
      signal: new AbortController().signal,
      context: executionContext,
      invokeModel,
    })).resolves.toEqual({
      result: { id: 'counter/save', input: { value: 3 } },
      aborted: false,
      requestId: 'server-function-test',
    });
  });

  it('rejects missing exports, escaping paths, and pre-aborted execution', async () => {
    const root = await fixture(`export const other = defineRscServerFunction(async () => undefined);`);
    const runtime = new RscArtifactServerFunctionRuntime(root);
    const current = manifest();
    const context = {
      manifest: current,
      reference: current.serverFunctions[0],
      args: [],
      signal: new AbortController().signal,
      context: executionContext,
      invokeModel: vi.fn(),
    };

    await expect(runtime.invoke(context)).rejects.toThrow('export');
    const escapingReference = { ...context.reference, module: '../escape.mjs' };
    await expect(runtime.invoke({
      ...context,
      manifest: { ...current, serverFunctions: [escapingReference] },
      reference: escapingReference,
    })).rejects.toThrow('root');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(runtime.invoke({ ...context, signal: controller.signal }))
      .rejects.toThrow('cancelled');
  });

  it('rejects an unmarked callable artifact instead of injecting the API into it', async () => {
    const root = await fixture(`export async function save(value) { return value; }`);
    const runtime = new RscArtifactServerFunctionRuntime(root);
    const current = manifest();

    await expect(runtime.invoke({
      manifest: current,
      reference: current.serverFunctions[0],
      args: [1],
      signal: new AbortController().signal,
      context: executionContext,
      invokeModel: vi.fn(),
    })).rejects.toThrow('defineRscServerFunction');
  });
});
