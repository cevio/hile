import {
  MessageModem,
  MESSAGE_MODEM_TYPE,
  type MessageStreamChunk,
  type MessageTransferFormat,
} from '@hile/message-modem';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

export type IpcExecHandler = (
  data: any,
  signal?: AbortSignal,
  input?: Readable,
) => Promise<any>;

const IPC_BINARY_FRAME = '@hile/message-ipc:binary-v1';

type IpcBinaryFrame = {
  type: typeof IPC_BINARY_FRAME;
  message: MessageTransferFormat;
  payload: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encodeIpcMessage(message: MessageTransferFormat): MessageTransferFormat | IpcBinaryFrame {
  const chunk = message.data as MessageStreamChunk<unknown> | undefined;
  const payload = chunk?.payload;
  if (
    message.mode !== MESSAGE_MODEM_TYPE.STREAM_DATA
    || !chunk
    || (chunk.direction !== 'input' && chunk.direction !== 'output')
    || (!(payload instanceof Uint8Array) && !(payload instanceof ArrayBuffer))
  ) return message;

  const { payload: _payload, ...chunkHeader } = chunk;
  return {
    type: IPC_BINARY_FRAME,
    message: { ...message, data: chunkHeader },
    payload: Buffer.from(
      payload instanceof ArrayBuffer
        ? payload
        : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    ).toString('base64'),
  };
}

function decodeIpcMessage(value: unknown): MessageTransferFormat {
  if (
    !isRecord(value)
    || value.type !== IPC_BINARY_FRAME
    || !isRecord(value.message)
    || typeof value.payload !== 'string'
    || !isRecord(value.message.data)
  ) return value as MessageTransferFormat;

  return {
    ...value.message,
    data: {
      ...value.message.data,
      payload: Buffer.from(value.payload, 'base64'),
    },
  } as MessageTransferFormat;
}

/**
 * 支持父进程和子进程双端使用的 IPC 通信层。
 * exec方法实现由子类实现，本实例不做实现
 *
 * - 子进程端：不传参数，自动绑定 process.on('message') / process.send()
 * - 父进程端：传入 fork() 返回的 ChildProcess 实例
 * 
 * @example
 * class MyIpc extends MessageIpc {
 *   protected exec(data: any): Promise<any> {
 *     return Promise.resolve(data);
 *   }
 * }
 *
 * const ipc = new MyIpc();
 * ipc.request('hello').then((res) => {
 *   console.log(res);
 * });
 * ipc.dispose();
 */
export abstract class MessageIpc extends MessageModem {
  private readonly channel: ChildProcess | NodeJS.Process;
  private readonly listener: (msg: any) => void;

  constructor(channel?: ChildProcess) {
    super();
    this.channel = channel ?? process;
    this.listener = (msg: any) => this.receive(decodeIpcMessage(msg));
    this.channel.on('message', this.listener);
  }

  protected post<T = any>(data: MessageTransferFormat<T>): void {
    const ch = this.channel as NodeJS.Process;
    if (typeof ch.send !== 'function') {
      throw new Error('IPC channel is not available. Ensure the process was forked with an IPC channel.');
    }
    ch.send(encodeIpcMessage(data));
  }

  /**
   * 移除消息监听，释放资源
   */
  public dispose(): void {
    this._dispose();
    this.channel.removeListener('message', this.listener);
  }
}
