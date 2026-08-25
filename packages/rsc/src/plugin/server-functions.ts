import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  RscServerFunctionApi,
  RscServerFunctionInvocationContext,
  RscServerFunctionRuntime,
} from './types';

const RSC_SERVER_FUNCTION_DEFINITION = Symbol.for('@hile/rsc/server-function-definition');
type DefinedRscServerFunction = ((api: RscServerFunctionApi, ...args: unknown[]) => Promise<unknown>) & {
  [RSC_SERVER_FUNCTION_DEFINITION]: true;
};

/**
 * Defines a Server Function whose public React signature contains only wire arguments while
 * the plugin runtime supplies the explicit request-scoped API before invoking the handler.
 */
export function defineRscServerFunction<TArgs extends unknown[], TResult>(
  handler: (api: RscServerFunctionApi, ...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  const defined = async (...runtimeArgs: [RscServerFunctionApi, ...TArgs]) => handler(...runtimeArgs);
  Object.defineProperty(defined, RSC_SERVER_FUNCTION_DEFINITION, { value: true });
  return defined as unknown as (...args: TArgs) => Promise<TResult>;
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
    if (
      typeof callable !== 'function'
      || (callable as Partial<DefinedRscServerFunction>)[RSC_SERVER_FUNCTION_DEFINITION] !== true
    ) {
      throw new Error(
        `RSC Server Function export was not created by defineRscServerFunction(): ${context.reference.id}`,
      );
    }
    context.signal.throwIfAborted();
    const api: RscServerFunctionApi = Object.freeze({
      signal: context.signal,
      context: context.context,
      invokeModel(id: string, input: unknown) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new TypeError('RSC Model id must not be empty');
        }
        return context.invokeModel(id, input);
      },
    });
    return Promise.resolve(callable(api, ...context.args));
  }
}
