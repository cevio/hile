import { WebSocketServer } from 'ws';
import { MessageLoader, MessageLoaderProps } from "@hile/message-loader";
import { WebSocket } from 'ws';
import { Client } from './client';
import { IncomingMessage } from 'http';
import { getLocalIPv4 } from './utils';
import { EventEmitter } from 'node:events';
import type { Duplex } from "node:stream";

const DEFAULT_CONNECT_TIMEOUT = 5000;

/** {@link MessageLoaderProps} 加上出站 WebSocket 宣告地址 */
export type MicroServerProps = MessageLoaderProps & {
  /**
   * 出站连接 URL 中 `ws://{host}:{port}/{本段}/...` 的「本段」宣告地址。
   * 缺省使用 `getLocalIPv4()`；若仍为 `undefined`（无可用 IPv4）则构造 {@link Server} 时抛错。
   */
  advertiseHost?: string;
};

export class Server extends MessageLoader {
  private wss?: WebSocketServer;
  public port?: number;
  protected readonly clients = new Map<string, Client>();
  private readonly announceHost: string;
  public readonly events = new EventEmitter();

  get host() {
    return this.announceHost;
  }

  constructor(private readonly namespace: string, props: MicroServerProps = {}) {
    const { advertiseHost, ...loaderProps } = props;
    super(loaderProps);
    const resolved = advertiseHost?.trim() || getLocalIPv4();
    if (!resolved) {
      throw new Error(
        'Unable to resolve advertise host for @hile/micro Server: pass `advertiseHost` (e.g. "127.0.0.1") in constructor options, or ensure getLocalIPv4() returns an address.',
      );
    }
    this.announceHost = resolved;
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
      this.clients.delete(key);
      previous.dispose();
    }
    const client = new Client({ server: this, ws, host, port });
    ws.on('close', () => {
      if (this.clients.get(key) === client) {
        this.clients.delete(key);
      }
      client.dispose();
      this.events.emit('disconnect', client, extras);
    });
    this.clients.set(key, client);
    this.events.emit('connect', client, extras);
    return client;
  }

  protected async connect(host: string, port: number, timeout = DEFAULT_CONNECT_TIMEOUT) {
    const key = `${host}:${port}`;
    if (this.clients.has(key)) {
      return this.clients.get(key)!;
    }
    if (!this.port) throw new Error('You can not connect to a server without a local port, please use `.setPort(port)` for local port.');
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/${this.announceHost}/${this.port}/${this.namespace}`);
      const timer = setTimeout(() => {
        clear();
        ws.on('error', () => { });
        try {
          ws.terminate();
        } catch { }
        reject(new Error('Connection timeout'));
      }, timeout).unref();
      const clear = () => {
        clearTimeout(timer);
        ws.off('open', onopen);
        ws.off('error', onerror);
      }
      const onerror = (err: Error) => {
        clear();
        reject(err);
      };
      const onopen = () => {
        clear();
        resolve(ws);
      };
      ws.on('open', onopen);
      ws.on('error', onerror);
    })
    return this.createClient(ws, host, port);
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
      const toDispose = [...this.clients.values()];
      for (const client of toDispose) {
        client.dispose();
      }
      this.clients.clear();
      if (this.wss) {
        await new Promise<void>((resolve, reject) => {
          this.wss!.close((err) => {
            if (err) return reject(err);
            resolve();
          });
        })
      }
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
