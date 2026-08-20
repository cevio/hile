import { MessageModem, type MessageTransferFormat } from '@hile/message-modem';
import type WebSocket from 'ws';
import { decodeMessageFrame, encodeMessageFrame } from './codec';

export * from './codec';

/**
 * 基于 `ws` 模块的 WebSocket 通信层。
 * exec 方法由子类实现，本类不做实现。
 *
 * 构造时传入已连接的 WebSocket 实例，自动绑定 message 事件。
 * 普通消息通过 JSON 传输；二进制 stream response 使用 Hile 二进制帧，避免 Base64 开销。
 *
 * @example
 * class MyWs extends MessageWs {
 *   protected exec(data: any): Promise<any> {
 *     return Promise.resolve(data);
 *   }
 * }
 *
 * const ws = new WebSocket('ws://localhost:8080');
 * ws.on('open', async () => {
 *   const modem = new MyWs(ws);
 *   const result = await modem.request('hello');
 *   console.log(result);
 * });
 */
export abstract class MessageWs extends MessageModem {
  private readonly ws: WebSocket;
  private readonly listener: (data: WebSocket.RawData, isBinary: boolean) => void;

  constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    this.listener = (raw: WebSocket.RawData, isBinary: boolean) => {
      try {
        // ws owns RawData for the lifetime of the emitted message and does not
        // mutate it afterwards, so Flight payloads can safely remain views.
        const msg = decodeMessageFrame(raw, isBinary, { copyBinaryPayload: false });
        this.receive(msg);
      } catch {
        // A malformed protocol frame is fatal. Keeping the connection alive would
        // hide peer incompatibility and can leave pending requests unresolved.
        this.ws.close(1002, 'Invalid Hile message frame');
      }
    };
    this.ws.on('message', this.listener);
  }

  protected post<T = any>(data: MessageTransferFormat<T>): void {
    if (this.ws.readyState !== this.ws.OPEN) {
      throw new Error('WebSocket is not open. Current readyState: ' + this.ws.readyState);
    }
    this.ws.send(encodeMessageFrame(data));
  }

  /**
   * 移除消息监听，释放资源
   */
  public dispose(): void {
    this._dispose();
    this.ws.removeListener('message', this.listener);
  }
}
