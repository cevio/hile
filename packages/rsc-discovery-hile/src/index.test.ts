import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RscPluginManifest } from '@hile/rsc/protocol';
import { canonicalizeRscDiscoveryAnnouncement } from '@hile/rsc-discovery';
import {
  downloadHileRscArtifact,
  createHmacRscDiscoveryAuthorizer,
  readHileRscDiscoverySnapshot,
  registerHileRscPluginDiscovery,
} from './index';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function integrity(value: Uint8Array): string {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`;
}

async function artifact(buildId = 'build-1') {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-discovery-test-'));
  temporaryDirectories.push(root);
  const server = Buffer.from(`export default ${JSON.stringify(buildId)}`);
  const manifest: RscPluginManifest = {
    protocolVersion: 1,
    pluginId: 'org.hile.fixture',
    buildId,
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: { entry: 'server/index.js', integrity: integrity(server) },
    serverFunctions: [],
    clients: [], styles: [], routes: [{ path: '/', entry: 'default' }],
    metadata: {
      displayName: `Fixture ${buildId}`,
      navigation: [{ id: 'home', label: 'Home', path: '/' }],
    },
  };
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(root, 'server')));
  await writeFile(path.join(root, manifest.server.entry), server);
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest));
  return { root, manifest, server };
}

describe('Hile RSC discovery publisher', () => {
  it('publishes one instance-scoped announcement and serves only verified declared files', async () => {
    const value = await artifact();
    let artifactHandler!: (input: { data: unknown; signal?: AbortSignal }) => unknown;
    const unregister = vi.fn();
    const unpublish = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const application = {
      register: vi.fn((_operation: string, handler: typeof artifactHandler) => {
        artifactHandler = handler;
        return unregister;
      }),
      publish: vi.fn(async () => ({ update, unpublish })),
    };

    const registration = await registerHileRscPluginDiscovery({
      application,
      namespace: 'fixture.service',
      instanceId: 'fixture-instance',
      priority: 10,
      artifactRoot: value.root,
      authentication: { keyId: 'test', secret: 'test-secret' },
    });

    expect(application.publish).toHaveBeenCalledWith(
      '@hile/rsc/discovery/v1/fixture-instance',
      expect.objectContaining({
        pluginId: 'org.hile.fixture', buildId: 'build-1', namespace: 'fixture.service', priority: 10,
      }),
    );
    const published = application.publish.mock.calls[0][1];
    const authorize = createHmacRscDiscoveryAuthorizer((keyId) => keyId === 'test'
      ? { secret: 'test-secret', pluginIds: ['org.hile.fixture'] }
      : undefined);
    expect(authorize(published)).toBe(true);
    const { generation: _legacyGeneration, ...legacyUnsigned } = published;
    const { generationSignature: _ignored, ...legacyAuthentication } = published.authentication;
    const legacyView = { ...legacyUnsigned, authentication: legacyAuthentication };
    expect(createHmacRscDiscoveryAuthorizer(() => ({
      secret: 'test-secret', pluginIds: ['org.hile.fixture'],
    }))(legacyView)).toBe(true);
    const strictAuthorize = createHmacRscDiscoveryAuthorizer(() => ({
      secret: 'test-secret', pluginIds: ['org.hile.fixture'], requireGeneration: true,
    }));
    expect(strictAuthorize(published)).toBe(true);
    expect(strictAuthorize(legacyView)).toBe(false);
    const { authentication: _legacyAuthentication, ...legacyPayload } = legacyView;
    expect(legacyAuthentication.signature).toBe(createHmac('sha256', 'test-secret')
      .update(canonicalizeRscDiscoveryAnnouncement(legacyPayload))
      .digest('base64url'));
    expect(authorize({ ...published, priority: published.priority + 1 })).toBe(false);
    expect(authorize({ ...published, generation: (published.generation ?? 0) + 1 })).toBe(false);
    const wrongOwner = createHmacRscDiscoveryAuthorizer(() => ({
      secret: 'test-secret', pluginIds: ['org.hile.other'],
    }));
    expect(wrongOwner(published)).toBe(false);
    expect(createHmacRscDiscoveryAuthorizer(() => ({
      secret: '', pluginIds: ['org.hile.fixture'],
    }))(published)).toBe(false);
    const stream = artifactHandler({
      data: { pluginId: 'org.hile.fixture', buildId: 'build-1', path: 'server/index.js' },
    }) as AsyncIterable<Uint8Array>;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(value.server)).toBe(true);
    expect(() => artifactHandler({
      data: { pluginId: 'org.hile.fixture', buildId: 'build-1', path: '../plugin.json' },
    })).toThrow('not declared');

    await registration.close();
    expect(unpublish).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('updates the announcement only after the replacement artifact verifies', async () => {
    const first = await artifact('build-1');
    const second = await artifact('build-2');
    const update = vi.fn(async () => undefined);
    const application = {
      register: vi.fn(() => vi.fn()),
      publish: vi.fn(async () => ({ update, unpublish: vi.fn(async () => undefined) })),
    };
    const registration = await registerHileRscPluginDiscovery({
      application, namespace: 'fixture.service', instanceId: 'fixture-instance', priority: 1,
      generation: 7,
      artifactRoot: first.root,
      authentication: { keyId: 'test', secret: 'test-secret' },
    });
    await registration.update(second.root);
    expect(application.publish).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({ buildId: 'build-1', generation: 7 }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ buildId: 'build-2', generation: 8 }));

    await writeFile(path.join(second.root, second.manifest.server.entry), 'corrupt');
    await expect(registration.update(second.root)).rejects.toThrow('integrity mismatch');
    expect(update).toHaveBeenCalledOnce();
    await registration.close();
  });

  it('treats identical build republishing as idempotent while preserving immutable build identity', async () => {
    const first = await artifact('build-1');
    const second = await artifact('build-2');
    let artifactHandler!: (input: { data: unknown }) => unknown;
    const application = {
      register: vi.fn((_operation: string, handler: typeof artifactHandler) => {
        artifactHandler = handler;
        return vi.fn();
      }),
      publish: vi.fn(async () => ({
        update: vi.fn(async () => undefined),
        unpublish: vi.fn(async () => undefined),
      })),
    };
    const registration = await registerHileRscPluginDiscovery({
      application,
      namespace: 'fixture.service',
      instanceId: 'fixture-instance',
      priority: 1,
      artifactRoot: first.root,
      retainedArtifacts: 1,
      authentication: { keyId: 'test', secret: 'test-secret' },
    });

    await registration.update(second.root);
    await registration.update(second.root);
    expect(() => artifactHandler({
      data: { pluginId: first.manifest.pluginId, buildId: first.manifest.buildId, path: first.manifest.server.entry },
    })).toThrow('not declared');
    const mutated = await artifact('build-2');
    mutated.manifest.server.integrity = integrity(Buffer.from('different valid artifact'));
    await writeFile(path.join(mutated.root, mutated.manifest.server.entry), 'different valid artifact');
    await writeFile(path.join(mutated.root, 'plugin.json'), JSON.stringify(mutated.manifest));
    await expect(registration.update(mutated.root)).rejects.toThrow('immutable');
    await registration.close();
  });

  it('keeps artifact serving attached until a failed unpublish is retried', async () => {
    const value = await artifact();
    const unregister = vi.fn();
    const unpublish = vi.fn()
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValueOnce(undefined);
    const registration = await registerHileRscPluginDiscovery({
      application: {
        register: vi.fn(() => unregister),
        publish: vi.fn(async () => ({ update: vi.fn(), unpublish })),
      },
      namespace: 'fixture.service', instanceId: 'fixture-instance', priority: 1,
      artifactRoot: value.root,
      authentication: { keyId: 'test', secret: 'test-secret' },
    });

    await expect(registration.close()).rejects.toThrow('registry unavailable');
    expect(unregister).not.toHaveBeenCalled();
    await registration.close();
    expect(unpublish).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledOnce();
    await expect(registration.update(value.root)).rejects.toThrow('closed');
  });
});

describe('Hile RSC discovery reader and artifact downloader', () => {
  it('reads all instance topics and quarantines malformed announcements independently', async () => {
    const topics = [
      { topic: '@hile/rsc/discovery/v1/good', hasData: true },
      { topic: '@hile/rsc/discovery/v1/bad', hasData: true },
      { topic: '@hile/rsc/discovery/v1/empty', hasData: false },
    ];
    const good = {
      schemaVersion: 1, capability: '@hile/rsc', instanceId: 'good', pluginId: 'org.hile.fixture',
      buildId: 'build-1', namespace: 'fixture.service', priority: 1, protocolVersion: 1,
      runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
      artifactOperation: '/-/rsc/artifact',
      authentication: { scheme: 'test', keyId: 'fixture', signature: 'valid' },
    };
    const application = {
      listRegistryTopics: vi.fn(async () => topics),
      getRegistryTopic: vi.fn(async (topic: string) => ({
        hasData: true,
        payload: topic.endsWith('/good') ? good : { invalid: true },
      })),
    };
    const snapshot = await readHileRscDiscoverySnapshot(application);
    expect(snapshot.announcements).toEqual([good]);
    expect(snapshot.rejected).toEqual([
      expect.objectContaining({ topic: '@hile/rsc/discovery/v1/bad', error: expect.any(TypeError) }),
    ]);
    expect(application.getRegistryTopic).toHaveBeenCalledTimes(2);
  });

  it('reads topics with bounded concurrency while preserving topic order', async () => {
    const topicNames = ['delta', 'alpha', 'charlie', 'bravo'];
    let active = 0;
    let maximumActive = 0;
    const application = {
      listRegistryTopics: vi.fn(async () => topicNames.map((name) => ({
        topic: `@hile/rsc/discovery/v1/${name}`,
        hasData: true,
      }))),
      getRegistryTopic: vi.fn(async (topic: string) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        const instanceId = topic.split('/').at(-1)!;
        return {
          hasData: true,
          payload: {
            schemaVersion: 1, capability: '@hile/rsc', instanceId,
            pluginId: `org.hile.${instanceId}`, buildId: 'build-1', namespace: instanceId,
            priority: 1, protocolVersion: 1,
            runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
            artifactOperation: '/-/rsc/artifact',
            authentication: { scheme: 'test', keyId: 'fixture', signature: 'valid' },
          },
        };
      }),
    };

    const snapshot = await readHileRscDiscoverySnapshot(application, { concurrency: 2 });

    expect(maximumActive).toBe(2);
    expect(snapshot.announcements.map(({ instanceId }) => instanceId))
      .toEqual(['alpha', 'bravo', 'charlie', 'delta']);
  });

  it('forwards one abort signal to Registry listing and topic reads', async () => {
    const controller = new AbortController();
    const application = {
      listRegistryTopics: vi.fn(async (_prefix?: string, _options?: { signal?: AbortSignal }) => [{
        topic: '@hile/rsc/discovery/v1/fixture', hasData: true,
      }]),
      getRegistryTopic: vi.fn(async (_topic: string, _options?: { signal?: AbortSignal }) => ({
        hasData: true,
        payload: {
          schemaVersion: 1, capability: '@hile/rsc', instanceId: 'fixture',
          pluginId: 'org.hile.fixture', buildId: 'build-1', namespace: 'fixture',
          priority: 1, protocolVersion: 1,
          runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
          artifactOperation: '/-/rsc/artifact',
          authentication: { scheme: 'test', keyId: 'fixture', signature: 'valid' },
        },
      })),
    };
    await readHileRscDiscoverySnapshot(application, { signal: controller.signal });
    expect(application.listRegistryTopics).toHaveBeenCalledWith(
      '@hile/rsc/discovery/v1/', { signal: controller.signal },
    );
    expect(application.getRegistryTopic).toHaveBeenCalledWith(
      '@hile/rsc/discovery/v1/fixture', { signal: controller.signal },
    );
  });

  it('downloads message-streamed files into a verified isolated artifact', async () => {
    const value = await artifact();
    const application = {
      stream: vi.fn(async (_namespace: string, _operation: string, data: any) => {
        if (data.path === 'plugin.json') {
          return Readable.from([Buffer.from(JSON.stringify(value.manifest))]);
        }
        expect(data.path).toBe(value.manifest.server.entry);
        return Readable.from([value.server.subarray(0, 5), value.server.subarray(5)]);
      }),
    };
    const announcement = {
      schemaVersion: 1 as const, capability: '@hile/rsc' as const, instanceId: 'fixture',
      pluginId: value.manifest.pluginId, buildId: value.manifest.buildId, namespace: 'fixture.service',
      priority: 1, protocolVersion: 1 as const, runtime: value.manifest.runtime,
      artifactOperation: '/-/rsc/artifact',
      authentication: { scheme: 'test', keyId: 'fixture', signature: 'valid' },
    };
    const downloaded = await downloadHileRscArtifact(application, announcement, {
      runtime: value.manifest.runtime,
    });
    temporaryDirectories.push(downloaded.artifactRoot);
    expect(await readFile(path.join(downloaded.artifactRoot, value.manifest.server.entry)))
      .toEqual(value.server);
    expect(downloaded.manifest).toEqual(value.manifest);
  });

  it('rejects identity mismatches and bounded-stream overflow without leaving a usable artifact', async () => {
    const value = await artifact();
    const announcement = {
      schemaVersion: 1 as const, capability: '@hile/rsc' as const, instanceId: 'fixture',
      pluginId: value.manifest.pluginId, buildId: value.manifest.buildId, namespace: 'fixture.service',
      priority: 1, protocolVersion: 1 as const, runtime: value.manifest.runtime,
      artifactOperation: '/-/rsc/artifact',
      authentication: { scheme: 'test', keyId: 'fixture', signature: 'valid' },
    };
    await expect(downloadHileRscArtifact({
      stream: vi.fn(async () => Readable.from([
        Buffer.from(JSON.stringify({ ...value.manifest, buildId: 'other' })),
      ])),
    }, announcement, { runtime: value.manifest.runtime })).rejects.toThrow('identity mismatch');

    await expect(downloadHileRscArtifact({
      stream: vi.fn(async (_namespace: string, _operation: string, data: any) =>
        Readable.from([data.path === 'plugin.json'
          ? Buffer.from(JSON.stringify(value.manifest))
          : Buffer.alloc(20)])),
    }, announcement, { runtime: value.manifest.runtime, maxFileBytes: 10 })).rejects.toThrow('size limit');

    await expect(downloadHileRscArtifact({
      stream: vi.fn(async () => Readable.from([
        Buffer.from(JSON.stringify(value.manifest)),
      ])),
    }, announcement, {
      runtime: value.manifest.runtime,
      maxManifestBytes: 10,
    })).rejects.toThrow('manifest size limit');
  });
});
