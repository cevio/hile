import Koa, { Next, Middleware } from 'koa';
import { Config } from 'find-my-way';
import { randomBytes } from 'node:crypto';
import FindMyWay, { Instance, HTTPMethod, HTTPVersion } from './find-my-way';
import { createServer, Server } from 'node:http';
import { Loader, LoaderFromOptions } from './loader';

// Http 配置
export type HttpProps = {
  port: number,
  keys?: string[],
} & Omit<Config<HTTPVersion.V1>, 'defaultRoute'>;

/**
 * Http 服务类
 * @description - 提供 HTTP 服务的基本功能
 * @example
 * const http = new Http({
 *   port: 3000,
 *   ignoreDuplicateSlashes: true,
 *   ignoreTrailingSlash: true,
 *   maxParamLength: +Infinity,
 *   allowUnsafeRegex: true,
 *   caseSensitive: true,
 * });
 * http.use(async (ctx, next) => {
 *   await next();
 * });
 * http.use(async (ctx, next) => {
 *   await next();
 * });
 * http.use(async (ctx, next) => {
 *   await next();
 * });
 * await http.listen((server) => {
 *   console.log('Server is running on port 3000');
 * });
 * console.log('Server is running on port 3000');
 */
export class Http {
  private readonly koa = new Koa();
  private readonly loader = new Loader(this);
  private readonly router: Instance;
  private server?: Server;

  constructor(private readonly props: HttpProps) {
    if (!this.props.keys) {
      this.props.keys = [randomBytes(32).toString(), randomBytes(64).toString()];
    }
    this.koa.keys = this.props.keys;
    this.router = FindMyWay({
      ignoreDuplicateSlashes: this.props.ignoreDuplicateSlashes ?? true,
      ignoreTrailingSlash: this.props.ignoreTrailingSlash ?? true,
      maxParamLength: this.props.maxParamLength ?? +Infinity,
      allowUnsafeRegex: this.props.allowUnsafeRegex ?? true,
      caseSensitive: this.props.caseSensitive ?? true,
      // @ts-ignore
      defaultRoute: async (_, next: Next) => await next(),
    });
  }

  /**
   * 获取服务端口
   * @returns - 服务端口
   */
  get port() {
    return this.props.port;
  }

  /**
   * 启动服务前注册中间件
   * @param middleware - 中间件函数
   * @returns - 当前实例
   */
  public use(middleware: Middleware) {
    this.koa.use(middleware);
    return this;
  }

  /**
   * 启动服务
   * @param onListen - 启动服务后回调函数，可选，回调函数返回值为关闭服务回调函数
   * @returns - 关闭服务回调函数
   */
  public async listen(onListen?: (server: Server) => void | Promise<void>) {
    this.koa.use(this.router.routes());
    this.server = createServer(this.koa.callback());
    if (onListen) await onListen(this.server!);
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.props.port, (err?: any) => {
        if (err) return reject(err);
        resolve();
      })
    })
    return () => {
      this.server!.close();
    }
  }

  /**
   * 注册 GET 请求路由  
   * @param url - 请求路径
   * @param middlewares - 中间件函数
   * @returns - 注销路由回调函数
   */
  public get(url: string, ...middlewares: Middleware[]) {
    return this.route('GET', url, ...middlewares);
  }

  /**
   * 注册 POST 请求路由
   * @param url - 请求路径
   * @param middlewares - 中间件函数
   * @returns - 注销路由回调函数
   */
  public post(url: string, ...middlewares: Middleware[]) {
    return this.route('POST', url, ...middlewares);
  }

  /**
   * 注册 PUT 请求路由
   * @param url - 请求路径
   * @param middlewares - 中间件函数
   * @returns - 注销路由回调函数
   */
  public put(url: string, ...middlewares: Middleware[]) {
    return this.route('PUT', url, ...middlewares);
  }

  /**
   * 注册 DELETE 请求路由
   * @param url - 请求路径
   * @param middlewares - 中间件函数
   * @returns - 注销路由回调函数
   */
  public delete(url: string, ...middlewares: Middleware[]) {
    return this.route('DELETE', url, ...middlewares);
  }

  /**
   * 注册 TRACE 请求路由
   * @param url - 请求路径
   * @param middlewares - 中间件函数
   * @returns - 注销路由回调函数
   */
  public trace(url: string, ...middlewares: Middleware[]) {
    return this.route('TRACE', url, ...middlewares);
  }

  /**
   * 注册路由
   * @param method 请求方法
   * @param url 请求路径
   * @param middlewares 中间件
   * @returns 注销路由回调函数
   */
  public route(method: HTTPMethod, url: string, ...middlewares: Middleware[]) {
    this.router.on(method, url, ...middlewares);
    return () => {
      this.router.off(method, url);
    };
  }

  /**
   * 绑定文件夹下的所有路由
   * @param directory 文件夹路径
   * @param options 选项
   * @returns 注销回调
   */
  public load(directory: string, options: LoaderFromOptions = {
    defaultSuffix: '/index',
    suffix: 'controller',
  }) {
    return this.loader.from(directory, options);
  }
}