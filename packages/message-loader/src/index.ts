import { Loader, toRouterPath, normalizePath } from '@hile/loader';
import type { ScannedFile } from '@hile/loader';
import { createRouter, addRoute, RouterContext, removeRoute, findRoute } from "rou3";
import { MessageRegisterProps, MessageFunction, getId } from './message';

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
export class MessageLoader extends Loader<MessageRegisterProps> {
  private readonly router: RouterContext;
  private readonly METHOD = 'GET';
  constructor(props: MessageLoaderProps) {
    super({
      suffix: props.suffix || 'msg',
      defaultSuffix: props.defaultSuffix || '/index',
      prefix: props.prefix || '',
    });
    this.router = createRouter();
  }

  protected bind(file: ScannedFile, metadata: MessageRegisterProps) {
    const routePath = toRouterPath(normalizePath(file.routePath));
    addRoute(this.router, this.METHOD, routePath, metadata);
    return () => removeRoute(this.router, this.METHOD, routePath);
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