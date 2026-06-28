import { MessageModem, type MessageTransferFormat } from '@hile/message-modem';
import { parentPort, type Worker, type MessagePort } from 'node:worker_threads';

/**
 * 支持主线程和 Worker 线程双端使用的 worker_threads 通信层。
 * exec 方法由子类实现，本类不做实现。
 *
 * - Worker 线程端：不传参数，自动绑定 parentPort
 * - 主线程端：传入 new Worker() 返回的 Worker 实例（或 MessagePort）
 *
 * @example
 * class MyWorkerThread extends MessageWorkerThread {
 *   protected exec(data: any): Promise<any> {
 *     return Promise.resolve(data);
 *   }
 * }
 *
 * // 主线程
 * const worker = new Worker('./worker.js');
 * const wt = new MyWorkerThread(worker);
 * const res = await wt.request('hello');
 * wt.dispose();
 * await worker.terminate();
 *
 * // Worker 线程
 * const wt = new MyWorkerThread();
 */
export abstract class MessageWorkerThread extends MessageModem {
  private readonly port: Worker | MessagePort;
  private readonly listener: (msg: any) => void;

  constructor(port?: Worker | MessagePort) {
    super();
    if (port) {
      this.port = port;
    } else {
      if (!parentPort) {
        throw new Error('parentPort is not available. Ensure this code runs inside a Worker thread.');
      }
      this.port = parentPort;
    }
    this.listener = (msg: any) => this.receive(msg);
    this.port.on('message', this.listener);
  }

  protected post<T = any>(data: MessageTransferFormat<T>): void {
    this.port.postMessage(data, []);
  }

  /**
   * 移除消息监听，释放资源
   */
  public dispose(): void {
    this._dispose();
    this.port.removeListener('message', this.listener);
  }
}
