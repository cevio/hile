import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface RscDevelopmentRevisionRecord {
  pluginId: string;
  buildId: string;
  namespace: string;
  revision: number;
  artifactRoot: string;
  /** Whether the first revision for this namespace should become active. */
  active?: boolean;
}

export interface RscDevelopmentState {
  revisions: RscDevelopmentRevisionRecord[];
}

function parseRscDevelopmentState(file: string, source: string): RscDevelopmentState {
  const value = JSON.parse(source) as Partial<RscDevelopmentState>;
  if (!Array.isArray(value.revisions)) throw new TypeError('RSC development state revisions must be an array');
  const keys = new Set<string>();
  const revisions = value.revisions.map((item) => {
    if (!item || typeof item !== 'object') throw new TypeError('RSC development revision must be an object');
    const record = item as Partial<RscDevelopmentRevisionRecord>;
    if (!record.pluginId || !record.buildId || !record.namespace || !record.artifactRoot) {
      throw new TypeError('RSC development revision identities and artifactRoot are required');
    }
    if (!Number.isSafeInteger(record.revision) || record.revision! < 1) {
      throw new TypeError('RSC development revision must be a positive safe integer');
    }
    if (record.active !== undefined && typeof record.active !== 'boolean') {
      throw new TypeError('RSC development revision active must be boolean');
    }
    const key = `${record.pluginId}\0${record.namespace}`;
    if (keys.has(key)) throw new TypeError(`Duplicate RSC development revision: ${record.pluginId}@${record.namespace}`);
    keys.add(key);
    return {
      pluginId: record.pluginId,
      buildId: record.buildId,
      namespace: record.namespace,
      revision: record.revision!,
      artifactRoot: path.resolve(path.dirname(file), record.artifactRoot),
      ...(record.active === undefined ? {} : { active: record.active }),
    };
  });
  return { revisions };
}

export async function readRscDevelopmentState(file: string): Promise<RscDevelopmentState> {
  return parseRscDevelopmentState(file, await readFile(file, 'utf8'));
}

export function watchRscDevelopmentState(
  file: string,
  listener: (state: RscDevelopmentState) => void | Promise<void>,
  options: { debounceMs?: number; pollMs?: number; onError?: (error: unknown) => void } = {},
): { refresh(): Promise<void>; close(): Promise<void> } {
  const absoluteFile = path.resolve(file);
  const directory = path.dirname(absoluteFile);
  const pollMs = options.pollMs ?? Math.max(100, (options.debounceMs ?? 50) * 4);
  if (!Number.isFinite(pollMs) || pollMs < 10) throw new TypeError('RSC development pollMs must be at least 10');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let lastObservedSource: string | undefined;
  const refresh = (force = true) => {
    if (closed) return Promise.resolve();
    const apply = async () => {
      if (closed) return;
      const source = await readFile(absoluteFile, 'utf8');
      if (!force && source === lastObservedSource) return;
      lastObservedSource = source;
      await listener(parseRscDevelopmentState(absoluteFile, source));
    };
    const result = queue.then(apply, apply);
    queue = result.catch((error) => options.onError?.(error));
    return result;
  };
  const watcher: FSWatcher = watch(directory, (_event, changed) => {
    // Atomic rename implementations are not required to report the final file
    // name consistently. Any directory change is cheap enough to re-scan.
    void changed;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(false).catch(() => undefined), options.debounceMs ?? 50);
  });
  poller = setInterval(() => void refresh(false).catch(() => undefined), pollMs);
  poller.unref?.();
  return {
    refresh,
    async close() {
      if (closed) {
        await queue.catch(() => undefined);
        return;
      }
      closed = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      watcher.close();
      await queue.catch(() => undefined);
    },
  };
}
