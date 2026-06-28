import { MessageWs } from "@hile/message-ws";
import {
  isContextData,
  runWithContext,
  snapshotContext,
  type ContextData,
  type ContextInput,
} from '@hile/context';
import { Server } from './server';
import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';

export interface ClientProps {
  host: string;
  port: number;
  server: Server;
  ws: WebSocket;
}

export type MicroMessageMetadata = {
  context?: ContextInput<ContextData>;
  [key: string]: unknown;
};

export type MicroMessage<T = any> = {
  url: string;
  data: T;
  metadata?: MicroMessageMetadata;
};

function createEnvelope<T = any>(url: string, data: T): MicroMessage<T> {
  const context = snapshotContext();
  if (Object.keys(context).length === 0) return { url, data };
  return {
    url,
    data,
    metadata: {
      context,
    },
  };
}

function getEnvelopeContext(data: MicroMessage): ContextInput<ContextData> | undefined {
  const context = data.metadata?.context;
  if (!isContextData(context)) return undefined;
  return context;
}

function isAsyncIterable<T = any>(value: unknown): value is AsyncIterable<T> {
  return value != null && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function';
}

function bindAsyncIterableToContext<T>(
  iterable: AsyncIterable<T>,
  context: ContextInput<ContextData>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]();
      return {
        next() {
          return Promise.resolve(
            runWithContext<ContextData, Promise<IteratorResult<T>> | IteratorResult<T>>(
              context,
              () => iterator.next(),
            ),
          );
        },
        return(value?: unknown) {
          if (!iterator.return) {
            return Promise.resolve({ done: true, value } as IteratorResult<T>);
          }
          return Promise.resolve(
            runWithContext<ContextData, Promise<IteratorResult<T>> | IteratorResult<T>>(
              context,
              () => iterator.return!(value),
            ),
          );
        },
        throw(error?: unknown) {
          if (!iterator.throw) {
            return Promise.reject(error);
          }
          return Promise.resolve(
            runWithContext<ContextData, Promise<IteratorResult<T>> | IteratorResult<T>>(
              context,
              () => iterator.throw!(error),
            ),
          );
        },
      };
    },
  };
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

  protected async exec(data: MicroMessage): Promise<any> {
    if (data.url === '/-/heartbeat') {
      this.lastHeartbeat = Date.now();
      return;
    }
    if (!this._online) throw new Error('Client is not online');
    const context = getEnvelopeContext(data);
    const dispatch = async () => {
      const result = await this.server.dispatch(data.url, data.data, {
        client: this,
        metadata: data.metadata,
      });
      if (context && isAsyncIterable(result)) {
        return bindAsyncIterableToContext(result, context);
      }
      return result;
    };

    if (context) return runWithContext(context, dispatch);
    return dispatch();
  }

  public request<T = any>(url: string, data: any, options?: { timeout?: number; signal?: AbortSignal }) {
    if (!this._online) throw new Error('Client is not online');
    return this._send<T>(createEnvelope(url, data), options);
  }

  public push(url: string, data: any, options?: { timeout?: number; signal?: AbortSignal }) {
    if (!this._online) throw new Error('Client is not online');
    return this._push(createEnvelope(url, data), options);
  }

  public stream(url: string, data: any, options?: { signal?: AbortSignal }) {
    if (!this._online) throw new Error('Client is not online');
    return this._stream(createEnvelope(url, data), options);
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
