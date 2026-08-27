import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RscDevelopmentRevisionRecord } from './state';
import type { BuildRscPluginOptions } from '@hile/rsc-build';
import {
  createRscDevelopmentCompiler,
  type RscDevelopmentCompiler,
  type RscDevelopmentRevision,
} from './compiler';

export type RscDevelopmentChangeKind = 'config' | 'model' | 'generated' | 'source';

export interface RscDevelopmentChangeRoots {
  cwd: string;
  configFile: string;
  stateFile: string;
  outdir: string;
  modelDirectories?: readonly string[];
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function classifyRscDevelopmentChange(
  file: string,
  roots: RscDevelopmentChangeRoots,
): RscDevelopmentChangeKind {
  const target = path.resolve(file);
  if (target === path.resolve(roots.configFile)) return 'config';
  if (target === path.resolve(roots.stateFile) || isInside(roots.outdir, target)) return 'generated';
  if (target.split(path.sep).some((segment) => segment === '.git' || segment === 'node_modules' || segment === '.hile-rsc')) {
    return 'generated';
  }
  const modelDirectories = roots.modelDirectories ?? [path.join(roots.cwd, 'src/models')];
  if (modelDirectories.some((directory) => isInside(directory, target))) return 'model';
  return 'source';
}

export interface RscDevelopmentProjectOptions {
  configFile: string;
  stateFile: string;
  outdir: string;
  namespace: string;
  sessionId?: string;
  debounceMs?: number;
  pollMs?: number;
  loadConfig(): Promise<Omit<BuildRscPluginOptions, 'buildId'> & { buildId?: string }>;
  writeRevision?: (record: RscDevelopmentRevisionRecord) => void | Promise<void>;
  onRevision?: (revision: RscDevelopmentRevision) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface RscDevelopmentProject {
  current(): RscDevelopmentRevision;
  rebuild(): Promise<RscDevelopmentRevision>;
  reloadConfig(): Promise<RscDevelopmentRevision>;
  dispose(): Promise<void>;
}

async function scanSource(
  cwd: string,
  roots: RscDevelopmentChangeRoots,
): Promise<string> {
  const values: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const kind = classifyRscDevelopmentChange(absolute, roots);
      if (kind === 'model' || kind === 'generated' || kind === 'config') continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const metadata = await stat(absolute, { bigint: true });
        values.push(`${path.relative(cwd, absolute)}\0${metadata.size}\0${metadata.mtimeNs}`);
      }
    }
  };
  await visit(cwd);
  return values.sort().join('\n');
}

