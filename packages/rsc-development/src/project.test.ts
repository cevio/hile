import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyRscDevelopmentChange,
  createRscDevelopmentProject,
} from './project';

const fixtureDir = path.resolve(import.meta.dirname, '../../rsc-build/fixtures/plugin-basic');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-project-'));
  roots.push(root);
  const cwd = path.join(root, 'source');
  const outdir = path.join(root, 'output');
  const stateFile = path.join(root, 'state.json');
  const configFile = path.join(cwd, 'hile-rsc.json');
  await cp(fixtureDir, cwd, { recursive: true });
  let buildId = 'build-a';
  let displayName = 'Basic plugin';
  let navigationPath = '/basic';
  const loadConfig = vi.fn(async () => ({
    pluginId: 'com.example.basic',
    buildId,
    cwd,
    entry: 'src/page.tsx',
    outdir,
    routes: [{ path: '/basic', entry: 'default' }],
    metadata: {
      displayName,
      navigation: [{ id: 'basic', label: displayName, path: navigationPath }],
    },
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
  }));
  await writeFile(configFile, '{}');
  return {
    root,
    cwd,
    outdir,
    stateFile,
    configFile,
    loadConfig,
    setBuildId(value: string) { buildId = value; },
    setDisplayName(value: string) { displayName = value; },
    setNavigationPath(value: string) { navigationPath = value; },
  };
}

describe('RSC development project', () => {
  it('classifies source, model, config and generated changes independently', async () => {
    const value = await setup();
    const roots = { cwd: value.cwd, configFile: value.configFile, stateFile: value.stateFile, outdir: value.outdir };
    expect(classifyRscDevelopmentChange(value.configFile, roots)).toBe('config');
    expect(classifyRscDevelopmentChange(path.join(value.cwd, 'src/models/a.model.ts'), roots)).toBe('model');
    expect(classifyRscDevelopmentChange(path.join(value.cwd, 'src/page.tsx'), roots)).toBe('source');
    expect(classifyRscDevelopmentChange(path.join(value.outdir, 'revisions/r1/plugin.json'), roots)).toBe('generated');
  });

  it('publishes initial state, performs warm source rebuilds and preserves revision order across config reload', async () => {
    const value = await setup();
    const revisions: number[] = [];
    const project = await createRscDevelopmentProject({
      configFile: value.configFile,
      stateFile: value.stateFile,
      outdir: value.outdir,
      namespace: 'fixture.dev',
      sessionId: 'project-test',
      loadConfig: value.loadConfig,
      onRevision: (revision) => { revisions.push(revision.revision); },
    });

    expect(project.current().revision).toBe(1);
    expect(JSON.parse(await readFile(value.stateFile, 'utf8')).revisions[0])
      .toMatchObject({ namespace: 'fixture.dev', revision: 1 });
    await writeFile(path.join(value.cwd, 'src/helper.ts'), "export const helperText = 'project-warm';\n");
    await vi.waitFor(() => expect(project.current().revision).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    expect(project.current().contexts).toEqual({ server: 'reused', browser: 'reused', ssr: 'reused' });

    value.setBuildId('build-b');
    value.setDisplayName('Basic plugin v2');
    const configured = await project.reloadConfig();
    expect(configured.revision).toBeGreaterThanOrEqual(3);
    expect(configured.manifest.buildId).toContain('build-b-dev-project-test');
    expect(configured.manifest.metadata?.displayName).toBe('Basic plugin v2');
    expect(revisions.at(-1)).toBe(configured.revision);
    await project.dispose();
  }, 20_000);

  it('keeps the successful compiler active when reconfiguration is incompatible', async () => {
    const value = await setup();
    let incompatible = false;
    const project = await createRscDevelopmentProject({
      configFile: value.configFile,
      stateFile: value.stateFile,
      outdir: value.outdir,
      namespace: 'fixture.dev',
      sessionId: 'project-compatible',
      loadConfig: async () => ({
        ...await value.loadConfig(),
        pluginId: incompatible ? 'com.example.other' : 'com.example.basic',
      }),
    });
    incompatible = true;
    await expect(project.reloadConfig()).rejects.toThrow('pluginId cannot change');
    incompatible = false;
    await expect(project.rebuild()).resolves.toMatchObject({ revision: 2 });
    await project.dispose();
  });

  it('keeps the last successful revision when reconfigured metadata is invalid', async () => {
    const value = await setup();
    const project = await createRscDevelopmentProject({
      configFile: value.configFile,
      stateFile: value.stateFile,
      outdir: value.outdir,
      namespace: 'fixture.dev',
      sessionId: 'project-invalid-metadata',
      loadConfig: value.loadConfig,
    });
    const successful = project.current();

    value.setNavigationPath('/missing');
    await expect(project.reloadConfig())
      .rejects.toMatchObject({ code: 'ERR_RSC_INVALID_METADATA' });
    expect(project.current()).toBe(successful);

    value.setNavigationPath('/basic');
    await expect(project.rebuild()).resolves.toMatchObject({ revision: 2 });
    await project.dispose();
  });

  it('coalesces duplicate watcher events, does not spin on a failed fingerprint, and recovers on the next edit', async () => {
    const value = await setup();
    const errors: unknown[] = [];
    const revisions: number[] = [];
    const project = await createRscDevelopmentProject({
      configFile: value.configFile,
      stateFile: value.stateFile,
      outdir: value.outdir,
      namespace: 'fixture.dev',
      sessionId: 'project-recovery',
      debounceMs: 25,
      pollMs: 50,
      loadConfig: value.loadConfig,
      onError: (error) => { errors.push(error); },
      onRevision: ({ revision }) => { revisions.push(revision); },
    });
    const helper = path.join(value.cwd, 'src/helper.ts');
    await writeFile(helper, 'export const helperText = ;\n');
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settledErrorCount = errors.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors).toHaveLength(settledErrorCount);
    expect(project.current().revision).toBe(1);

    await writeFile(helper, "export const helperText = 'recovered';\n");
    await vi.waitFor(() => expect(project.current().revision).toBe(2), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(revisions).toEqual([1, 2]);
    await project.dispose();
  }, 20_000);

  it('rebuilds after a failed edit is restored exactly to the last successful source', async () => {
    const value = await setup();
    const errors: unknown[] = [];
    const project = await createRscDevelopmentProject({
      configFile: value.configFile,
      stateFile: value.stateFile,
      outdir: value.outdir,
      namespace: 'fixture.dev',
      sessionId: 'project-exact-restore',
      debounceMs: 25,
      pollMs: 50,
      loadConfig: value.loadConfig,
      onError: (error) => { errors.push(error); },
    });
    const page = path.join(value.cwd, 'src/page.tsx');
    const original = await readFile(page, 'utf8');
    await writeFile(page, `${original}\nconst broken = ;\n`);
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });

    await writeFile(page, original);
    await vi.waitFor(() => expect(project.current().revision).toBe(2), { timeout: 5_000 });
    await project.dispose();
  }, 20_000);
});
