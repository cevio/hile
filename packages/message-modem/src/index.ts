import { AbortException, Exception, TimeoutException } from "./exception";
import { Readable } from 'node:stream';
export * from './exception';
export enum MESSAGE_MODEM_TYPE {
  REQUEST,
  RESPONSE,
  ABORT,
  STREAM_CREDIT,
}

export interface MessageTransferFormat<T = any> {
  id: number,
  mode: MESSAGE_MODEM_TYPE,
  twoway: boolean,
  stream?: boolean,
  streamVersion?: 1,
  data?: T
}

export interface MessageReturnFormat<T = any> {
  status: string | number,
  data: T,
  message: string,
}

export interface MessageStreamChunk<T = any> {
  status: string | number,
  seq: number,
  payload: T,
  final: boolean,
}

interface StreamConsumerState {
  stream: Readable;
  completed: boolean;
  cancelled: boolean;
  creditOwed: boolean;
  nextSeq: number;
}

interface StreamProducerState {
  credits: number;
  nextCreditSeq: number;
  wake?: () => void;
  iterator?: AsyncIterator<any>;
}

class CreditReadable extends Readable {
  constructor(private readonly onConsumed: () => void) {
    super({ objectMode: true });
  }

  override _read(): void {
    // Credits are tied to actual read() results, not Node's eager buffer filling.
  }

  override read(size?: number): any {
    const chunk = super.read(size);
    if (chunk !== null) this.onConsumed();
    return chunk;
  }
}

export abstract class MessageModem {
  private id = 0;

  private readonly aborts = new Map<number, AbortController>();
  private readonly stacks = new Map<number, {
    resolve: (value?: any) => void,
    reject: (reason?: any) => void
  }>();

  private readonly streams = new Map<number, StreamConsumerState>();
  private readonly streamProducers = new Map<number, StreamProducerState>();

  protected _dispose() {
    for (const { reject } of this.stacks.values()) {
      reject(new AbortException());
    }
    for (const controller of this.aborts.values()) {
      controller.abort();
    }
    for (const { stream } of this.streams.values()) {
      stream.destroy(new AbortException());
    }
    for (const producer of this.streamProducers.values()) {
      producer.wake?.();
    }
    this.aborts.clear();
    this.stacks.clear();
    this.streams.clear();
    this.streamProducers.clear();
  }

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
  protected abstract exec(data: any, signal?: AbortSignal): Promise<any>;

  /**
   * 创建发送消息数据
   * @param mode - 消息类型
   * @param data - 消息数据
   * @returns 消息数据
   */
  private createPostData<T = any>(mode: MESSAGE_MODEM_TYPE, data?: T, twoway = true, stream = false) {
    const id = this.createIncrementId();
    const state: MessageTransferFormat<T> = {
      id, twoway, data, mode, stream,
    }
    if (mode === MESSAGE_MODEM_TYPE.ABORT) {
      state.twoway = false;
      state.stream = false;
    }
    return state;
  }

  /**
   * 发送消息
   * @param data - 消息数据
   * @param timeout - 超时时间
   * @param signal - 中止信号
   * @returns 消息响应
   */
  protected _send<T = any>(data: any, options?: {
    timeout?: number,
    signal?: AbortSignal,
  }) {
    return this._write<T>(data, {
      timeout: options?.timeout ?? 30000,
      twoway: true,
      signal: options?.signal,
    })!;
  }

  /**
   * 推送消息
   * @param data - 消息数据
   * @param timeout - 超时时间
   * @param signal - 中止信号
   * @returns 消息响应
   */
  protected _push<T = any>(data: T, options?: {
    timeout?: number,
    signal?: AbortSignal,
  }): void {
    this._write(data, {
      timeout: options?.timeout ?? 30000,
      twoway: false,
      signal: options?.signal,
    });
  }

