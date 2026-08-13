import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRscDevelopmentState, watchRscDevelopmentState } from './state';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function stateFile(value: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-state-'));
  roots.push(root);
  const file = path.join(root, 'state.json');
  await writeFile(file, JSON.stringify(value));
  return { root, file };
}

describe('RSC development state', () => {
  it('rejects an invalid polling interval before opening a watcher', async () => {
    const { file } = await stateFile({ revisions: [] });
    expect(() => watchRscDevelopmentState(file, async () => undefined, { pollMs: 9 }))
      .toThrow('pollMs');
  });

  it('validates identities and resolves artifact roots relative to the state file', async () => {
    const { root, file } = await stateFile({ revisions: [{
      pluginId: 'org.example', buildId: 'dev-r1', namespace: 'org.example.dev', revision: 1,
      artifactRoot: './artifacts/r1',
    }] });

    await expect(readRscDevelopmentState(file)).resolves.toEqual({ revisions: [{
      pluginId: 'org.example', buildId: 'dev-r1', namespace: 'org.example.dev', revision: 1,
      artifactRoot: path.join(root, 'artifacts/r1'),
    }] });
  });

  it('preserves an explicit inactive development deployment hint', async () => {
    const { root, file } = await stateFile({ revisions: [{
      pluginId: 'org.example', buildId: 'dev-r1', namespace: 'org.example.dev', revision: 1,
      artifactRoot: './artifacts/r1', active: false,
    }] });

    await expect(readRscDevelopmentState(file)).resolves.toEqual({ revisions: [{
      pluginId: 'org.example', buildId: 'dev-r1', namespace: 'org.example.dev', revision: 1,
      artifactRoot: path.join(root, 'artifacts/r1'), active: false,
    }] });
  });

  it.each([
    {},
    { revisions: [{}] },
    { revisions: [{ pluginId: 'a', buildId: 'b', namespace: 'n', revision: 0, artifactRoot: '.' }] },
    { revisions: [
      { pluginId: 'a', buildId: 'b1', namespace: 'n', revision: 1, artifactRoot: '.' },
      { pluginId: 'a', buildId: 'b2', namespace: 'n', revision: 2, artifactRoot: '.' },
    ] },
  ])('rejects malformed or duplicate state %#', async (value) => {
    const { file } = await stateFile(value);
    await expect(readRscDevelopmentState(file)).rejects.toThrow();
  });

  it('serializes refresh callbacks and reports later parse failures without stopping', async () => {
    const { file } = await stateFile({ revisions: [] });
    const listener = vi.fn(async () => undefined);
    const onError = vi.fn();
    const watcher = watchRscDevelopmentState(file, listener, { onError });
    await watcher.refresh();
    await writeFile(file, '{invalid');
    await expect(watcher.refresh()).rejects.toThrow();
    await writeFile(file, JSON.stringify({ revisions: [] }));
    await watcher.refresh();
    await watcher.close();
    await watcher.refresh();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('keeps observing state after repeated atomic file replacement', async () => {
    const { root, file } = await stateFile({ revisions: [] });
    const listener = vi.fn(async () => undefined);
    const watcher = watchRscDevelopmentState(file, listener, { debounceMs: 5 });
    await watcher.refresh();
    for (let revision = 1; revision <= 2; revision++) {
      const temporary = path.join(root, `state-${revision}.tmp`);
      await writeFile(temporary, JSON.stringify({ revisions: [{
        pluginId: 'a', buildId: `b${revision}`, namespace: 'n', revision, artifactRoot: '.',
      }] }));
      await rename(temporary, file);
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(revision + 1));
    }
    await watcher.close();
  });

  it('waits for an in-flight listener before close resolves', async () => {
    const { file } = await stateFile({ revisions: [] });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const watcher = watchRscDevelopmentState(file, async () => {
      started();
      await blocked;
    });
    const refresh = watcher.refresh();
    await didStart;
    let closed = false;
    const closing = watcher.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([refresh, closing]);
    expect(closed).toBe(true);
  });
});
