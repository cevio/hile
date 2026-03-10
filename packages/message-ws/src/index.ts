import { MessageModem, type MessageTransferFormat } from '@hile/message-modem';
import type WebSocket from 'ws';

/**
 * 基于 `ws` 模块的 WebSocket 通信层。
 * exec 方法由子类实现，本类不做实现。
 *
 * 构造时传入已连接的 WebSocket 实例，自动绑定 message 事件。
 * 消息通过 JSON 序列化/反序列化传输。
 *
 * @example
 * class MyWs extends MessageWs {
 *   protected exec(data: any): Promise<any> {
 *     return Promise.resolve(data);
 *   }
 * }
 *
 * const ws = new WebSocket('ws://localhost:8080');
 * ws.on('open', () => {
 *   const modem = new MyWs(ws);
 *   modem.request('hello').response().then(console.log);
 * });
 */
export abstract class MessageWs extends MessageModem {
  private readonly ws: WebSocket;
  private readonly listener: (data: WebSocket.RawData) => void;

  constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    this.listener = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.receive(msg);
      } catch { }
    };
    this.ws.on('message', this.listener);
  }

  protected post<T = any>(data: MessageTransferFormat<T>): void {
    if (this.ws.readyState !== this.ws.OPEN) {
      throw new Error('WebSocket is not open. Current readyState: ' + this.ws.readyState);
    }
    this.ws.send(JSON.stringify(data));
  }

  /**
   * 移除消息监听，释放资源
   */
  public dispose(): void {
    this.ws.removeListener('message', this.listener);
  }
}