  protected _stream(data: any, options?: {
    signal?: AbortSignal,
  }) {
    const state = this.createPostData(MESSAGE_MODEM_TYPE.REQUEST, data, true, true);
    state.streamVersion = 1;
    let consumer!: StreamConsumerState;
    const stream = new CreditReadable(() => {
        if (!consumer.creditOwed || consumer.completed || consumer.cancelled) return;
        consumer.creditOwed = false;
        try {
          this.post(this.createPostData(
            MESSAGE_MODEM_TYPE.STREAM_CREDIT,
            { id: state.id, seq: consumer.nextSeq - 1 },
            false,
          ));
        } catch (error) {
          consumer.cancelled = true;
          stream.destroy(error as Error);
        }
    });
    consumer = {
      stream,
      completed: false,
      cancelled: false,
      creditOwed: false,
      nextSeq: 0,
    };
    const sendAbort = () => {
      if (consumer.completed || consumer.cancelled) return;
      consumer.cancelled = true;
      try {
        this.post(this.createPostData(MESSAGE_MODEM_TYPE.ABORT, state.id));
      } catch {
        // The transport may already be closed.
      }
    };
    const onAbort = () => {
      sendAbort();
      stream.destroy(new AbortException());
    };
    if (options?.signal?.aborted) {
      consumer.cancelled = true;
      queueMicrotask(() => stream.destroy(new AbortException()));
      return stream;
    }
    this.streams.set(state.id, consumer);
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('close', () => {
      sendAbort();
      if (this.streams.has(state.id)) {
        this.streams.delete(state.id);
      }
      options?.signal?.removeEventListener('abort', onAbort);
    });
    try {
      this.post(state);
    } catch (error) {
      consumer.cancelled = true;
      this.streams.delete(state.id);
      queueMicrotask(() => stream.destroy(error as Error));
    }
    return stream;
  }

  /**
   * 写入消息
   * @param data - 消息数据
   * @param timeout - 超时时间
   * @returns 消息响应
   */
  private _write<U = any>(data: any, options?: {
    timeout?: number,
    twoway?: boolean,
    signal?: AbortSignal,
  }) {
    const timeout = options?.timeout ?? 30000;
    const twoway = !!options?.twoway;
    const signal = options?.signal;

    // 创建请求消息数据
    const state = this.createPostData(MESSAGE_MODEM_TYPE.REQUEST, data, twoway);
    // 如果消息是单向的，则直接返回
    if (!twoway) {
      if (!signal?.aborted) this.post(state);
      return;
    }

    return new Promise<U>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let posted = false;
      const clear = () => {
        if (this.stacks.has(state.id)) {
          this.stacks.delete(state.id);
        }
      }

      const clean = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        clear();
      }

