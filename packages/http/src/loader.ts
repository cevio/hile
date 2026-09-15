import { pathToFileURL } from 'node:url';
import { ControllerRegisterProps } from './controller';
import { Http } from './http';
import compose from 'koa-compose';
import type { Middleware } from 'koa';
import {
  compileFileRoute,
  compileCompatibleRoutePath,
  FileRouteBackend,
  compileRoutePath,
  scanDirectory,
  type FileRoute,
} from '@hile/loader';

export type LoaderConflictStrategy = 'error' | 'warn' | 'override';

export type LoaderConflictResolution = 'error' | 'keep' | 'override';

export type LoaderConflictContext = {
  routeKey: string;
  method: string;
  url: string;
  strategy: LoaderConflictStrategy;
  resolution: LoaderConflictResolution;
};

export interface LoaderCompileOptions {
  defaultSuffix?: string; // 默认后缀，解析后将被重置为/或空字符串
  prefix?: string; // 前缀
  conflict?: LoaderConflictStrategy; // 路由冲突处理策略
  onConflict?: (ctx: LoaderConflictContext) => void; // 路由冲突回调
}

export type LoaderFromOptions = {
  suffix?: string; // 标记以什么后缀结尾的文件为路由
} & LoaderCompileOptions;

/**
 * 判断是否为 ControllerRegisterProps 类型
 */
function isControllerRegisterProps(value: any): value is ControllerRegisterProps {
  return !!value
    && typeof value === 'object'
    && typeof value.id === 'number'
    && typeof value.method === 'string'
    && Array.isArray(value.middlewares)
    && !!value.data
    && typeof value.data === 'object';
}

/**
 * 转为标准的数组路由信息格式
 */
function normalizeControllers(value: unknown): ControllerRegisterProps[] {
  if (Array.isArray(value)) {
    if (!value.length) throw new Error('controller array is empty');
    if (!value.every(isControllerRegisterProps)) {
      throw new Error('default export must be ControllerRegisterProps or ControllerRegisterProps[]');
    }
    return value;
  }

  if (!isControllerRegisterProps(value)) {
    throw new Error('default export must be ControllerRegisterProps or ControllerRegisterProps[]');
  }

  return [value];
}

