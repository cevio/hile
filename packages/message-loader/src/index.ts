import { glob } from 'glob';
import { resolve, extname } from 'node:path';
import { createRouter, addRoute, RouterContext, removeRoute, findRoute } from "rou3";
import { toRouterPath } from './utils';
import { MessageRegisterProps, MessageFunction, getId } from './message';
import { pathToFileURL } from 'node:url';

export * from './message';

export interface MessageLoaderProps {
  suffix?: string;
  defaultSuffix?: string;
  prefix?: string;
}

export class NotFoundException extends Error {
  public readonly status = 'NOT_FOUND';
  constructor(path: string) {
    super(path);
  }
}

/**
 * 消息加载器，用于加载消息并将其注册到路由器中
 * 
 * @example
 * const loader = new MessageLoader({
 *   suffix: 'msg',
 *   defaultSuffix: '/index',
 *   prefix: '/-',
 * });
 * await loader.load(path.resolve(__dirname, 'messages'));
 * const result = await loader.dispatch('/-/hello', { name: 'world' });
 * 
 * @example message adapter:
 * import { MessageWs } from '@hile/message-ws';
 * import { WebSocket } from 'ws';
 * class MyWs extends MessageWs {
 *   protected async exec(data: { url: string, data: any }): Promise<any> {
 *     const result = await loader.dispatch(data.url, data.data);
 *     return result;
 *   }
 *   public request(url: string, data: any, timeout?: number) {
 *     return this._send({ url, data }, timeout);
 *   }
 * }
 * const ws = new WebSocket('ws://localhost:8080');
 * ws.on('open', () => {
 *   const modem = new MyWs(ws);
 *   modem.request('/-/hello', { name: 'world' }).response()
 *     .then(console.log)
 *     .catch(console.error);
 *   modem.dispose();
 *   ws.close();
 * });
 * 
 * @example message adapter:
 * import { MessageWorkerThread } from '@hile/message-worker-thread';
 * import { Worker } from 'worker_threads';
 * class MyWorkerThread extends MessageWorkerThread {
 *   protected async exec(data: { url: string, data: any }): Promise<any> {
 *     const result = await loader.dispatch(data.url, data.data);
 *     return result;
 *   }
 *   public request(url: string, data: any, timeout?: number) {
 *     return this._send({ url, data }, timeout);
 *   }
 * }
 * const worker = new Worker('./worker.js');
 * const wt = new MyWorkerThread(worker);
 * const result = await wt.request('/-/hello', { name: 'world' }).response();
 * wt.dispose();
 * await worker.terminate();
 * 
 * @example message adapter:
 * import { MessageIpc } from '@hile/message-ipc';
 * class MyIpc extends MessageIpc {
 *   protected async exec(data: { url: string, data: any }): Promise<any> {
 *     const result = await loader.dispatch(data.url, data.data);
 *     return result;
 *   }
 *   public request(url: string, data: any, timeout?: number) {
 *     return this._send({ url, data }, timeout);
 *   }
 * }
 * const ipc = new MyIpc();
 * const result = await ipc.request('/-/hello', { name: 'world' }).response();
 * ipc.dispose();
 */
export class MessageLoader {
  private readonly router: RouterContext;
  private readonly props: MessageLoaderProps;
  private readonly METHOD = 'GET';
  constructor(props: MessageLoaderProps) {
    this.router = createRouter();
    this.props = props;

    // 默认值
    if (!this.props.suffix) this.props.suffix = 'msg';
    if (!this.props.defaultSuffix) this.props.defaultSuffix = '/index';
    if (!this.props.prefix) this.props.prefix = '';
  }

  /**
   * 将路径编译为标准 URL（不含动态参数转换）
   * @param path 路径
   * @returns 编译后的路径
   */
  private compileRoutePath(path: string) {
    path = formatRouterWithIgnoreDuplicateSlashes(path);
    const defaultSuffix = this.props.defaultSuffix!;
    let url = path.startsWith('/') ? path : '/' + path;
    if (url.endsWith(defaultSuffix)) {
      url = url.substring(0, url.length - defaultSuffix.length);
    }
    if (!url) url = '/';

    return this.props.prefix
      ? this.props.prefix + url
      : url;
  }

  /**
   * 从目录加载消息处理器
   * @param directory 目录路径
   * @returns 注销函数
   */
  public async load(directory: string) {
    const files = await glob(`**/*.${this.props.suffix}.{ts,js,tsx,jsx}`, { cwd: directory });
    const callbacks: (() => void)[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = resolve(directory, file);
      const ext = extname(path);
      const url = file.substring(0, file.length - this.props.suffix!.length - ext.length - 1);
      // 导入消息处理器
      const _file = pathToFileURL(path).href;
      const controller: { default: MessageRegisterProps } = await import(_file);
      if (!controller.default) continue;
      // 获取消息处理器
      const { default: metadata } = controller;
      // 编译路径
      const routePath = toRouterPath(this.compileRoutePath(url));
      // 添加路由
      addRoute(this.router, this.METHOD, routePath, metadata);
      // 返回注销函数
      callbacks.push(() => removeRoute(this.router, this.METHOD, routePath));
    }

    return () => callbacks.forEach(callback => callback());
  }

  /**
   * 注册消息处理器
   * @param routePath 路由路径
   * @param fn 消息处理器
   * @returns 注销函数
   */
  public register<T = any, E extends Record<string, any> = {}>(routePath: string, fn: MessageFunction<T, E>) {
    const id = getId();
    addRoute(this.router, this.METHOD, routePath, { id, fn });
    return () => removeRoute(this.router, this.METHOD, routePath);
  }

  /**
   * 分发消息
   * @param path 路径
   * @param data 数据
   * @returns 结果
   */
  public async dispatch(path: string, data: any, extras: Record<string, any> = {}) {
    const matched = findRoute(this.router, this.METHOD, path, {
      params: true,
      normalize: true,
    });
    if (!matched) {
      throw new NotFoundException(path);
    }
    const handler = matched.data as MessageRegisterProps;
    return await Promise.resolve(handler.fn({
      params: matched.params ?? {},
      data,
      url: path,
      ...extras,
    }));
  }
}

function formatRouterWithIgnoreDuplicateSlashes(path: string) {
  let id = path.replace(/\\/g, '/');
  id = id.replace(/\([^\)]+\)/g, '').replace(/\/{2,}/g, '/');
  return id;
}