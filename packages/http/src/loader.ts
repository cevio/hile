import { ControllerRegisterProps } from './controller';
import { Http } from './http';
import { glob } from 'glob';
import { resolve } from 'node:path';

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
 * 将文件路径编译为标准 URL（不含动态参数转换）
 */
export function compileRoutePath(path: string, options: Pick<LoaderCompileOptions, 'defaultSuffix' | 'prefix'> = {}) {
  const defaultSuffix = options.defaultSuffix || '/index';
  let url = path.startsWith('/') ? path : '/' + path;
  if (url.endsWith(defaultSuffix)) {
    url = url.substring(0, url.length - defaultSuffix.length);
  }
  if (!url) url = '/';

  return options.prefix ? options.prefix + url : url;
}

/**
 * 将 [param] 格式参数转换为 find-my-way 兼容的 :param
 */
export function toRouterPath(path: string) {
  return path.replace(/\[([^\]]+)\]/g, ':$1');
}

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
  private readonly registeredRoutes = new Map<string, () => void>();

  constructor(private readonly http: Http) { }

  /**
   * 单个路由绑定编译
   */
  public compile(path: string, controllers: ControllerRegisterProps | ControllerRegisterProps[], options: LoaderCompileOptions = {
    defaultSuffix: '/index',
  }) {
    const callbacks: (() => void)[] = [];
    const normalizedControllers = normalizeControllers(controllers);
    const routePath = toRouterPath(compileRoutePath(path, options));
    const strategy = options.conflict || 'error';

    for (let i = 0; i < normalizedControllers.length; i++) {
      const controller = normalizedControllers[i];
      const { method, middlewares } = controller;
      const routeKey = `${method}:${routePath}`;
      const exists = this.registeredRoutes.get(routeKey);

      if (exists) {
        if (strategy === 'error') {
          options.onConflict?.({
            routeKey,
            method,
            url: routePath,
            strategy,
            resolution: 'error',
          });
          throw new Error(`route conflict: ${routeKey}`);
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
        exists();
        this.registeredRoutes.delete(routeKey);
      }

      controller.data.url = routePath;
      const off = this.http.route(method, routePath, ...middlewares);
      this.registeredRoutes.set(routeKey, off);
      callbacks.push(() => {
        off();
        this.registeredRoutes.delete(routeKey);
      });
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

    const files = await glob(`**/*.${suffix}.{ts,js}`, { cwd: directory });

    const callbacks = await Promise.all(files.map(async (file) => {
      const path = resolve(directory, file);
      const url = file.substring(0, file.length - suffix.length - 4);
      const controller = await import(path);
      const { default: fn } = controller;

      let normalized: ControllerRegisterProps[];
      try {
        normalized = normalizeControllers(fn);
      } catch (error: any) {
        const summary = summarizeExportType(fn);
        throw new Error(`invalid service file: ${file} (${summary}) - ${error?.message || String(error)}`);
      }

      return this.compile(url, normalized, extras);
    }));

    return () => {
      let i = callbacks.length;
      while (i--) callbacks[i]();
    }
  }
}
