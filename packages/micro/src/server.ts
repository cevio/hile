import { WebSocketServer } from 'ws';
import { MessageLoader, MessageLoaderProps } from "@hile/message-loader";
import { WebSocket } from 'ws';
import { Client } from './client';
import { IncomingMessage } from 'http';
import { getLocalIPv4 } from './utils';
import { EventEmitter } from 'node:events';
import type { Duplex } from "node:stream";
import type { Logger } from '@hile/logger';

const DEFAULT_CONNECT_TIMEOUT = 5000;

/** {@link MessageLoaderProps} 加上出站 WebSocket 宣告地址 */
export type MicroServerProps = MessageLoaderProps & {
  /**
   * 出站连接 URL 中 `ws://{host}:{port}/{本段}/...` 的「本段」宣告地址。
   * 缺省使用 `getLocalIPv4()`；若仍为 `undefined`（无可用 IPv4）则构造 {@link Server} 时抛错。
   */
  advertiseHost?: string;
  /**
   * 日志记录器
   */
  logger?: Logger;
};

export class Server extends MessageLoader {
  private wss?: WebSocketServer;
  public port?: number;
  public readonly logger: Logger | Console;
  public readonly clients = new Map<string, Client>();
  private readonly clientExtras = new Map<string, string[]>();
  private readonly pendingConnections = new Map<string, {
    promise: Promise<Client>;
    controller: AbortController;
    waiters: number;
  }>();
  private readonly announceHost: string;
  public readonly events = new EventEmitter();

  get host() {
    return this.announceHost;
  }

  constructor(public readonly namespace: string, props: MicroServerProps = {}) {
    const { advertiseHost, logger, ...loaderProps } = props;
    super(loaderProps);
    const resolved = advertiseHost?.trim() || getLocalIPv4();
    if (!resolved) {
      throw new Error(
        'Unable to resolve advertise host for @hile/micro Server: pass `advertiseHost` (e.g. "127.0.0.1") in constructor options, or ensure getLocalIPv4() returns an address.',
      );
    }
    this.announceHost = resolved;
    this.logger = logger ?? console;
    this.events.on('connect', (client: Client, extras: string[]) => {
      client.events.emit('connect', extras);
    });
    this.events.on('disconnect', (client: Client, extras: string[]) => {
      client.events.emit('disconnect', extras);
    });
  }

  private upstream(ws: WebSocket, req: IncomingMessage) {
    const path = req.url?.split('?')[0];
    if (!path) return ws.close();
    let _path = path.startsWith('/') ? path.slice(1) : path;
    _path = _path.endsWith('/') ? _path.slice(0, -1) : _path;
    const sp = _path.split('/');
    if (sp.length < 3) return ws.close();
    const [host, port, ...extras] = sp;
    if (!host || !port) return ws.close();
    const portNum = Number(port);
    if (
      !Number.isFinite(portNum) ||
      portNum !== Math.trunc(portNum) ||
      portNum < 1 ||
      portNum > 65535
    ) {
      return ws.close();
    }
    this.createClient(ws, host, portNum, extras);
  }

  private createClient(ws: WebSocket, host: string, port: number, extras: string[] = []) {
    const key = `${host}:${port}`;
    const previous = this.clients.get(key);
    if (previous) {
      const previousExtras = this.clientExtras.get(key) ?? [];
      this.clients.delete(key);
      this.clientExtras.delete(key);
      previous.dispose();
      this.events.emit('disconnect', previous, previousExtras);
    }
    const client = new Client({ server: this, ws, host, port });
    ws.on('close', () => {
      if (this.clients.get(key) === client) {
        this.clients.delete(key);
        this.clientExtras.delete(key);
        client.dispose();
        this.events.emit('disconnect', client, extras);
      }
    });
    this.clients.set(key, client);
    this.clientExtras.set(key, extras);
    this.events.emit('connect', client, extras);
    return client;
  }

