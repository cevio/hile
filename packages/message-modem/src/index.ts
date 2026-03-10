import { AbortException, Exception, TimeoutException } from "./exception";
export * from './exception';
export enum MESSAGE_MODEM_TYPE {
  REQUEST,
  RESPONSE,
  ABORT,
}

export interface MessageTransferFormat<T = any> {
  id: number,
  mode: MESSAGE_MODEM_TYPE,
  twoway: boolean,
  data?: T
}

export interface MessageReturnFormat<T = any> {
  status: string | number,
  data: T,
  message: string,
}

export abstract class MessageModem {
  private id = 0;

  private readonly aborts = new Map<number, (reason?: any) => void>();
  private readonly stacks = new Map<number, {
    resolve: (value?: any) => void,
    reject: (reason?: any) => void
  }>();

  /**
   * 创建自增 ID
   * 超过最大安全整数时重置为 0
   * @returns 
   */
  private createIncrementId() {
    let id = this.id++;
    if (this.id >= Number.MAX_SAFE_INTEGER) {
      id = this.id = 0;
    }
    return id;
  }

  /**
   * 如何发送消息到远端
   * @param data - 消息数据
   */
  protected abstract post<T = any>(data: MessageTransferFormat<T>): void;

  /**
   * 如何执行消息
   * @param data - 消息数据
   * @returns 
   */
  protected abstract exec(data: any): Promise<any>;

  /**
   * 创建发送消息数据
   * @param mode - 消息类型
   * @param data - 消息数据
   * @returns 消息数据
   */
  private createPostData<T = any>(mode: MESSAGE_MODEM_TYPE, data?: T, twoway = true) {
    const id = this.createIncrementId();
    const state: MessageTransferFormat<T> = {
      id, twoway, data, mode,
    }
    if (mode === MESSAGE_MODEM_TYPE.ABORT) {
      state.twoway = false;
    }
    return state;
  }

  /**
   * 发送消息
   * @param data - 消息数据
   * @param timeout - 超时时间
   * @returns 消息响应
   */
  protected _send<T = any>(data: T, timeout = 30000) {
    return this._write(data, timeout, true);
  }

  /**
   * 推送消息
   * @param data - 消息数据
   * @param timeout - 超时时间
   * @returns 消息响应
   */
  protected _push<T = any>(data: T, timeout = 30000) {
    return this._write(data, timeout, false);
  }

  /**
   * 写入消息
   * @param data - 消息数据
   * @param timeout - 超时时间
   * @returns 消息响应
   */
  private _write<T = any>(data: T, timeout = 30000, twoway = false) {
    const controller = new AbortController();
    // 创建请求消息数据
    const state = this.createPostData(MESSAGE_MODEM_TYPE.REQUEST, data, twoway);
    // 发送消息
    this.post(state);
    return {
      // 终止请求
      abort: () => controller.abort(),
      // 等待响应
      response: <U = any>() => new Promise<U>((resolve, reject) => {
        // 清理 stacks
        const clear = () => {
          if (this.stacks.has(state.id)) {
            this.stacks.delete(state.id);
          }
        }

        const clean = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', aborthandler);
          clear();
        }

        // Abort 处理函数
        const aborthandler = () => {
          clearTimeout(timer);
          this.post(this.createPostData(MESSAGE_MODEM_TYPE.ABORT, state.id));
          clear();
          reject(new AbortException());
        }

        // 成功处理
        const _resolve = (data: U) => {
          clean();
          resolve(data);
        }

        // 失败处理
        const _reject = (e: any) => {
          clean();
          reject(e);
        }

        // 超时处理
        const timer = setTimeout(() => {
          if (!controller.signal.aborted) {
            controller.abort();
          } else {
            _reject(new TimeoutException());
          }
        }, timeout);

        // 添加 Abort 处理函数
        controller.signal.addEventListener('abort', aborthandler);

        // 添加栈
        this.stacks.set(state.id, {
          resolve: _resolve,
          reject: _reject,
        });
      })
    }
  }

  /**
   * 处理请求消息
   * @param msg - 消息数据
   */
  private onRequest<T = any>(msg: MessageTransferFormat<T>) {
    // 执行消息
    // 使用 Promise.race 处理消息执行和 Abort 处理
    Promise.race([
      this.exec(msg.data).catch(e => ({ e })),
      new Promise((_, reject) => this.aborts.set(msg.id, reject)),
    ]).then(value => {
      // 如果消息执行失败
      if (value?.e) {
        // 如果消息是双向的，则发送响应消息
        if (msg.twoway) {
          this.post({
            id: msg.id,
            mode: MESSAGE_MODEM_TYPE.RESPONSE,
            twoway: false,
            data: {
              status: value.e instanceof Exception ? value.e.status : 500,
              data: null,
              message: value.e.message,
            }
          })
        }
      } else {
        // 如果消息是双向的，则发送响应消息
        if (msg.twoway) {
          this.post({
            id: msg.id,
            mode: MESSAGE_MODEM_TYPE.RESPONSE,
            twoway: false,
            data: {
              status: 200,
              data: value,
            }
          })
        }
      }
    }).catch(e => {
      if (e instanceof AbortException) return;
      // 如果消息是双向的，则发送响应消息
      if (msg.twoway) {
        // 发送响应消息
        const code = e instanceof Exception ? e.status : 500;
        this.post({
          id: msg.id,
          mode: MESSAGE_MODEM_TYPE.RESPONSE,
          twoway: false,
          data: {
            status: code,
            data: null,
            message: e.message,
          }
        })
      }
    }).finally(() => {
      // 删除 Abort 处理函数
      if (this.aborts.has(msg.id)) {
        this.aborts.delete(msg.id);
      }
      // 清理栈
      if (this.stacks.has(msg.id)) {
        this.stacks.delete(msg.id);
      }
    });
  }

  /**
   * 处理响应消息
   * @param msg - 消息数据
   */
  private onResponse<T = any>(msg: MessageTransferFormat<MessageReturnFormat<T>>) {
    const id = msg.id;
    const res = msg.data;
    // 如果栈中存在该消息，则处理响应消息
    if (this.stacks.has(id)) {
      const { resolve, reject } = this.stacks.get(id)!;
      // 如果响应状态码不是 200，则拒绝响应
      if (res?.status !== 200) {
        reject(new Exception(res?.status!, res?.message!));
      } else {
        resolve(res?.data);
      }
    }
  }

  /**
   * 接收消息
   * @param msg - 消息数据
   */
  public receive(msg: MessageTransferFormat) {
    // 根据消息类型处理消息
    switch (msg.mode) {
      // 处理请求消息
      case MESSAGE_MODEM_TYPE.REQUEST:
        this.onRequest(msg);
        break;
      // 处理响应消息
      case MESSAGE_MODEM_TYPE.RESPONSE:
        this.onResponse(msg);
        break;
      // 处理终止消息
      case MESSAGE_MODEM_TYPE.ABORT:
        const id: number = msg.data as number;
        if (this.aborts.has(id)) {
          const reject = this.aborts.get(id);
          reject!(new AbortException());
          break;
        }
    }
  }
}