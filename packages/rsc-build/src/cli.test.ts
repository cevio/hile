import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRscCli } from './cli';

const fixture = path.resolve(import.meta.dirname, '../fixtures/plugin-basic');
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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

  it('builds from hile-rsc.json with the supported runtime when common options are omitted', async () => {
    const { root, config, artifact } = await configFile();
    const value = JSON.parse(await readFile(config, 'utf8'));
    delete value.runtime;
    await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
    const sink = output();
    await expect(runRscCli(['build'], sink.io, root)).resolves.toBe(0);
    expect(JSON.parse(sink.read().stdout)).toMatchObject({
      command: 'build', pluginId: 'org.hile.fixture', buildId: 'build-a', artifact,
    });
  });

  it('auto-resolves buildId and output directory when buildId is omitted', async () => {
    vi.stubEnv('RSC_BUILD_ID', '');
    const { root, config } = await configFile();
    const baseConfig = JSON.parse(await readFile(config, 'utf8'));
    baseConfig.buildId = '';
    baseConfig.outdir = '.hile-rsc';
    await writeFile(config, `${JSON.stringify(baseConfig, null, 2)}\n`);
    const sink = output();
    await expect(runRscCli(['build', '--config', config], sink.io)).resolves.toBe(0);
    const value = JSON.parse(sink.read().stdout);
    expect(value).toMatchObject({
      command: 'build',
      pluginId: 'org.hile.fixture',
    });
    expect(value.buildId).toMatch(/^build-/);
    expect(value.artifact).toMatch(new RegExp(`${value.buildId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`));
    const inspect = output();
    expect(await runRscCli(['inspect', path.join(root, '.hile-rsc')], inspect.io)).toBe(0);
    expect(JSON.parse(inspect.read().stdout).buildId).toBe(value.buildId);
  });

  it('preserves an explicit buildId and outdir when RSC_BUILD_ID is set', async () => {
    vi.stubEnv('RSC_BUILD_ID', 'build-from-environment');
    const { config, artifact } = await configFile();
    const sink = output();
    expect(await runRscCli(['build', '--config', config], sink.io)).toBe(0);
    expect(JSON.parse(sink.read().stdout)).toMatchObject({ buildId: 'build-a', artifact });
  });

  it('defaults outdir from an explicit buildId when only outdir is omitted', async () => {
    const { config, artifact } = await configFile();
    const value = JSON.parse(await readFile(config, 'utf8'));
    delete value.outdir;
    await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
    const sink = output();
    expect(await runRscCli(['build', '--config', config], sink.io)).toBe(0);
    expect(JSON.parse(sink.read().stdout)).toMatchObject({ buildId: 'build-a', artifact });
  });

  it('rejects a non-string optional outdir instead of silently using the default', async () => {
    const { config } = await configFile();
    const value = JSON.parse(await readFile(config, 'utf8'));
    value.outdir = 42;
    await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
    const sink = output();
    expect(await runRscCli(['build', '--config', config], sink.io)).toBe(1);
    expect(sink.read().stderr).toContain('RSC outdir must be a string');
  });

  it('rejects a non-string optional buildId at the config boundary', async () => {
    const { config } = await configFile();
    const value = JSON.parse(await readFile(config, 'utf8'));
    value.buildId = 42;
    await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
    const sink = output();

    expect(await runRscCli(['build', '--config', config], sink.io)).toBe(1);
    expect(sink.read().stderr).toContain('RSC buildId must be a string');
  });

  it('trims an explicit buildId before returning the loaded config', async () => {
    const { config, artifact } = await configFile();
    const value = JSON.parse(await readFile(config, 'utf8'));
    value.buildId = '  build-a  ';
    await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
    const sink = output();

    expect(await runRscCli(['build', '--config', config], sink.io)).toBe(0);
    expect(JSON.parse(sink.read().stdout)).toMatchObject({ buildId: 'build-a', artifact });
  });

  it('rejects a null runtime instead of treating it as omitted', async () => {
    const { config } = await configFile();
    const value = JSON.parse(await readFile(config, 'utf8'));
    value.runtime = null;
    await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
    const sink = output();
    expect(await runRscCli(['build', '--config', config], sink.io)).toBe(1);
    expect(sink.read().stderr).toContain('RSC runtime must be an object');
  });

  it('rejects invalid build-scoped style configuration', async () => {
    const { config } = await configFile();
    const value = JSON.parse(await readFile(config, 'utf8'));
    value.styles = ['src/counter.css', '  '];
    await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
    const sink = output();

    expect(await runRscCli(['build', '--config', config], sink.io)).toBe(1);
    expect(sink.read().stderr).toContain('RSC styles must be an array of non-empty strings');
  });

  it('uses RSC_BUILD_ID when buildId is omitted', async () => {
    vi.stubEnv('RSC_BUILD_ID', 'release-42');
    const { root, config } = await configFile();
    const value = JSON.parse(await readFile(config, 'utf8'));
    delete value.buildId;
    value.outdir = '.hile-rsc';
    await writeFile(config, `${JSON.stringify(value, null, 2)}\n`);
    const sink = output();
    expect(await runRscCli(['build', '--config', config], sink.io)).toBe(0);
    expect(JSON.parse(sink.read().stdout)).toMatchObject({
      buildId: 'release-42',
      artifact: path.join(root, '.hile-rsc/release-42'),
    });
    vi.stubEnv('RSC_BUILD_ID', '');
    const inspect = output();
    expect(await runRscCli(['inspect', path.join(root, '.hile-rsc')], inspect.io)).toBe(0);
    expect(JSON.parse(inspect.read().stdout).buildId).toBe('release-42');
  });

  it('ignores incomplete and invalid directories when resolving a build root', async () => {
    const { root, config } = await configFile();
    await runRscCli(['build', '--config', config], output().io);
    const buildRoot = path.join(root, '.hile-rsc');
    await mkdir(path.join(buildRoot, 'build-in-progress'));
    await mkdir(path.join(buildRoot, 'newer-invalid'));
    await writeFile(path.join(buildRoot, 'newer-invalid/plugin.json'), '{ invalid json');
    const staging = path.join(buildRoot, '.build-a.tmp-staging');
    await cp(path.join(buildRoot, 'build-a'), staging, { recursive: true });
    await rm(path.join(staging, 'server-rsc/index.js'));
    const future = new Date(Date.now() + 60_000);
    await utimes(path.join(staging, 'plugin.json'), future, future);
    const inspect = output();
    expect(await runRscCli(['inspect', buildRoot], inspect.io)).toBe(0);
    expect(JSON.parse(inspect.read().stdout).buildId).toBe('build-a');
    const verify = output();
    expect(await runRscCli([
      'verify', buildRoot,
      '--react', '19.2.8', '--react-dom', '19.2.8', '--rsc', '19.2.8',
    ], verify.io)).toBe(0);
  });

  it('inspects and verifies an artifact without loading its modules', async () => {
    const { root, config } = await configFile();
    await runRscCli(['build', '--config', config], output().io);
    const buildRoot = path.join(root, '.hile-rsc');

    const inspect = output();
    expect(await runRscCli(['inspect', buildRoot], inspect.io)).toBe(0);
    expect(JSON.parse(inspect.read().stdout)).toMatchObject({
      command: 'inspect', pluginId: 'org.hile.fixture', buildId: 'build-a',
      metadata: {
        displayName: 'Fixture plugin',
        navigation: [{ id: 'fixture', label: 'Fixture', path: '/fixture' }],
      },
    });

    const verify = output();
    expect(await runRscCli([
      'verify', buildRoot,
      '--react', '19.2.8', '--react-dom', '19.2.8', '--rsc', '19.2.8',
    ], verify.io)).toBe(0);
    expect(JSON.parse(verify.read().stdout)).toMatchObject({
      command: 'verify', valid: true, files: expect.any(Number),
      metadata: { displayName: 'Fixture plugin' },
    });
  });

  it('keeps an explicit plugin.json input direct when RSC_BUILD_ID is set', async () => {
    const { config, artifact } = await configFile();
    await runRscCli(['build', '--config', config], output().io);
    vi.stubEnv('RSC_BUILD_ID', 'other-build');
    const manifestPath = path.join(artifact, 'plugin.json');

    const inspect = output();
    expect(await runRscCli(['inspect', manifestPath], inspect.io)).toBe(0);
    expect(JSON.parse(inspect.read().stdout).buildId).toBe('build-a');

    const verify = output();
    expect(await runRscCli(['verify', manifestPath], verify.io)).toBe(0);
    expect(JSON.parse(verify.read().stdout).buildId).toBe('build-a');
  });

  it('inspects and verifies .hile-rsc with the supported runtime when the artifact is omitted', async () => {
    const { root, config } = await configFile();
    await runRscCli(['build', '--config', config], output().io);

    const inspect = output();
    expect(await runRscCli(['inspect'], inspect.io, root)).toBe(0);
    expect(JSON.parse(inspect.read().stdout)).toMatchObject({
      command: 'inspect', pluginId: 'org.hile.fixture', buildId: 'build-a',
    });

    const verify = output();
    expect(await runRscCli(['verify'], verify.io, root)).toBe(0);
    expect(JSON.parse(verify.read().stdout)).toMatchObject({
      command: 'verify', valid: true, pluginId: 'org.hile.fixture', buildId: 'build-a',
    });
  });

  it.each([
    [],
    ['unknown'],
    ['verify', '/tmp/missing', '--react', '19.2.8'],
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