function summarizeExportType(value: unknown) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return 'array(empty)';
    const first = value[0];
    return `array(len=${value.length}, first=${typeof first})`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object(keys=[${keys.slice(0, 5).join(',')}])`;
  }
  return typeof value;
}

export class Loader {
  private readonly registeredRoutes = new Map<string, {
    off: () => void;
    source?: string;
  }>();

  constructor(private readonly http: Http) { }

  /**
   * 单个路由绑定编译
   */
  public compile(path: string, controllers: ControllerRegisterProps | ControllerRegisterProps[], options: LoaderCompileOptions = {
    defaultSuffix: '/index',
  }) {
    const compiledPath = compileRoutePath(path, { defaultSuffix: options.defaultSuffix });
    const compiled = compileCompatibleRoutePath(compiledPath, FileRouteBackend.FindMyWay, {
      prefix: options.prefix,
    });
    return this.bindRoute(
      compiled.path,
      compiled.shape,
      controllers,
      options,
      compiled.catchAllName,
    );
  }

  private compileFileRoute(
    route: FileRoute,
    controllers: ControllerRegisterProps | ControllerRegisterProps[],
    options: LoaderCompileOptions,
    source?: string,
  ) {
    const compiled = compileFileRoute(route, FileRouteBackend.FindMyWay, { prefix: options.prefix });
    return this.bindRoute(
      compiled.path,
      compiled.shape,
      controllers,
      options,
      compiled.catchAllName,
      source,
    );
  }

  private bindRoute(
    routePath: string,
    routeShape: string,
    controllers: ControllerRegisterProps | ControllerRegisterProps[],
    options: LoaderCompileOptions,
    catchAllName?: string,
    source?: string,
  ) {
    const callbacks: (() => void)[] = [];
    const normalizedControllers = normalizeControllers(controllers);
    const strategy = options.conflict || 'error';

    try {
      for (let i = 0; i < normalizedControllers.length; i++) {
        const controller = normalizedControllers[i];
        const { method, middlewares } = controller;
        const routeKey = `${method}:${routePath}`;
        const ownerKey = `${method}:${routeShape}`;
        const exists = this.registeredRoutes.get(ownerKey);

        if (exists) {
          if (strategy === 'error') {
            options.onConflict?.({
              routeKey,
              method,
              url: routePath,
              strategy,
              resolution: 'error',
            });
            const locations = [source, exists.source].filter(Boolean).join(' conflicts with ');
            throw new Error(`route conflict: ${routeKey}${locations ? ` in ${locations}` : ''}`);
          }

          if (strategy === 'warn') {
            options.onConflict?.({
              routeKey,
              method,
              url: routePath,
              strategy,
              resolution: 'keep',
            });
            console.warn(`[hile/http] route conflict: ${routeKey}, keeping existing route`);
            continue;
          }

          options.onConflict?.({
            routeKey,
            method,
            url: routePath,
            strategy,
            resolution: 'override',
          });
          exists.off();
          this.registeredRoutes.delete(ownerKey);
        }

        controller.data.url = routePath;
        const routeMiddlewares = catchAllName
          ? [requiredCatchAllMiddleware(catchAllName, middlewares)]
          : middlewares;
        const off = this.http.route(method, routePath, ...routeMiddlewares);
        const registration = { off, source };
        this.registeredRoutes.set(ownerKey, registration);
        callbacks.push(() => {
          const registered = this.registeredRoutes.get(ownerKey);
          if (registered !== registration) return;
          off();
          this.registeredRoutes.delete(ownerKey);
        });
      }
    } catch (error) {
      let index = callbacks.length;
      while (index--) callbacks[index]();
      throw error;
    }

    return () => {
      let j = callbacks.length;
      while (j--) callbacks[j]();
    };
  }

  /**
   * 文件夹批量路由绑定编译
   */
  public async from(directory: string, options: LoaderFromOptions = {
    defaultSuffix: '/index',
    suffix: 'controller',
  }) {
    const { suffix = 'controller', ...extras } = options;
    const files = await scanDirectory(directory, { suffix, ...extras, fileRoutes: true });
    const callbacks: (() => void)[] = [];

    try {
      const pending = await Promise.all(files.map(async (file) => {
        const controller = await import(pathToFileURL(file.absolute).href);
        const { default: fn } = controller;

        let normalized: ControllerRegisterProps[];
        try {
          normalized = normalizeControllers(fn);
        } catch (error: any) {
          const summary = summarizeExportType(fn);
          throw new Error(`invalid service file: ${file.relative} (${summary}) - ${error?.message || String(error)}`);
        }

        return { file: file.route, controllers: normalized, source: file.relative };
      }));

      for (const item of pending) {
        callbacks.push(this.compileFileRoute(item.file, item.controllers, extras, item.source));
      }
    } catch (error) {
      let index = callbacks.length;
      while (index--) callbacks[index]();
      throw error;
    }

    return () => {
      let i = callbacks.length;
      while (i--) callbacks[i]();
    }
  }
}

function requiredCatchAllMiddleware(name: string, middlewares: Middleware[]): Middleware {
  const run = compose(middlewares);
  return (ctx, next) => {
    const value = ctx.params?.['*'];
    if (typeof value !== 'string' || value.length === 0) return next();
    // Keep renamed route params on a null-prototype object so parameter names
    // cannot interact with Object.prototype setters.
    const params = Object.assign(Object.create(null), ctx.params, { [name]: value });
    delete params['*'];
    ctx.params = params;
    return run(ctx, next);
  };
}
