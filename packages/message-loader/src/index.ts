import { glob } from 'glob';
import { resolve, extname } from 'node:path';
import { createRouter, addRoute, RouterContext, removeRoute, findRoute } from "rou3";
import { toRouterPath } from './utils';
import { MessageRegisterProps } from './message';

export * from './message';

export interface MessageLoaderProps {
  suffix?: string;
  defaultSuffix?: string;
  prefix?: string;
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
 *     return super.request({ url, data }, timeout);
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
 *     return super.request({ url, data }, timeout);
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
 *     return super.request({ url, data }, timeout);
 *   }
 * }
 * const ipc = new MyIpc();
 * const result = await ipc.request('/-/hello', { name: 'world' }).response();
 * ipc.dispose();
 */
export class MessageLoader {
  private readonly router: RouterContext;
  private readonly props: MessageLoaderProps;
  constructor(props: MessageLoaderProps) {
    this.router = createRouter();
    this.props = props;
    if (!this.props.suffix) this.props.suffix = 'msg';
    if (!this.props.defaultSuffix) this.props.defaultSuffix = '/index';
    if (!this.props.prefix) this.props.prefix = '';
  }

  private compileRoutePath(path: string) {
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

  public async load(directory: string) {
    const files = await glob(`**/*.${this.props.suffix}.{ts,js,tsx,jsx}`, { cwd: directory });
    const messages = await Promise.all(files.map(async (file) => {
      const path = resolve(directory, file);
      const ext = extname(path);
      const url = file.substring(0, file.length - this.props.suffix!.length - ext.length - 1);
      const controller = await import(path);
      if (!controller.default) return;
      const { default: metadata } = controller;
      const routePath = toRouterPath(this.compileRoutePath(url));
      addRoute(this.router, 'GET', routePath, metadata);
      return () => removeRoute(this.router, 'GET', routePath);
    }).filter(Boolean));
    return () => messages.forEach(message => message?.());
  }

  public dispatch(path: string, data: any) {
    const matched = findRoute(this.router, 'GET', path, {
      params: true,
      normalize: true,
    });
    if (!matched) {
      throw new Error(`message not found: ${path}`);
    }
    const handler = matched.data as MessageRegisterProps;
    return Promise.resolve(handler.fn({
      params: matched.params ?? {},
      data,
      url: path,
    }));
  }
}