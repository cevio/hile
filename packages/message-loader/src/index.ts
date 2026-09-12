import { Loader, toRouterPath, normalizePath } from '@hile/loader';
import type { ScannedFile } from '@hile/loader';
import { createRouter, addRoute, findRoute, removeRoute } from 'rou3';
import type { RouterContext } from 'rou3';
import { getId } from './message';
import type { MessageRegisterProps, MessageFunction, MessageProtocolOptions } from './message.js';
import { assertRouteAvailable, buildRouter, createRouteOwner, normalizeMessagePath } from './route-owner';
import type { RouteOwner } from './route-owner.js';
import { validateProtocol } from './protocol';

export * from './message';
export { MessageRouteConflictError } from './route-owner';

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

export class MessageProtocolMismatchError extends Error {
  public readonly status = 'HILE_MESSAGE_PROTOCOL_MISMATCH';

  constructor() {
    super('Message protocol mismatch');
  }
}

export class MessageLoadInProgressError extends Error {
  public readonly status = 'HILE_MESSAGE_LOAD_IN_PROGRESS';

  constructor() {
    super('Message load is in progress');
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
 *     return this._send({ url, data }, { timeout });
 *   }
 * }
 * const ws = new WebSocket('ws://localhost:8080');
 * ws.on('open', async () => {
 *   const modem = new MyWs(ws);
 *   const result = await modem.request('/-/hello', { name: 'world' });
 *   console.log(result);
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
 *     return this._send({ url, data }, { timeout });
 *   }
 * }
 * const worker = new Worker('./worker.js');
 * const wt = new MyWorkerThread(worker);
 * const result = await wt.request('/-/hello', { name: 'world' });
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
 *     return this._send({ url, data }, { timeout });
 *   }
 * }
 * const ipc = new MyIpc();
 * const result = await ipc.request('/-/hello', { name: 'world' });
 * ipc.dispose();
 */
export class MessageLoader extends Loader<MessageRegisterProps> {
  private router: RouterContext<MessageRegisterProps>;
  private owners = new Set<RouteOwner>();
  private pendingOwners?: Set<RouteOwner>;
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
    return this.registerOwner(routePath, metadata);
  }

  /** A batch becomes visible atomically; concurrent writes must wait for its result. */
  public override async load(directory: string, options: { cacheBust?: string | number } = {}) {
    if (this.pendingOwners) throw new MessageLoadInProgressError();
    this.pendingOwners = new Set(this.owners);
    let unload: (() => void) | undefined;
    try {
      unload = await super.load(directory, options);
      const router = buildRouter(this.pendingOwners);
      this.owners = this.pendingOwners;
      this.router = router;
      return unload;
    } catch (error) {
      try {
        unload?.();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Message load commit rollback failed');
      }
      throw error;
    } finally {
      this.pendingOwners = undefined;
    }
  }

  private registerOwner(routePath: string, metadata: MessageRegisterProps<any, any>): () => void {
    if (!metadata || typeof metadata.fn !== 'function') {
      throw new TypeError('Invalid message handler');
    }
    validateProtocol(metadata.protocol);
    const owner = createRouteOwner(normalizeMessagePath(routePath), { ...metadata });
    const owners = this.pendingOwners ?? this.owners;
    assertRouteAvailable(owner, owners);
    owners.add(owner);
    if (!this.pendingOwners) addRoute(this.router, this.METHOD, owner.path, owner.metadata);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      // The same owner can be in the active and staged snapshots. Never restore
      // an owner released during a load, nor remove a later replacement owner.
      this.pendingOwners?.delete(owner);
      if (this.owners.delete(owner)) removeRoute(this.router, this.METHOD, owner.path);
    };
  }

  /**
   * 注册消息处理器
   * @param routePath 路由路径
   * @param fn 消息处理器
   * @returns 注销函数
   */
  public register<T = any, E extends Record<string, any> = {}>(
    routePath: string,
    fn: MessageFunction<T, E>,
    options: MessageProtocolOptions = {},
  ) {
    if (this.pendingOwners) throw new MessageLoadInProgressError();
    const id = getId();
    return this.registerOwner(routePath, { id, fn, protocol: options.protocol });
  }

  /**
   * 分发消息
   * @param path 路径
   * @param data 数据
   * @returns 结果
   */
  public async dispatch(
    path: string,
    data: any,
    extras: Record<string, any> = {},
    options: MessageProtocolOptions = {},
  ) {
    validateProtocol(options.protocol);
    const matched = findRoute(this.router, this.METHOD, normalizeMessagePath(path), {
      params: true,
      normalize: true,
    });
    if (!matched) {
      throw new NotFoundException(path);
    }
    const handler = matched.data;
    if (handler.protocol !== options.protocol) throw new MessageProtocolMismatchError();
    return await Promise.resolve(handler.fn({
      params: matched.params ?? {},
      data,
      url: path,
      ...extras,
    }));
  }
}
