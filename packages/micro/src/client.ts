import { MessageWs } from "@hile/message-ws";
import { Server } from './server';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

export interface ClientProps {
  host: string;
  port: number;
  server: Server;
  ws: WebSocket;
}

export class Client extends MessageWs {
  private readonly server: Server;
  private readonly socket: WebSocket;
  public readonly host: string;
  public readonly port: number;
  private _online = true;
  private lastHeartbeat = Date.now();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private checkTimer?: ReturnType<typeof setInterval>;
  public readonly events = new EventEmitter();

  constructor(props: ClientProps) {
    const { server, ws, host, port } = props;
    super(ws);
    this.server = server;
    this.socket = ws;
    this.host = host;
    this.port = port;
    this.events.on('connect', () => this._online = true);
    this.events.on('disconnect', () => this._online = false);
    this.lastHeartbeat = Date.now();
    this.startHeartbeat();
  }

  private startHeartbeat() {
    const interval = Number(process.env.MICRO_HEARTBEAT_INTERVAL) || 10_000;
    const timeout = Number(process.env.MICRO_HEARTBEAT_TIMEOUT) || 20_000;
    const checkInterval = Number(process.env.MICRO_HEARTBEAT_CHECK_INTERVAL) || 5_000;

    this.heartbeatTimer = setInterval(() => {
      try {
        this._push({ url: '/-/heartbeat', data: {} });
      } catch {
        // connection closed — will be cleaned up by checkTimer or close event
      }
    }, interval);

    this.checkTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > timeout) {
        this.dispose();
      }
    }, checkInterval);
  }

  protected async exec(data: { url: string; data: any }): Promise<any> {
    if (data.url === '/-/heartbeat') {
      this.lastHeartbeat = Date.now();
      return;
    }
    if (!this._online) throw new Error('Client is not online');
    return this.server.dispatch(data.url, data.data, {
      client: this,
    });
  }

  public request<T = any>(url: string, data: any, options?: { timeout?: number; signal?: AbortSignal }) {
    if (!this._online) throw new Error('Client is not online');
    return this._send<T>({ url, data }, options);
  }

  public push(url: string, data: any, options?: { timeout?: number; signal?: AbortSignal }) {
    if (!this._online) throw new Error('Client is not online');
    return this._push({ url, data }, options);
  }

  public stream(url: string, data: any, options?: { signal?: AbortSignal }) {
    if (!this._online) throw new Error('Client is not online');
    return this._stream({ url, data }, options);
  }

  public dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.checkTimer) clearInterval(this.checkTimer);
    super.dispose();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}