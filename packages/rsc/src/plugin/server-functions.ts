import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RscServerFunctionInvocationContext, RscServerFunctionRuntime } from './types';

interface RscServerFunctionExecutionContext {
  signal: AbortSignal;
  invokeModel(id: string, input: unknown): Promise<unknown>;
}

const execution = new AsyncLocalStorage<RscServerFunctionExecutionContext>();

function currentExecution(): RscServerFunctionExecutionContext {
  const context = execution.getStore();
  if (!context) {
    throw new Error('RSC Server Function APIs can only be used while executing a Server Function');
  }
  return context;
}

export function getRscServerFunctionSignal(): AbortSignal {
  return currentExecution().signal;
}

export function invokeRscModel(id: string, input: unknown): Promise<unknown> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('RSC Model id must not be empty');
  }
  return currentExecution().invokeModel(id, input);
}

export class RscArtifactServerFunctionRuntime implements RscServerFunctionRuntime {
  private readonly artifactRoot: string;
  private readonly modules = new Map<string, Promise<Record<string, unknown>>>();

  constructor(artifactRoot: string) {
    this.artifactRoot = realpathSync(path.resolve(artifactRoot));
  }

  public get cachedModuleCount(): number {
    return this.modules.size;
  }

  private load(modulePath: string, integrity: string): Promise<Record<string, unknown>> {
    const absolute = path.resolve(this.artifactRoot, modulePath);
    if (!absolute.startsWith(`${this.artifactRoot}${path.sep}`)) {
      throw new Error(`RSC Server Function artifact escapes its root: ${modulePath}`);
    }
    const key = `${modulePath}:${integrity}`;
    let promise = this.modules.get(key);
    if (!promise) {
      const url = pathToFileURL(absolute);
      url.searchParams.set('integrity', integrity);
      promise = import(url.href) as Promise<Record<string, unknown>>;
      this.modules.set(key, promise);
      void promise.catch(() => {
        if (this.modules.get(key) === promise) this.modules.delete(key);
      });
    }
    return promise;
  }

  public async invoke(context: RscServerFunctionInvocationContext): Promise<unknown> {
    context.signal.throwIfAborted();
    const declared = context.manifest.serverFunctions.some((reference) =>
      reference.id === context.reference.id
      && reference.module === context.reference.module
      && reference.exportName === context.reference.exportName
      && reference.integrity === context.reference.integrity);
    if (!declared) {
      throw new Error(`RSC Server Function is not declared by the immutable manifest: ${context.reference.id}`);
    }
    const module = await this.load(context.reference.module, context.reference.integrity);
    const callable = module[context.reference.exportName];
    if (typeof callable !== 'function') {
      throw new Error(
        `RSC Server Function export is not callable: ${context.reference.id}`,
      );
    }
    context.signal.throwIfAborted();
    return execution.run(
      { signal: context.signal, invokeModel: context.invokeModel },
      () => Promise.resolve(callable(...context.args)),
    );
  }
}
