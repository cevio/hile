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
  public readonly host: string;
  public readonly port: number;
  private _online = true;
  public readonly events = new EventEmitter();

  constructor(props: ClientProps) {
    const { server, ws, host, port } = props;
    super(ws);
    this.server = server;
    this.host = host;
    this.port = port;
    this.events.on('connect', () => this._online = true);
    this.events.on('disconnect', () => this._online = false);
  }

  protected async exec(data: { url: string; data: any }): Promise<any> {
    if (!this._online) throw new Error('Client is not online');
    return this.server.dispatch(data.url, data.data, {
      client: this,
    });
  }

  public request(url: string, data: any, timeout?: number) {
    if (!this._online) throw new Error('Client is not online');
    return this._send({ url, data }, timeout);
  }

  public push(url: string, data: any, timeout?: number) {
    if (!this._online) throw new Error('Client is not online');
    return this._push({ url, data }, timeout);
  }
}