async function writeState(file: string, record: RscDevelopmentRevisionRecord): Promise<void> {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ revisions: [record] }, null, 2)}\n`);
  await rename(temporary, absolute);
}

function assertStableRuntime(previous: BuildRscPluginOptions | undefined, next: BuildRscPluginOptions): void {
  if (!previous) return;
  if (previous.pluginId !== next.pluginId) {
    throw new Error('RSC development config pluginId cannot change without restarting the plugin topology');
  }
  for (const key of ['react', 'reactDom', 'rsc'] as const) {
    if (previous.runtime[key] !== next.runtime[key]) {
      throw new Error(`RSC development config runtime ${key} cannot change without restarting the plugin topology`);
    }
  }
}

export async function createRscDevelopmentProject(
  options: RscDevelopmentProjectOptions,
): Promise<RscDevelopmentProject> {
  const configFile = path.resolve(options.configFile);
  const stateFile = path.resolve(options.stateFile);
  const developmentOutdir = path.resolve(options.outdir);
  const sessionId = options.sessionId ?? `project-${process.pid}`;
  let compiler: RscDevelopmentCompiler | undefined;
  let config: BuildRscPluginOptions | undefined;
  let latest: RscDevelopmentRevision | undefined;
  let sourceWatcher: FSWatcher | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let observedRoots: RscDevelopmentChangeRoots | undefined;
  let sourceFingerprint = '';
  let attemptedSourceFingerprint = '';
  let configFingerprint = '';
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: 'source' | 'config' | undefined;
  let drainingScheduled = false;
  let scheduledDrainPromise: Promise<void> | undefined;
  let disposed = false;
  let queue = Promise.resolve<RscDevelopmentRevision | undefined>(undefined);

  const publish = async (revision: RscDevelopmentRevision) => {
    const record = {
      pluginId: revision.manifest.pluginId,
      buildId: revision.manifest.buildId,
      namespace: options.namespace,
      revision: revision.revision,
      artifactRoot: revision.artifactRoot,
    };
    if (options.writeRevision) await options.writeRevision(record);
    else await writeState(stateFile, record);
  };

  const notify = async (revision: RscDevelopmentRevision) => {
    try {
      await options.onRevision?.(revision);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const watchSource = async (next: BuildRscPluginOptions) => {
    const cwd = path.resolve(next.cwd);
    const roots = { cwd, configFile, stateFile, outdir: developmentOutdir };
    const nextSourceFingerprint = await scanSource(cwd, roots);
    const nextConfigFingerprint = await readFile(configFile, 'utf8');
    const nextWatcher = watch(cwd, { recursive: true }, (_event, changed) => {
      const target = changed ? path.resolve(cwd, changed.toString()) : cwd;
      const kind = classifyRscDevelopmentChange(target, roots);
      if (kind === 'model' || kind === 'generated') return;
      schedule(kind === 'config' ? 'config' : 'source');
    });
    sourceWatcher?.close();
    sourceWatcher = nextWatcher;
    observedRoots = roots;
    sourceFingerprint = nextSourceFingerprint;
    attemptedSourceFingerprint = nextSourceFingerprint;
    configFingerprint = nextConfigFingerprint;
  };

  const configure = async (): Promise<RscDevelopmentRevision> => {
    const loadedConfig = await options.loadConfig();
    const loaded: BuildRscPluginOptions = {
      ...loadedConfig,
      buildId: loadedConfig.buildId?.trim() || 'development',
    };
    assertStableRuntime(config, loaded);
    const nextCompiler = await createRscDevelopmentCompiler({
      ...loaded,
      outdir: developmentOutdir,
      sessionId,
      initialRevision: latest?.revision ?? 0,
    });
    let revision: RscDevelopmentRevision;
    try {
      revision = await nextCompiler.rebuild();
      await watchSource(loaded);
    } catch (error) {
      await nextCompiler.dispose();
      throw error;
    }
    const previousCompiler = compiler;
    compiler = nextCompiler;
    config = loaded;
    latest = revision;
    try {
      await publish(revision);
      await notify(revision);
      return revision;
    } finally {
      await previousCompiler?.dispose();
    }
  };

  const rebuild = async (): Promise<RscDevelopmentRevision> => {
    if (!compiler) return configure();
    const revision = await compiler.rebuild();
    await publish(revision);
    latest = revision;
    if (observedRoots) sourceFingerprint = await scanSource(observedRoots.cwd, observedRoots);
    attemptedSourceFingerprint = sourceFingerprint;
    await notify(revision);
    return revision;
  };

  const enqueue = (operation: 'source' | 'config') => {
    if (disposed) return Promise.reject(new Error('RSC development project is disposed'));
    const execute = () => operation === 'config' ? configure() : rebuild();
    const result = queue.then(execute, execute);
    queue = result;
    return result;
  };

  const drainScheduled = async () => {
    if (drainingScheduled) return;
    drainingScheduled = true;
    try {
      while (!disposed && pending) {
        const next = pending;
        pending = undefined;
        if (next === 'source' && observedRoots) {
          const fingerprint = await scanSource(observedRoots.cwd, observedRoots);
          if (fingerprint === sourceFingerprint || fingerprint === attemptedSourceFingerprint) continue;
          attemptedSourceFingerprint = fingerprint;
        }
        try { await enqueue(next); } catch (error) { options.onError?.(error); }
      }
    } finally {
      drainingScheduled = false;
      if (!disposed && pending && !scheduledDrainPromise) triggerScheduledDrain();
    }
  };

  function triggerScheduledDrain() {
    if (scheduledDrainPromise || disposed) return;
    const operation = drainScheduled();
    const tracked = operation.finally(() => {
      if (scheduledDrainPromise === tracked) scheduledDrainPromise = undefined;
      if (!disposed && pending) triggerScheduledDrain();
    });
    scheduledDrainPromise = tracked;
    void scheduledDrainPromise.catch((error) => options.onError?.(error));
  }

  function schedule(operation: 'source' | 'config') {
    if (disposed) return;
    if (operation === 'config' || !pending) pending = operation;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      triggerScheduledDrain();
    }, options.debounceMs ?? 75);
  }

  // Establish the baseline before attaching the directory watcher; otherwise
  // a delayed event for the pre-start config write can race initial configure.
  configFingerprint = await readFile(configFile, 'utf8');
  const configWatcher = watch(path.dirname(configFile), (_event, changed) => {
    // Some platforms report an undefined filename for unrelated directory
    // changes. The content poller is the reliable fallback for that case;
    // treating it as a config edit would throw away warm esbuild contexts.
    if (!changed || changed.toString() !== path.basename(configFile)) return;
    // fs.watch can deliver a stale event for the config write that happened
    // before this watcher was attached. Compare content so that event cannot
    // discard warm compiler contexts or outrank a real source rebuild.
    void readFile(configFile, 'utf8').then((nextConfigFingerprint) => {
      if (nextConfigFingerprint === configFingerprint) return;
      configFingerprint = nextConfigFingerprint;
      schedule('config');
    }).catch((error) => options.onError?.(error));
  });
  const pollMs = options.pollMs ?? 250;
  if (!Number.isFinite(pollMs) || pollMs < 25) {
    configWatcher.close();
    throw new TypeError('RSC development pollMs must be at least 25');
  }
  poller = setInterval(async () => {
    if (disposed || polling || !observedRoots) return;
    polling = true;
    try {
      const nextConfigFingerprint = await readFile(configFile, 'utf8');
      if (nextConfigFingerprint !== configFingerprint) {
        configFingerprint = nextConfigFingerprint;
        schedule('config');
      } else {
        const nextSourceFingerprint = await scanSource(observedRoots.cwd, observedRoots);
        if (nextSourceFingerprint !== sourceFingerprint) {
          schedule('source');
        }
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      polling = false;
    }
  }, pollMs);
  poller.unref?.();

  try {
    await enqueue('config');
  } catch (error) {
    configWatcher.close();
    sourceWatcher?.close();
    if (poller) clearInterval(poller);
    await compiler?.dispose();
    throw error;
  }

  return {
    current() {
      if (!latest) throw new Error('RSC development project has no successful revision');
      return latest;
    },
    rebuild: () => enqueue('source') as Promise<RscDevelopmentRevision>,
    reloadConfig: () => enqueue('config') as Promise<RscDevelopmentRevision>,
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      pending = undefined;
      configWatcher.close();
      sourceWatcher?.close();
      if (poller) clearInterval(poller);
      await scheduledDrainPromise?.catch(() => undefined);
      await queue.catch(() => undefined);
      await compiler?.dispose();
    },
  };
}
