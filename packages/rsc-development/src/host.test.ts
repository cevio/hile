import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import type { RscPluginManifest } from '@hile/rsc/protocol';
import { InMemoryRscDeploymentCatalog } from '@hile/rsc/host/catalog';
import { InMemoryRscArtifactCatalog } from '@hile/rsc/host/registry';
import {
  bindRscHostDevelopmentState,
  RscDevelopmentEvents,
  RscDevelopmentCoordinator,
  createRscDevelopmentEventMiddleware,
  type RscDevelopmentEventContext,
} from './host';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function manifest(buildId = 'dev-r1'): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'org.example.a',
    buildId,
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: { entry: 'server.js', integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    serverFunctions: [],
    clients: [], styles: [], routes: [],
  };
}

async function stateFile(buildId = 'dev-r1') {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-host-development-'));
  roots.push(root);
  const file = path.join(root, 'state.json');
  await writeFile(file, JSON.stringify({ revisions: [{
    pluginId: 'org.example.a', buildId, namespace: 'org.example.a.dev', revision: 1, artifactRoot: '.',
  }] }));
  return file;
}

function context(path: string): RscDevelopmentEventContext & { headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return {
    path,
    status: 0,
    headers,
    set(name, value) { headers.set(name, value); },
  };
}

describe('RSC development events', () => {
  it('rolls back artifact registration when deployment activation fails', async () => {
    const file = await stateFile();
    const unregister = vi.fn();
    const artifacts = { register: vi.fn(() => unregister), get: vi.fn() };
    const deployments = new InMemoryRscDeploymentCatalog();
    vi.spyOn(deployments, 'install').mockImplementation(() => { throw new Error('install failed'); });

    await expect(bindRscHostDevelopmentState({
      file,
      application: {} as never,
      artifacts,
      deployments,
      events: new RscDevelopmentEvents(),
      runtime: manifest().runtime,
      verify: async () => ({ manifest: manifest(), files: [] }),
      waitUntilReady: async () => undefined,
    })).rejects.toThrow('install failed');
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('installs an explicitly inactive development revision without selecting it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-host-inactive-'));
    roots.push(root);
    const file = path.join(root, 'state.json');
    await writeFile(file, JSON.stringify({ revisions: [{
      pluginId: 'org.example.a', buildId: 'dev-r1', namespace: 'org.example.a.dev', revision: 1,
      artifactRoot: '.', active: false,
    }] }));
    const deployments = new InMemoryRscDeploymentCatalog();
    const close = await bindRscHostDevelopmentState({
      file,
      application: {} as never,
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments,
      events: new RscDevelopmentEvents(),
      runtime: manifest().runtime,
      verify: async () => ({ manifest: manifest(), files: [] }),
      waitUntilReady: async () => undefined,
    });

    expect(deployments.snapshot()).toEqual([
      expect.objectContaining({ buildId: 'dev-r1', state: 'inactive' }),
    ]);
    expect(deployments.getActive('org.example.a')).toBeUndefined();
    await close();
  });

  it('rolls back revisions installed earlier in the same initial state when a later revision fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-host-partial-'));
    roots.push(root);
    const file = path.join(root, 'state.json');
    await writeFile(file, JSON.stringify({ revisions: [
      { pluginId: 'org.example.a', buildId: 'a-r1', namespace: 'a.dev', revision: 1, artifactRoot: './a' },
      { pluginId: 'org.example.b', buildId: 'b-r1', namespace: 'b.dev', revision: 1, artifactRoot: './b' },
    ] }));
    const artifacts = new InMemoryRscArtifactCatalog();
    const deployments = new InMemoryRscDeploymentCatalog();
    const fixture = (pluginId: string, buildId: string): RscPluginManifest => ({
      ...manifest(buildId), pluginId,
    });

    await expect(bindRscHostDevelopmentState({
      file,
      application: {} as never,
      artifacts,
      deployments,
      events: new RscDevelopmentEvents(),
      runtime: manifest().runtime,
      verify: async (artifactRoot) => {
        if (artifactRoot.endsWith('/b')) throw new Error('second revision failed');
        return { manifest: fixture('org.example.a', 'a-r1'), files: [] };
      },
      waitUntilReady: async () => undefined,
    })).rejects.toThrow('second revision failed');

    expect(deployments.snapshot()).toEqual([]);
    expect(artifacts.get('org.example.a', 'a-r1')).toBeUndefined();
  });

  it('rejects mismatched artifact identity before catalog mutation', async () => {
    const file = await stateFile();
    const artifacts = { register: vi.fn(), get: vi.fn() };

    await expect(bindRscHostDevelopmentState({
      file,
      application: {} as never,
      artifacts: artifacts as never,
      deployments: new InMemoryRscDeploymentCatalog(),
      events: new RscDevelopmentEvents(),
      runtime: manifest().runtime,
      verify: async () => ({ manifest: { ...manifest(), buildId: 'other' }, files: [] }),
      waitUntilReady: async () => undefined,
    })).rejects.toThrow('identity mismatch');
    expect(artifacts.register).not.toHaveBeenCalled();
  });

  it('aborts a hanging readiness call and cleans installed development state on close', async () => {
    const file = await stateFile();
    const hangingApplication = {
      call(_namespace: string, _operation: string, _data: unknown, options?: { signal?: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
      stream() { throw new Error('unused'); },
    };
    await expect(bindRscHostDevelopmentState({
      file,
      application: hangingApplication,
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments: new InMemoryRscDeploymentCatalog(),
      events: new RscDevelopmentEvents(),
      runtime: manifest().runtime,
      readinessTimeoutMs: 20,
      verify: async () => ({ manifest: manifest(), files: [] }),
    })).rejects.toThrow('did not activate');

    const artifacts = new InMemoryRscArtifactCatalog();
    const deployments = new InMemoryRscDeploymentCatalog();
    const close = await bindRscHostDevelopmentState({
      file,
      application: {} as never,
      artifacts,
      deployments,
      events: new RscDevelopmentEvents(),
      runtime: manifest().runtime,
      verify: async () => ({ manifest: manifest(), files: [] }),
      waitUntilReady: async () => undefined,
    });
    expect(deployments.getActive('org.example.a')?.buildId).toBe('dev-r1');
    expect(artifacts.get('org.example.a', 'dev-r1')).toBeDefined();
    await close();
    expect(deployments.snapshot()).toEqual([]);
    expect(artifacts.get('org.example.a', 'dev-r1')).toBeUndefined();
  });

  it('retires old deployments and bounds retained development artifacts after activation', async () => {
    const file = await stateFile('dev-r1');
    const deployments = new InMemoryRscDeploymentCatalog();
    const unregister = new Map<string, ReturnType<typeof vi.fn>>();
    const artifacts = {
      register: vi.fn((_root: string, value: RscPluginManifest) => {
        const cleanup = vi.fn();
        unregister.set(value.buildId, cleanup);
        return cleanup;
      }),
      get: vi.fn(),
    };
    const close = await bindRscHostDevelopmentState({
      file,
      application: {} as never,
      artifacts,
      deployments,
      events: new RscDevelopmentEvents(),
      runtime: manifest().runtime,
      retainedArtifactRevisions: 2,
      verify: async (_root) => {
        const state = JSON.parse(await readFile(file, 'utf8'));
        return { manifest: manifest(state.revisions[0].buildId), files: [] };
      },
      waitUntilReady: async () => undefined,
    });
    for (const revision of [2, 3]) {
      await writeFile(file, JSON.stringify({ revisions: [{
        pluginId: 'org.example.a',
        buildId: `dev-r${revision}`,
        namespace: 'org.example.a.dev',
        revision,
        artifactRoot: '.',
      }] }));
      await vi.waitFor(() => expect(deployments.getActive('org.example.a')?.buildId).toBe(`dev-r${revision}`));
    }
    await vi.waitFor(() => expect(deployments.snapshot().map(({ buildId }) => buildId)).toEqual(['dev-r3']));
    expect(unregister.get('dev-r1')).toHaveBeenCalledOnce();
    expect(unregister.get('dev-r2')).not.toHaveBeenCalled();
    await close();
    expect(unregister.get('dev-r2')).toHaveBeenCalledOnce();
    expect(unregister.get('dev-r3')).toHaveBeenCalledOnce();
  });

  it('isolates subscriber failures from an already successful activation', () => {
    const onListenerError = vi.fn();
    const events = new RscDevelopmentEvents({ onListenerError });
    const healthy = vi.fn();
    events.subscribe(() => { throw new Error('broken subscriber'); });
    events.subscribe(healthy);

    expect(() => events.publish({ pluginId: 'a', buildId: 'r1', revision: 1 })).not.toThrow();
    expect(onListenerError).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('announces a revision only after the injected activation succeeds and serializes activation', async () => {
    const events = new RscDevelopmentEvents();
    const seen: string[] = [];
    events.subscribe((event) => seen.push(event.buildId));
    const release = vi.fn(async ({ buildId }: { buildId: string }) => {
      await Promise.resolve();
      if (buildId === 'broken') throw new Error('activation failed');
    });
    const coordinator = new RscDevelopmentCoordinator({ events, activate: release });

    await Promise.all([
      coordinator.activate({ pluginId: 'a', buildId: 'r1', revision: 1 }),
      coordinator.activate({ pluginId: 'a', buildId: 'r2', revision: 2 }),
    ]);
    await expect(coordinator.activate({ pluginId: 'a', buildId: 'broken', revision: 3 }))
      .rejects.toThrow('activation failed');

    expect(seen).toEqual(['r1', 'r2']);
    expect(events.current('a')?.buildId).toBe('r2');
  });

  it('publishes monotonic activated revisions to subscribers', () => {
    const events = new RscDevelopmentEvents();
    const listener = vi.fn();
    const unsubscribe = events.subscribe(listener);

    events.publish({
      pluginId: 'org.example.a', buildId: 'dev-r1', revision: 1, artifactRoot: '/private/path',
    } as Parameters<typeof events.publish>[0]);
    events.publish({ pluginId: 'org.example.a', buildId: 'dev-r2', revision: 2 });
    unsubscribe();
    events.publish({ pluginId: 'org.example.a', buildId: 'dev-r3', revision: 3 });

    expect(listener.mock.calls.map(([event]) => event.revision)).toEqual([1, 2]);
    expect(listener.mock.calls[0][0]).not.toHaveProperty('artifactRoot');
    expect(events.current('org.example.a')).toMatchObject({ buildId: 'dev-r3', revision: 3 });
  });

  it('rejects stale or conflicting revisions without notifying browsers', () => {
    const events = new RscDevelopmentEvents();
    const listener = vi.fn();
    events.subscribe(listener);
    events.publish({ pluginId: 'org.example.a', buildId: 'dev-r2', revision: 2 });

    expect(() => events.publish({ pluginId: 'org.example.a', buildId: 'dev-r1', revision: 1 }))
      .toThrow('newer');
    expect(() => events.publish({ pluginId: 'org.example.a', buildId: 'other', revision: 2 }))
      .toThrow('conflicts');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('composes as an SSE middleware and cleans up disconnected subscribers', async () => {
    const events = new RscDevelopmentEvents();
    const middleware = createRscDevelopmentEventMiddleware({ events, mountPath: '/dev/rsc' });
    const outside = context('/outside');
    const next = vi.fn(async () => 'next');
    await expect(middleware(outside, next)).resolves.toBe('next');

    const request = context('/dev/rsc');
    await middleware(request, vi.fn());
    expect(request.status).toBe(200);
    expect(request.type).toBe('text/event-stream; charset=utf-8');
    expect(request.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    const iterator = request.body![Symbol.asyncIterator]();
    expect(Buffer.from((await iterator.next()).value!).toString()).toContain('connected');
    const pending = iterator.next();
    events.publish({ pluginId: 'org.example.a', buildId: 'dev-r1', revision: 1 });
    expect(Buffer.from((await pending).value!).toString()).toContain('"buildId":"dev-r1"');
    (request.body as AsyncIterable<Uint8Array> & { destroy(): void }).destroy();
    await vi.waitFor(() => expect(events.subscriberCount()).toBe(0));
  });

  it('coalesces blocked SSE revisions per plugin instead of growing an unbounded queue', async () => {
    const events = new RscDevelopmentEvents();
    const middleware = createRscDevelopmentEventMiddleware({ events, streamHighWaterMark: 1 });
    const request = context('/_hile/rsc/development');
    await middleware(request, vi.fn());
    const pluginId = 'org.example.a';
    events.publish({ pluginId, buildId: 'r1', revision: 1 });
    events.publish({ pluginId, buildId: 'r2', revision: 2 });
    events.publish({ pluginId, buildId: 'r3', revision: 3 });

    const iterator = request.body![Symbol.asyncIterator]();
    let output = '';
    try {
      while (!output.includes('"buildId":"r3"')) {
        const chunk = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('latest SSE revision was not flushed')), 1_000)),
        ]);
        if (chunk.done) throw new Error('SSE stream ended before the latest revision was flushed');
        output += Buffer.from(chunk.value).toString();
      }
    } finally {
      (request.body as AsyncIterable<Uint8Array> & { destroy(): void }).destroy();
    }
    expect(output).toContain('"buildId":"r3"');
    expect(output).not.toContain('"buildId":"r1"');
    expect(output).not.toContain('"buildId":"r2"');
  });

  it('rejects invalid SSE stream watermarks before opening a stream', () => {
    const events = new RscDevelopmentEvents();
    expect(() => createRscDevelopmentEventMiddleware({ events, streamHighWaterMark: 0 }))
      .toThrow('streamHighWaterMark');
    expect(() => createRscDevelopmentEventMiddleware({ events, streamHighWaterMark: 1.5 }))
      .toThrow('streamHighWaterMark');
  });
});
