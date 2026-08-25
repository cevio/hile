import { MessageWs } from "@hile/message-ws";
import {
  createInvocationContext,
  MissingExecutionContextError,
  parseExecutionContext,
  type ContextValues,
  type ExecutionContext,
  type InvocationContext,
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

export interface ClientStreamOptions {
  context: ExecutionContext;
  signal?: AbortSignal;
  timeout?: number;
  idleTimeout?: number;
  window?: number;
}

export type MicroMessageMetadata = {
  context?: ExecutionContext;
  control?: true;
  [key: string]: unknown;
};

export type MicroMessage<T = any> = {
  url: string;
  data: T;
  metadata?: MicroMessageMetadata;
};

const FRAMEWORK_CONTROL_ROUTES = new Set([
  '/-/config/get',
  '/-/configs',
  '/-/declare',
  '/-/find',
  '/-/namespace/peers',
  '/-/namespaces',
  '/-/registry/status',
  '/-/subscribe',
  '/-/topic/get',
  '/-/topic/snapshots',
  '/-/topic/update',
  '/-/topics',
  '/-/undeclare',
  '/-/unsubscribe',
]);

function assertFrameworkControlRoute(url: string): void {
  if (!FRAMEWORK_CONTROL_ROUTES.has(url)) {
    throw new TypeError(`Unknown framework control route: ${url}`);
  }
}

function createEnvelope<T = any>(url: string, data: T, context: ExecutionContext): MicroMessage<T> {
  return {
    url,
    data,
    metadata: {
      context: parseExecutionContext(context),
    },
  };
}

function createControlEnvelope<T = any>(url: string, data: T): MicroMessage<T> {
  assertFrameworkControlRoute(url);
  return { url, data, metadata: { control: true } };
}

function getEnvelopeContext(data: MicroMessage): ExecutionContext | undefined {
  const context = data.metadata?.context;
  return context === undefined ? undefined : parseExecutionContext(context);
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

  protected async exec(data: MicroMessage, signal?: AbortSignal): Promise<any> {
    if (data.url === '/-/heartbeat') {
      this.lastHeartbeat = Date.now();
      return;
    }
    if (!this._online) throw new Error('Client is not online');
    const context = getEnvelopeContext(data);
    const isControl = data.metadata?.control === true && FRAMEWORK_CONTROL_ROUTES.has(data.url);
    if (!context && !isControl) {
      throw new MissingExecutionContextError(`inbound micro message ${data.url}`);
    }
    const invocation: InvocationContext<ContextValues> | undefined = context
      ? createInvocationContext(
        context,
        signal ?? new AbortController().signal,
        `inbound micro message ${data.url}`,
      )
      : undefined;
    return this.server.dispatch(data.url, data.data, {
      client: this,
      metadata: data.metadata,
      signal,
      invocation,
    });
  }

  public request<T = any>(url: string, data: any, options: {
    context: ExecutionContext;
    timeout?: number;
    signal?: AbortSignal;
  }) {
    if (!this._online) throw new Error('Client is not online');
    if (!options?.context) throw new MissingExecutionContextError(`micro client request ${url}`);
    const { context, ...transport } = options;
    return this._send<T>(createEnvelope(url, data, context), transport);
  }

  /** Framework-internal transport path. Business requests must use request() with context. */
  public requestControl<T = any>(
    url: string,
    data: any,
    options?: { timeout?: number; signal?: AbortSignal },
  ) {
    if (!this._online) throw new Error('Client is not online');
    return this._send<T>(createControlEnvelope(url, data), options);
  }

  public push(url: string, data: any, options: {
    context: ExecutionContext;
    timeout?: number;
    signal?: AbortSignal;
  }) {
    if (!this._online) throw new Error('Client is not online');
    if (!options?.context) throw new MissingExecutionContextError(`micro client push ${url}`);
    const { context, ...transport } = options;
    return this._push(createEnvelope(url, data, context), transport);
  }

  /** Framework-internal transport path. Business pushes must use push() with context. */
  public pushControl(url: string, data: any, options?: { timeout?: number; signal?: AbortSignal }) {
    if (!this._online) throw new Error('Client is not online');
    return this._push(createControlEnvelope(url, data), options);
  }

  public stream(url: string, data: any, options: ClientStreamOptions) {
    if (!this._online) throw new Error('Client is not online');
    if (!options?.context) throw new MissingExecutionContextError(`micro client stream ${url}`);
    const { context, ...transport } = options;
    return this._stream(createEnvelope(url, data, context), transport);
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
