import { describe, expect, it } from 'vitest';
import { resolveHileRscPluginIdentity } from './identity';

describe('resolveHileRscPluginIdentity', () => {
  it('derives distinct production routing and publisher identities for immutable builds', () => {
    const first = resolveHileRscPluginIdentity({
      pluginId: 'org.example.plugin', buildId: 'build-a', development: false,
    });
    const second = resolveHileRscPluginIdentity({
      pluginId: 'org.example.plugin', buildId: 'build-b', development: false,
    });

    expect(first).toEqual({
      namespace: 'org.example.plugin.build-a',
      instanceId: 'org.example.plugin.build-a',
    });
    expect(second.namespace).not.toBe(first.namespace);
    expect(second.instanceId).not.toBe(first.instanceId);
  });

  it('preserves explicit production routing and publisher identities', () => {
    expect(resolveHileRscPluginIdentity({
      pluginId: 'org.example.plugin',
      buildId: 'build-a',
      development: false,
      namespace: ' deployment.route ',
      instanceId: ' deployment.publisher ',
    })).toEqual({
      namespace: 'deployment.route',
      instanceId: 'deployment.publisher',
    });
  });

  it('keeps one development identity stable across incremental builds', () => {
    const first = resolveHileRscPluginIdentity({
      pluginId: 'org.example.plugin',
      buildId: 'revision-a',
      development: true,
      namespace: 'org.example.plugin.dev',
      instanceId: 'org.example.plugin.dev',
    });
    const second = resolveHileRscPluginIdentity({
      pluginId: 'org.example.plugin',
      buildId: 'revision-b',
      development: true,
      namespace: 'org.example.plugin.dev',
      instanceId: 'org.example.plugin.dev',
    });

    expect(second).toEqual(first);
    expect(() => resolveHileRscPluginIdentity({
      pluginId: 'org.example.plugin', buildId: 'revision-c', development: true,
    })).toThrow('development namespace must not be empty');
  });
});