  protected async connect(host: string, port: number, timeout = DEFAULT_CONNECT_TIMEOUT, signal?: AbortSignal) {
    const key = `${host}:${port}`;
    if (this.clients.has(key)) {
      return this.clients.get(key)!;
    }
    if (!this.port) throw new Error('You can not connect to a server without a local port, please use `.setPort(port)` for local port.');
    let pending = this.pendingConnections.get(key);
    if (!pending) {
      const controller = new AbortController();
      const promise = this.openConnection(host, port, controller.signal)
        .then(ws => this.createClient(ws, host, port))
        .finally(() => { this.pendingConnections.delete(key); });
      promise.catch(() => undefined);
      pending = { promise, controller, waiters: 0 };
      this.pendingConnections.set(key, pending);
    }
    pending.waiters++;
    try {
      return await this.waitForConnection(pending.promise, timeout, signal);
    } finally {
      pending.waiters--;
      if (pending.waiters === 0 && this.pendingConnections.get(key) === pending) pending.controller.abort();
    }
  }

  private openConnection(host: string, port: number, signal: AbortSignal) {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/${this.announceHost}/${this.port}/${this.namespace}`);
      const clear = () => {
        ws.off('open', onopen);
        ws.off('error', onerror);
        signal.removeEventListener('abort', onabort);
      };
      const terminate = () => {
        clear();
        ws.on('error', () => { });
        try { ws.terminate(); } catch { }
      }
      const onerror = (err: Error) => {
        clear();
        reject(err);
      };
      const onabort = () => {
        reject(signal.reason ?? new Error('Connection aborted'));
        terminate();
      };
      const onopen = () => {
        clear();
        resolve(ws);
      };
      ws.on('open', onopen);
      ws.on('error', onerror);
      signal.addEventListener('abort', onabort, { once: true });
    });
  }

  private waitForConnection(promise: Promise<Client>, timeout: number, signal?: AbortSignal): Promise<Client> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Connection aborted'));
    return new Promise<Client>((resolve, reject) => {
      const timer = Number.isFinite(timeout) && timeout > 0
        ? setTimeout(() => finish(reject, new Error('Connection timeout')), timeout).unref()
        : undefined;
      const onabort = () => finish(reject, signal?.reason ?? new Error('Connection aborted'));
      const finish = (settle: (value: any) => void, value: any) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onabort);
        settle(value);
      };
      signal?.addEventListener('abort', onabort, { once: true });
      promise.then(client => finish(resolve, client), error => finish(reject, error));
    });
  }

  public async listen(port: number = 0) {
    if (port > 0) {
      const wss = new WebSocketServer({ port });
      this.wss = await new Promise<WebSocketServer>((resolve, reject) => {
        const clear = () => {
          wss.off('error', onerror);
          wss.off('listening', onlistening);
        }
        const onerror = (err: Error) => {
          clear();
          reject(err);
        };
        const onlistening = () => {
          clear();
          resolve(wss);
        };
        wss.on('error', onerror);
        wss.on('listening', onlistening);
      });
      this.wss!.on('connection', (ws: WebSocket, req: IncomingMessage) => this.upstream(ws, req));
      this.setPort(port);
    } else {
      this.wss = new WebSocketServer({ noServer: true });
    }

    return async () => {
      for (const pending of this.pendingConnections.values()) pending.controller.abort();
      await Promise.allSettled([...this.pendingConnections.values()].map(item => item.promise));
      this.pendingConnections.clear();
      if (this.wss) {
        // terminate 立即销毁 socket，不等待对端 close frame
        // 避免 graceful close 时对端无响应导致 HTTP server 无法关闭
        for (const ws of [...this.wss.clients]) {
          ws.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          this.wss!.close((err) => {
            if (err) return reject(err);
            resolve();
          });
        })
      }
      const toDispose = [...this.clients.entries()];
      for (const [key, client] of toDispose) {
        const extras = this.clientExtras.get(key) ?? [];
        this.clients.delete(key);
        this.clientExtras.delete(key);
        client.dispose();
        this.events.emit('disconnect', client, extras);
      }
      this.clients.clear();
      this.clientExtras.clear();
      this.wss = undefined;
      this.port = undefined;
    }
  }

  public setPort(port: number) {
    this.port = port;
    return this;
  }

  public handleUpgrade(
    req: IncomingMessage, socket: Duplex, head: Buffer
  ) {
    if (!this.wss) throw new Error('WebSocket server not initialized');
    this.wss!.handleUpgrade(req, socket, head, ws => {
      this.upstream(ws, req);
    });
    return this;
  }
}
