import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRscCli } from './cli';

const fixture = path.resolve(import.meta.dirname, '../fixtures/plugin-basic');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function output() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (value: string) => { stdout += value; },
      stderr: (value: string) => { stderr += value; },
    },
    read: () => ({ stdout, stderr }),
  };
}

async function configFile() {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-cli-'));
  roots.push(root);
  const config = path.join(root, 'hile-rsc.json');
  await writeFile(config, JSON.stringify({
    pluginId: 'org.hile.fixture',
    buildId: 'build-a',
    cwd: fixture,
    entry: 'src/page.tsx',
    outdir: '.hile-rsc/build-a',
    routes: [{ path: '/fixture', entry: 'default' }],
    metadata: {
      displayName: 'Fixture plugin',
      navigation: [{ id: 'fixture', label: 'Fixture', path: '/fixture' }],
    },
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
  }));
  return { root, config, artifact: path.join(root, '.hile-rsc/build-a') };
}

describe('hile-rsc CLI', () => {
  it.each([
    { args: ['--help'] },
    { args: ['-h'] },
    { args: ['help'] },
  ])('prints usage successfully for $args', async ({ args }) => {
    const sink = output();
    expect(await runRscCli(args, sink.io)).toBe(0);
    expect(sink.read()).toMatchObject({
      stdout: expect.stringContaining('Usage:'),
      stderr: '',
    });
  });

  it('builds from an explicit config with paths relative to the config file', async () => {
    const { config, artifact } = await configFile();
    const sink = output();
    await expect(runRscCli(['build', '--config', config], sink.io)).resolves.toBe(0);
    expect(JSON.parse(sink.read().stdout)).toMatchObject({
      command: 'build', pluginId: 'org.hile.fixture', buildId: 'build-a', artifact,
    });
  });

  it('inspects and verifies an artifact without loading its modules', async () => {
    const { config, artifact } = await configFile();
    await runRscCli(['build', '--config', config], output().io);

    const inspect = output();
    expect(await runRscCli(['inspect', artifact], inspect.io)).toBe(0);
    expect(JSON.parse(inspect.read().stdout)).toMatchObject({
      command: 'inspect', pluginId: 'org.hile.fixture', buildId: 'build-a',
      metadata: {
        displayName: 'Fixture plugin',
        navigation: [{ id: 'fixture', label: 'Fixture', path: '/fixture' }],
      },
    });

    const verify = output();
    expect(await runRscCli([
      'verify', artifact,
      '--react', '19.2.8', '--react-dom', '19.2.8', '--rsc', '19.2.8',
    ], verify.io)).toBe(0);
    expect(JSON.parse(verify.read().stdout)).toMatchObject({
      command: 'verify', valid: true, files: expect.any(Number),
      metadata: { displayName: 'Fixture plugin' },
    });
  });

  it.each([
    [],
    ['unknown'],
    ['build'],
    ['inspect'],
    ['verify', '/tmp/missing'],
    ['build', '--config', '/tmp/config.json', '--unknown', 'value'],
    ['verify', '/tmp/missing', '--react', '19.2.8', '--react', '19.2.8', '--rsc', '19.2.8'],
    ['verify', '/tmp/missing', '--react', '19.2.8', '--react-dom', '19.2.8', '--rsc', '19.2.8', 'extra'],
  ].map((args) => [args]))('returns a usage error for invalid arguments %j', async (args) => {
    const sink = output();
    expect(await runRscCli(args, sink.io)).toBe(2);
    expect(sink.read().stderr).toContain('Usage:');
  });

  it('returns an operational failure without swallowing its cause', async () => {
    const { artifact } = await configFile();
    const sink = output();
    expect(await runRscCli(['inspect', artifact], sink.io)).toBe(1);
    expect(sink.read().stderr).toContain('ENOENT');
  });
});
