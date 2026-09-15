import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RscPluginManifest } from '@hile/rsc/protocol';
import { HileRscPluginRuntime } from './plugin-runtime';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function artifact() {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-plugin-runtime-'));
  roots.push(root);
  const server = Buffer.from('export default null');
  const manifest: RscPluginManifest = {
    protocolVersion: 1,
    pluginId: 'org.hile.runtime',
    buildId: 'build-1',
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: {
      entry: 'server/index.js',
      integrity: `sha256-${createHash('sha256').update(server).digest('base64')}`,
    },
    serverFunctions: [], clients: [], styles: [], routes: [{ path: '/', entry: 'default' }],
  };
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, manifest.server.entry), server);
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest));
  return { root };
}

function service(events: string[]) {
  return {
    describe: vi.fn(), render: vi.fn(), action: vi.fn(), serverFunction: vi.fn(),
    prepare: vi.fn(async () => { events.push('prepare'); }),
    onDeactivate: vi.fn(() => () => undefined),
    deactivate: vi.fn(() => { events.push('deactivate'); }),
    drain: vi.fn(async () => { events.push('drain'); }),
  };
}

describe('HileRscPluginRuntime', () => {
  it('rejects an invalid renderer preparation timeout', async () => {
    const value = await artifact();
    expect(() => new HileRscPluginRuntime({
      application: { register: vi.fn(), listen: vi.fn(), publish: vi.fn() } as never,
      service: service([]) as never,
      port: 4101,
      prepareTimeoutMs: 0,
      discovery: {
        namespace: 'runtime.service', instanceId: 'runtime-instance', priority: 1,
        artifactRoot: value.root, authentication: { keyId: 'runtime', secret: 'secret' },
      },
    })).toThrow('prepareTimeoutMs');
  });

  it('orders listener, signed publication and development binding, then closes every owned phase', async () => {
    const value = await artifact();
    const events: string[] = [];
    const unregister = vi.fn(() => { events.push('unregister'); });
    const update = vi.fn(async () => undefined);
    let publishArtifact!: (artifactRoot: string) => Promise<unknown>;
    const application = {
      register: vi.fn(() => unregister),
      listen: vi.fn(async () => {
        events.push('listen');
        return async () => { events.push('stop'); };
      }),
      publish: vi.fn(async () => {
        events.push('publish');
        return {
          update,
          unpublish: async () => { events.push('unpublish'); },
        };
      }),
    };
    const auxiliary = { close: vi.fn(async () => { events.push('auxiliary'); }) };
    const runtime = new HileRscPluginRuntime({
      application,
      service: service(events) as never,
      port: 4101,
      discovery: {
        namespace: 'runtime.service', instanceId: 'runtime-instance', priority: 1,
        artifactRoot: value.root, authentication: { keyId: 'runtime', secret: 'secret' },
      },
      resources: [auxiliary],
      bindDevelopment: async (publish) => {
        events.push('bind');
        publishArtifact = publish;
        return async () => { events.push('unbind'); };
      },
    });

    await runtime.start();
    expect(events.slice(0, 4)).toEqual(['prepare', 'listen', 'publish', 'bind']);
    await publishArtifact(value.root);
    expect(update).not.toHaveBeenCalled(); // Same immutable build is idempotent.
    await runtime.close();
    expect(events).toEqual([
      'prepare', 'listen', 'publish', 'bind',
      'unpublish', 'unregister', 'unbind', 'auxiliary', 'deactivate', 'drain',
      'unregister', 'unregister', 'unregister', 'unregister', 'stop',
    ]);
    await runtime.close();
    expect(auxiliary.close).toHaveBeenCalledOnce();
  });

  it('does not attach, listen or publish when renderer preparation fails', async () => {
    const value = await artifact();
    const events: string[] = [];
    const application = {
      register: vi.fn(() => () => { events.push('unregister'); }),
      listen: vi.fn(async () => async () => { events.push('stop'); }),
      publish: vi.fn(),
    };
    const failedService = service(events);
    failedService.prepare.mockRejectedValueOnce(new Error('renderer not ready'));
    const runtime = new HileRscPluginRuntime({
      application,
      service: failedService as never,
      port: 4101,
      discovery: {
        namespace: 'runtime.service', instanceId: 'runtime-instance', priority: 1,
        artifactRoot: value.root, authentication: { keyId: 'runtime', secret: 'secret' },
      },
    });

    await expect(runtime.start()).rejects.toThrow('renderer not ready');
    expect(application.register).not.toHaveBeenCalled();
    expect(application.listen).not.toHaveBeenCalled();
    expect(application.publish).not.toHaveBeenCalled();
  });

  it('cancels renderer preparation when close interrupts startup', async () => {
    const value = await artifact();
    const events: string[] = [];
    let prepareSignal!: AbortSignal;
    const preparingService = service(events);
    preparingService.prepare.mockImplementationOnce(({ signal }) => {
      prepareSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const application = {
      register: vi.fn(),
      listen: vi.fn(),
      publish: vi.fn(),
    };
    const runtime = new HileRscPluginRuntime({
      application: application as never,
      service: preparingService as never,
      port: 4101,
      discovery: {
        namespace: 'runtime.service', instanceId: 'runtime-instance', priority: 1,
        artifactRoot: value.root, authentication: { keyId: 'runtime', secret: 'secret' },
      },
    });

    const started = runtime.start();
    await vi.waitFor(() => expect(prepareSignal).toBeInstanceOf(AbortSignal));
    const closed = runtime.close();

    await expect(started).rejects.toThrow('closing');
    await expect(closed).resolves.toBeUndefined();
    expect(prepareSignal.aborted).toBe(true);
    expect(application.listen).not.toHaveBeenCalled();
    expect(application.publish).not.toHaveBeenCalled();
  });

  it('fails closed when renderer preparation reaches its deadline', async () => {
    const value = await artifact();
    let prepareSignal!: AbortSignal;
    const preparingService = service([]);
    preparingService.prepare.mockImplementationOnce(({ signal }) => {
      prepareSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const application = {
      register: vi.fn(),
      listen: vi.fn(),
      publish: vi.fn(),
    };
    const runtime = new HileRscPluginRuntime({
      application: application as never,
      service: preparingService as never,
      port: 4101,
      prepareTimeoutMs: 1,
      discovery: {
        namespace: 'runtime.service', instanceId: 'runtime-instance', priority: 1,
        artifactRoot: value.root, authentication: { keyId: 'runtime', secret: 'secret' },
      },
    });

    await expect(runtime.start()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(prepareSignal.aborted).toBe(true);
    expect(application.listen).not.toHaveBeenCalled();
    expect(application.publish).not.toHaveBeenCalled();
    expect(preparingService.deactivate).toHaveBeenCalledOnce();
    expect(preparingService.drain).toHaveBeenCalledOnce();
  });

  it('does not publish when close interrupts listener startup', async () => {
    const value = await artifact();
    let finishListen!: (stop: () => Promise<void>) => void;
    const stop = vi.fn(async () => undefined);
    const application = {
      register: vi.fn(() => vi.fn()),
      listen: vi.fn(() => new Promise<() => Promise<void>>((resolve) => {
        finishListen = resolve;
      })),
      publish: vi.fn(),
    };
    const runtime = new HileRscPluginRuntime({
      application: application as never,
      service: service([]) as never,
      port: 4101,
      discovery: {
        namespace: 'runtime.service', instanceId: 'runtime-instance', priority: 1,
        artifactRoot: value.root, authentication: { keyId: 'runtime', secret: 'secret' },
      },
    });

    const started = runtime.start();
    await vi.waitFor(() => expect(application.listen).toHaveBeenCalledOnce());
    const closed = runtime.close();
    finishListen(stop);

    await expect(started).rejects.toThrow('closing');
    await expect(closed).resolves.toBeUndefined();
    expect(application.publish).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('rolls back listener, resources and service when development binding fails', async () => {
    const value = await artifact();
    const events: string[] = [];
    const runtime = new HileRscPluginRuntime({
      application: {
        register: vi.fn(() => () => { events.push('unregister'); }),
        listen: vi.fn(async () => async () => { events.push('stop'); }),
        publish: vi.fn(async () => ({
          update: vi.fn(),
          unpublish: async () => { events.push('unpublish'); },
        })),
      },
      service: service(events) as never,
      port: 4101,
      discovery: {
        namespace: 'runtime.service', instanceId: 'runtime-instance', priority: 1,
        artifactRoot: value.root, authentication: { keyId: 'runtime', secret: 'secret' },
      },
      resources: [{ close: async () => { events.push('auxiliary'); } }],
      bindDevelopment: async () => { throw new Error('binding failed'); },
    });

    await expect(runtime.start()).rejects.toThrow('binding failed');
    expect(events).toEqual([
      'prepare', 'unpublish', 'unregister', 'auxiliary', 'deactivate', 'drain',
      'unregister', 'unregister', 'unregister', 'unregister', 'stop',
    ]);
    await expect(runtime.start()).rejects.toThrow('closing');
  });
});
