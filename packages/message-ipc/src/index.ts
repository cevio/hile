import { MessageModem, type MessageTransferFormat } from '@hile/message-modem';
import type { ChildProcess } from 'node:child_process';

export type IpcExecHandler = (data: any) => Promise<any>;

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
    this.listener = (msg: any) => this.receive(msg);
    this.channel.on('message', this.listener);
  }

  protected post<T = any>(data: MessageTransferFormat<T>): void {
    const ch = this.channel as NodeJS.Process;
    if (typeof ch.send !== 'function') {
      throw new Error('IPC channel is not available. Ensure the process was forked with an IPC channel.');
    }
    ch.send(data);
  }

  /**
   * 向对端发送请求
   */
  public request<T = any>(data: T, timeout?: number) {
    return this.send(data, timeout);
  }

  /**
   * 移除消息监听，释放资源
   */
  public dispose(): void {
    this.channel.removeListener('message', this.listener);
  }
}