      const onAbort = () => {
        if (timer) clearTimeout(timer);
        try {
          if (posted) this.post(this.createPostData(MESSAGE_MODEM_TYPE.ABORT, state.id));
        } catch {
          /* 例如 WebSocket 已关闭时 send 可能抛错 */
        } finally {
          signal?.removeEventListener('abort', onAbort);
          clear();
          reject(new AbortException());
        }
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

      this.stacks.set(state.id, {
        resolve: _resolve,
        reject: _reject,
      });
      timer = setTimeout(() => _reject(new TimeoutException()), timeout).unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        posted = true;
        this.post(state);
      } catch (error) {
        _reject(error);
      }
    })
  }

  /**
   * 处理请求消息
   * @param msg - 消息数据
   */
  private onRequest<T = any>(msg: MessageTransferFormat<T>) {
    const controller = new AbortController();
    this.aborts.set(msg.id, controller);
    controller.signal.addEventListener('abort', () => {
      if (this.aborts.has(msg.id)) {
        this.aborts.delete(msg.id);
      }
    });
    this.exec(msg.data, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        if (isAsyncIterable(value)) {
          throw new Exception(500, 'Async iterable is not supported');
        }
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
      })
      .catch(e => {
        if (controller.signal.aborted) return;
        if (msg.twoway) {
          this.post({
            id: msg.id,
            mode: MESSAGE_MODEM_TYPE.RESPONSE,
            twoway: false,
            data: {
              status: e instanceof Exception ? e.status : 500,
              data: null,
              message: e.message,
            }
          })
        }
      })
      .finally(() => {
        // 删除 Abort 处理函数
        if (this.aborts.has(msg.id)) {
          this.aborts.delete(msg.id);
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

  private onStreamRequest<T = any>(msg: MessageTransferFormat<T>) {
    const controller = new AbortController();
    const usesCreditProtocol = msg.streamVersion === 1;
    const producer: StreamProducerState = {
      credits: usesCreditProtocol ? 1 : Number.POSITIVE_INFINITY,
      nextCreditSeq: 0,
    };
    let sequence = 0;
    this.aborts.set(msg.id, controller);
    this.streamProducers.set(msg.id, producer);
    controller.signal.addEventListener('abort', () => {
      producer.wake?.();
      if (this.aborts.has(msg.id)) {
        this.aborts.delete(msg.id);
      }
    });
    const takeCredit = async () => {
      while (producer.credits === 0 && !controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          producer.wake = resolve;
        });
        producer.wake = undefined;
      }
      if (controller.signal.aborted) throw new AbortException();
      producer.credits--;
    };
    this.exec(msg.data, controller.signal)
      .then(async (value: AsyncIterable<any>) => {
        if (!isAsyncIterable(value)) {
          throw new Exception(500, 'Invalid async iterable');
        }
        const iterator = value[Symbol.asyncIterator]();
        producer.iterator = iterator;
        while (!controller.signal.aborted) {
          await takeCredit();
          const next = await iterator.next();
          if (controller.signal.aborted) return;
          if (next.done) break;
          this.post<MessageStreamChunk>({
            id: msg.id,
            mode: MESSAGE_MODEM_TYPE.RESPONSE,
            stream: true,
            streamVersion: msg.streamVersion,
            data: {
              status: 200,
              seq: sequence++,
              payload: next.value,
              final: false,
            },
            twoway: false,
          });
        }
        if (controller.signal.aborted) return;
        this.post<MessageStreamChunk>({
          id: msg.id,
          mode: MESSAGE_MODEM_TYPE.RESPONSE,
          stream: true,
          streamVersion: msg.streamVersion,
          data: {
            status: 200,
            seq: sequence++,
            payload: undefined,
            final: true,
          },
          twoway: false,
        });
      })
      .catch(e => {
        if (controller.signal.aborted) return;
        this.post<MessageStreamChunk>({
          id: msg.id,
          mode: MESSAGE_MODEM_TYPE.RESPONSE,
          stream: true,
          streamVersion: msg.streamVersion,
          data: {
            status: e instanceof Exception ? e.status : 500,
            seq: sequence,
            payload: e instanceof Error ? e.message : 'Unknown error',
            final: true,
          },
          twoway: false,
        });
      })
      .finally(() => {
        if (controller.signal.aborted && producer.iterator?.return) {
          void Promise.resolve(producer.iterator.return()).catch(() => {});
        }
        producer.wake?.();
        this.streamProducers.delete(msg.id);
        if (this.aborts.has(msg.id)) {
          this.aborts.delete(msg.id);
        }
      });
  }

  private onStreamResponse<T = any>(msg: MessageTransferFormat<MessageStreamChunk<T>>) {
    const id = msg.id;
    const res = msg.data;
    // 如果栈中存在该消息，则处理响应消息
    if (this.streams.has(id)) {
      const consumer = this.streams.get(id)!;
      const stream = consumer.stream;
      if (res) {
        if (!Number.isSafeInteger(res.seq) || res.seq !== consumer.nextSeq) {
          stream.destroy(new Exception(409, `Invalid stream sequence: expected ${consumer.nextSeq}, received ${String(res.seq)}`));
          return;
        }
        consumer.nextSeq++;
        if (res.status === 200) {
          if (res.final) {
            consumer.completed = true;
            stream.push(null);
          } else {
            consumer.creditOwed = true;
            stream.push(res.payload);
          }
        } else {
          consumer.completed = true;
          const err = new Exception(res.status, res.payload as string);
          setImmediate(() => stream.destroy(err));
        }
      } else {
        consumer.completed = true;
        const err = new Exception(404, 'Empty chunk data');
        setImmediate(() => stream.destroy(err));
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
        if (msg.stream) {
          this.onStreamRequest(msg);
        } else {
          this.onRequest(msg);
        }
        break;
      // 处理响应消息
      case MESSAGE_MODEM_TYPE.RESPONSE:
        if (msg.stream) {
          this.onStreamResponse(msg);
        } else {
          this.onResponse(msg);
        }
        break;
      // 处理终止消息
      case MESSAGE_MODEM_TYPE.ABORT:
        const id: number = msg.data;
        if (this.aborts.has(id)) {
          const controller = this.aborts.get(id)!;
          if (!controller.signal.aborted) {
            controller.abort();
          }
        }
        break;
      case MESSAGE_MODEM_TYPE.STREAM_CREDIT: {
        const credit = msg.data as { id?: unknown; seq?: unknown } | undefined;
        if (
          !credit
          || !Number.isSafeInteger(credit.id)
          || (credit.id as number) < 0
          || !Number.isSafeInteger(credit.seq)
          || (credit.seq as number) < 0
        ) break;
        const producer = this.streamProducers.get(credit.id as number);
        if (producer && producer.credits === 0 && (credit.seq as number) === producer.nextCreditSeq) {
          producer.credits = 1;
          producer.nextCreditSeq++;
          producer.wake?.();
        }
        break;
      }
    }
  }
}

function isAsyncIterable<T = any>(value: any): value is AsyncIterable<T> {
  return value != null && typeof value[Symbol.asyncIterator] === 'function';
}
