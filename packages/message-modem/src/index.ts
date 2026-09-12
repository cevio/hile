import { AbortException, Exception, MessageInputError, TimeoutException } from "./exception";
import { Readable } from 'node:stream';
import { DeadlineScheduler, type DeadlineHandle } from './deadline-scheduler';
export * from './exception';
export enum MESSAGE_MODEM_TYPE {
  REQUEST = 0,
  RESPONSE = 1,
  ABORT = 2,
  STREAM_CREDIT = 3,
  STREAM_DATA = 4,
  STREAM_CANCEL = 5,
}

export type MessageStreamDirection = 'input' | 'output';

export interface MessageRequestStreams {
  /** The request has an input stream whose chunks follow the request frame. */
  input?: true;
  /** The caller expects a streamed response and declares its receive window. */
  output?: {
    window?: number;
  };
}

export interface MessageTransferFormat<T = any> {
  id: number,
  mode: MESSAGE_MODEM_TYPE,
  twoway: boolean,
  streams?: MessageRequestStreams,
  data?: T
}

export type MessageInput<T = any> = AsyncIterable<T> | Uint8Array | ArrayBuffer;

export interface MessageExecutionOptions {
  /** Response mode decoded from the request frame, independent of its payload and input stream. */
  readonly responseStream: boolean;
}

export interface MessageSendOptions<TInput = any> {
  signal?: AbortSignal;
  /** Maximum request or total stream lifetime in milliseconds. */
  timeout?: number;
  input?: MessageInput<TInput>;
}

export interface MessageStreamOptions<TInput = any> extends MessageSendOptions<TInput> {
  /** Maximum time between valid input or output stream activity in milliseconds. */
  idleTimeout?: number;
  /** Maximum number of produced but not yet consumed chunks. */
  window?: number;
}

export interface MessageReturnFormat<T = any> {
  status: string | number,
  data: T,
  message?: string,
}

export interface MessageInputStreamChunk<T = any> {
  direction: 'input';
  seq: number;
  payload?: T;
  final: boolean;
}

export interface MessageOutputStreamChunk<T = any> {
  direction: 'output';
  status: string | number;
  seq: number,
  payload?: T,
  final: boolean,
  message?: string,
}

export type MessageStreamChunk<T = any> =
  | MessageInputStreamChunk<T>
  | MessageOutputStreamChunk<T>;

export interface MessageStreamCredit {
  direction: MessageStreamDirection;
  seq: number;
  /** Present on input credits so the producer can enforce the remote receive window. */
  window?: number;
}

export interface MessageStreamCancel {
  direction: MessageStreamDirection;
  /** Present when cancellation is a protocol failure that must fail the request. */
  status?: string | number;
  message?: string;
}

interface StreamConsumerState {
  stream: Readable;
  completed: boolean;
  cancelled: boolean;
  creditsOwed: number;
  maxCredits: number;
  nextSeq: number;
  nextCreditSeq: number;
  touch(): void;
  clearTimers(): void;
  cleanup(): void;
}

interface StreamProducerState {
  credits: number;
  maxCredits?: number;
  nextCreditSeq: number;
  nextSeq: number;
  cancelled: boolean;
  iteratorReturned: boolean;
  fail?: (error: Error) => void;
  wake?: () => void;
  iterator?: AsyncIterator<any>;
}

const MAX_STREAM_WINDOW = 64;
const DEFAULT_INPUT_STREAM_WINDOW = 1;
const MAX_CONCURRENT_STREAMS = 128;
const MAX_TIMER_DELAY = 2_147_483_647;

export function isBinaryInput(value: unknown): value is Uint8Array | ArrayBuffer {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

export function isMessageInput(value: unknown): value is MessageInput {
  return isBinaryInput(value) || isAsyncIterable(value);
}

async function* toInputIterable(input: MessageInput): AsyncIterable<any> {
  if (input instanceof ArrayBuffer) {
    yield new Uint8Array(input);
    return;
  }
  if (input instanceof Uint8Array) {
    yield input;
    return;
  }
  yield* input;
}

function normalizeMessageInput(
  data: unknown,
  explicitInput?: MessageInput,
): { data: unknown; input?: AsyncIterable<any> } {
  if (explicitInput !== undefined) {
    if (isMessageInput(data)) {
      throw new TypeError('A message accepts only one request input stream');
    }
    if (!isMessageInput(explicitInput)) {
      throw new TypeError('Message input must be an AsyncIterable, Uint8Array, or ArrayBuffer');
    }
    return { data, input: toInputIterable(explicitInput) };
  }
  if (!isMessageInput(data)) return { data };
  return { data: undefined, input: toInputIterable(data) };
}

function streamLimit(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function streamWindow(value: number | undefined): number {
  const normalized = streamLimit(value, 'Stream window') ?? 1;
  if (normalized > MAX_STREAM_WINDOW) {
    throw new TypeError(`Stream window must not exceed ${MAX_STREAM_WINDOW}`);
  }
  return normalized;
}

function streamTimeout(value: number | undefined, name: string): number | undefined {
  const normalized = streamLimit(value, name);
  if (normalized !== undefined && normalized > MAX_TIMER_DELAY) {
    throw new TypeError(`${name} must not exceed ${MAX_TIMER_DELAY}`);
  }
  return normalized;
}

function returnProducerIterator(producer: StreamProducerState): void {
  if (producer.iteratorReturned || !producer.iterator?.return) return;
  producer.iteratorReturned = true;
  try {
    void Promise.resolve(producer.iterator.return()).catch(() => {});
  } catch {
    // Iterator cleanup must not mask the request's original outcome.
  }
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
  private readonly deadlines = new DeadlineScheduler();

  private readonly aborts = new Map<number, AbortController>();
  private readonly stacks = new Map<number, {
    resolve: (value?: any) => void,
    reject: (reason?: any) => void
  }>();

  private readonly streams = new Map<number, StreamConsumerState>();
  private readonly streamProducers = new Map<number, StreamProducerState>();
  private readonly inputStreams = new Map<number, StreamConsumerState>();
  private readonly inputStreamProducers = new Map<number, StreamProducerState>();

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
    for (const { stream } of this.inputStreams.values()) {
      stream.destroy(new AbortException());
    }
    for (const producer of this.streamProducers.values()) {
      producer.cancelled = true;
      producer.wake?.();
      returnProducerIterator(producer);
    }
    for (const producer of this.inputStreamProducers.values()) {
      producer.cancelled = true;
      producer.wake?.();
      returnProducerIterator(producer);
    }
    this.aborts.clear();
    this.stacks.clear();
    this.streams.clear();
    this.streamProducers.clear();
    this.inputStreams.clear();
    this.inputStreamProducers.clear();
    this.deadlines.clear();
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
  protected abstract exec(
    data: any,
    signal?: AbortSignal,
    input?: Readable,
    options?: MessageExecutionOptions,
  ): Promise<any>;

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
   * @param signal - 中止信号
   * @returns 消息响应
   */
  protected _send<T = any, TInput = any>(data: any, options?: MessageSendOptions<TInput>) {
    const normalized = normalizeMessageInput(data, options?.input);
    return this._write<T>(normalized.data, {
      timeout: options?.timeout ?? 30000,
      twoway: true,
      signal: options?.signal,
      input: normalized.input,
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

  private startInputProducer(
    id: number,
    input: AsyncIterable<any>,
    onError: (error: Error) => void,
    onActivity: () => void = () => {},
  ): void {
    const producer: StreamProducerState = {
      credits: 0,
      nextCreditSeq: 0,
      nextSeq: 0,
      cancelled: false,
      iteratorReturned: false,
      fail: onError,
      iterator: input[Symbol.asyncIterator](),
    };
    this.inputStreamProducers.set(id, producer);

    void (async () => {
      let readingInput = false;
      try {
        while (!producer.cancelled) {
          while (producer.credits === 0 && !producer.cancelled) {
            await new Promise<void>((resolve) => {
              producer.wake = resolve;
            });
            producer.wake = undefined;
          }
          if (producer.cancelled) return;
          producer.credits--;
          readingInput = true;
          const next = await producer.iterator!.next();
          if (!next.done && next.value == null) {
            throw new TypeError('Stream chunk must not be null or undefined');
          }
          readingInput = false;
          if (producer.cancelled) return;
          onActivity();
          this.post<MessageStreamChunk>({
            id,
            mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
            twoway: false,
            data: {
              direction: 'input',
              seq: producer.nextSeq++,
              payload: next.done ? undefined : next.value,
              final: next.done === true,
            },
          });
          if (next.done) {
            this.inputStreamProducers.delete(id);
            return;
          }
        }
      } catch (error) {
        if (producer.cancelled) return;
        this.failInputProducer(
          id,
          readingInput
            ? new MessageInputError(error)
            : error instanceof Error
              ? error
              : new Error('Request input stream failed'),
        );
      }
    })();
  }

  private failInputProducer(id: number, error: Error): void {
    const producer = this.inputStreamProducers.get(id);
    if (!producer) return;
    this.cancelInputProducer(id);
    try {
      this.post({
        id,
        mode: MESSAGE_MODEM_TYPE.ABORT,
        twoway: false,
      });
    } catch {
      // The transport may already be closed.
    }
    producer.fail?.(error);
  }

  private cancelInputProducer(id: number): void {
    const producer = this.inputStreamProducers.get(id);
    if (!producer) return;
    this.inputStreamProducers.delete(id);
    producer.cancelled = true;
    producer.wake?.();
    returnProducerIterator(producer);
  }

  protected _stream(data: any, options: MessageStreamOptions = {}): Readable {
    const normalized = normalizeMessageInput(data, options.input);
    const window = streamWindow(options.window);
    const timeout = streamTimeout(options.timeout, 'Stream timeout');
    const idleTimeout = streamTimeout(options.idleTimeout, 'Stream idle timeout');
    const state = this.createPostData(MESSAGE_MODEM_TYPE.REQUEST, normalized.data, true);
    state.streams = {
      ...(normalized.input ? { input: true as const } : {}),
      output: window > 1 ? { window } : {},
    };
    let consumer!: StreamConsumerState;
    const stream = new CreditReadable(() => {
        if (consumer.creditsOwed === 0 || consumer.completed || consumer.cancelled) return;
        consumer.creditsOwed--;
        try {
          this.post<MessageStreamCredit>({
            id: state.id,
            mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
            twoway: false,
            data: {
              direction: 'output',
              seq: consumer.nextCreditSeq++,
              window: consumer.maxCredits,
            },
          });
        } catch (error) {
          consumer.cancelled = true;
          stream.destroy(error as Error);
        }
    });
    let totalTimer: DeadlineHandle | undefined;
    let idleTimer: DeadlineHandle | undefined;
    const clearTimers = () => {
      this.deadlines.cancel(totalTimer);
      this.deadlines.cancel(idleTimer);
      totalTimer = undefined;
      idleTimer = undefined;
    };
    const expire = (message: string) => {
      if (consumer.completed || consumer.cancelled) return;
      sendAbort();
      stream.destroy(new TimeoutException(message));
    };
    const touch = () => {
      if (!idleTimeout || consumer.completed || consumer.cancelled) return;
      if (idleTimer) this.deadlines.reschedule(idleTimer, idleTimeout);
      else idleTimer = this.deadlines.schedule(idleTimeout, () => expire('Stream idle timeout'));
    };
    consumer = {
      stream,
      completed: false,
      cancelled: false,
      creditsOwed: 0,
      maxCredits: window,
      nextSeq: 0,
      nextCreditSeq: 0,
      touch,
      clearTimers,
      cleanup: () => {},
    };
    const sendAbort = () => {
      if (consumer.completed || consumer.cancelled) return;
      consumer.cancelled = true;
      try {
        this.post({
          id: state.id,
          mode: MESSAGE_MODEM_TYPE.ABORT,
          twoway: false,
        });
      } catch {
        // The transport may already be closed.
      }
    };
    const onAbort = () => {
      sendAbort();
      stream.destroy(new AbortException());
    };
    const cleanup = () => {
      clearTimers();
      this.streams.delete(state.id);
      options?.signal?.removeEventListener('abort', onAbort);
    };
    consumer.cleanup = cleanup;
    if (options?.signal?.aborted) {
      consumer.cancelled = true;
      queueMicrotask(() => stream.destroy(new AbortException()));
      return stream;
    }
    this.streams.set(state.id, consumer);
    if (normalized.input) {
      this.startInputProducer(state.id, normalized.input, (error) => {
        consumer.cancelled = true;
        stream.destroy(error);
      }, consumer.touch);
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    if (timeout) {
      totalTimer = this.deadlines.schedule(timeout, () => expire('Stream timeout'));
    }
    touch();
    stream.on('close', () => {
      sendAbort();
      this.cancelInputProducer(state.id);
      cleanup();
    });
    try {
      this.post(state);
    } catch (error) {
      consumer.cancelled = true;
      this.cancelInputProducer(state.id);
      cleanup();
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
    input?: AsyncIterable<any>,
  }) {
    const timeout = streamTimeout(options?.timeout ?? 30000, 'Message timeout')!;
    const twoway = !!options?.twoway;
    const signal = options?.signal;

    // 创建请求消息数据
    const state = this.createPostData(MESSAGE_MODEM_TYPE.REQUEST, data, twoway);
    if (options?.input) state.streams = { input: true };
    // 如果消息是单向的，则直接返回
    if (!twoway) {
      if (!signal?.aborted) this.post(state);
      return;
    }

    return new Promise<U>((resolve, reject) => {
      let timer: DeadlineHandle | undefined;
      let posted = false;
      const clear = () => {
        this.stacks.delete(state.id);
      }

      const clean = () => {
        this.deadlines.cancel(timer);
        timer = undefined;
        signal?.removeEventListener('abort', onAbort);
        clear();
        this.cancelInputProducer(state.id);
      }

      const onAbort = () => {
        this.deadlines.cancel(timer);
        timer = undefined;
        try {
          if (posted) {
            this.post({
              id: state.id,
              mode: MESSAGE_MODEM_TYPE.ABORT,
              twoway: false,
            });
          }
        } catch {
          /* 例如 WebSocket 已关闭时 send 可能抛错 */
        } finally {
          signal?.removeEventListener('abort', onAbort);
          clear();
          this.cancelInputProducer(state.id);
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
      timer = this.deadlines.schedule(timeout, () => {
        try {
          if (posted) {
            this.post({
              id: state.id,
              mode: MESSAGE_MODEM_TYPE.ABORT,
              twoway: false,
            });
          }
        } catch {
          // The transport may already be closed.
        }
        _reject(new TimeoutException());
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (options?.input) {
        this.startInputProducer(state.id, options.input, _reject);
      }
      try {
        posted = true;
        this.post(state);
      } catch (error) {
        _reject(error);
      }
    })
  }

  private createInputConsumer(id: number): Readable {
    const window = DEFAULT_INPUT_STREAM_WINDOW;
    let consumer!: StreamConsumerState;
    const stream = new CreditReadable(() => {
      if (consumer.creditsOwed === 0 || consumer.completed || consumer.cancelled) return;
      consumer.creditsOwed--;
      this.post<MessageStreamCredit>({
        id,
        mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
        twoway: false,
        data: {
          direction: 'input',
          seq: consumer.nextCreditSeq++,
          window,
        },
      });
    });
    consumer = {
      stream,
      completed: false,
      cancelled: false,
      creditsOwed: 0,
      maxCredits: window,
      nextSeq: 0,
      nextCreditSeq: 0,
      touch: () => {},
      clearTimers: () => {},
      cleanup: () => {},
    };
    this.inputStreams.set(id, consumer);
    // A handler may intentionally ignore its body. Keep protocol failures from
    // becoming process-level unhandled EventEmitter errors in that case.
    stream.on('error', () => {});
    stream.once('close', () => {
      if (consumer.completed || consumer.cancelled) return;
      this.cancelInputConsumer(id, 'Request input consumer closed');
    });
    this.post<MessageStreamCredit>({
      id,
      mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
      twoway: false,
      data: {
        direction: 'input',
        seq: consumer.nextCreditSeq++,
        window,
      },
    });
    return stream;
  }

  private canAcceptInputStream(id: number): boolean {
    return !this.inputStreams.has(id) && this.inputStreams.size < MAX_CONCURRENT_STREAMS;
  }

  private cancelInputConsumer(id: number, message = 'Request handler completed'): void {
    const consumer = this.inputStreams.get(id);
    if (!consumer) return;
    this.inputStreams.delete(id);
    consumer.cancelled = true;
    try {
      this.post<MessageStreamCancel>({
        id,
        mode: MESSAGE_MODEM_TYPE.STREAM_CANCEL,
        twoway: false,
        data: { direction: 'input', message },
      });
    } catch {
      // The transport may already be closed.
    }
    consumer.stream.destroy();
  }

  private failInputConsumer(id: number, error: Exception): void {
    const consumer = this.inputStreams.get(id);
    if (!consumer) return;
    this.inputStreams.delete(id);
    consumer.cancelled = true;
    try {
      this.post<MessageStreamCancel>({
        id,
        mode: MESSAGE_MODEM_TYPE.STREAM_CANCEL,
        twoway: false,
        data: { direction: 'input', status: error.status, message: error.message },
      });
    } catch {
      // The transport may already be closed.
    }
    consumer.stream.destroy(error);
    this.cancelOutputProducer(id);
    const controller = this.aborts.get(id);
    this.aborts.delete(id);
    if (controller && !controller.signal.aborted) controller.abort();
  }

  /**
   * 处理请求消息
   * @param msg - 消息数据
   */
  private onRequest<T = any>(msg: MessageTransferFormat<T>) {
    if (msg.streams?.input && !this.canAcceptInputStream(msg.id)) {
      if (msg.twoway) {
        this.post({
          id: msg.id,
          mode: MESSAGE_MODEM_TYPE.RESPONSE,
          twoway: false,
          data: {
            status: 429,
            data: null,
            message: 'Request input stream capacity exceeded',
          },
        });
      }
      return;
    }
    const controller = new AbortController();
    this.aborts.set(msg.id, controller);
    const input = msg.streams?.input ? this.createInputConsumer(msg.id) : undefined;
    Promise.resolve(this.exec(msg.data, controller.signal, input, { responseStream: false }))
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
        // Execution cannot be delivered; close its scope without replacing the original failure frame.
        controller.abort();
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
        this.cancelInputConsumer(msg.id);
        this.aborts.delete(msg.id);
      });
  }

  /**
   * 处理响应消息
   * @param msg - 消息数据
   */
  private onResponse<T = any>(msg: MessageTransferFormat<MessageReturnFormat<T>>) {
    const id = msg.id;
    const res = msg.data;
    const stack = this.stacks.get(id);
    // 如果栈中存在该消息，则处理响应消息
    if (stack) {
      const { resolve, reject } = stack;
      if (!res || (typeof res.status !== 'string' && typeof res.status !== 'number')) {
        reject(new Exception(502, 'Invalid response frame'));
        return;
      }
      // 如果响应状态码不是 200，则拒绝响应
      if (res.status !== 200) {
        reject(new Exception(res.status, res.message ?? 'Request failed'));
      } else {
        resolve(res.data);
      }
    }
  }

  private onStreamRequest<T = any>(msg: MessageTransferFormat<T>) {
    let window: number;
    try {
      window = streamWindow(msg.streams?.output?.window);
    } catch (error) {
      this.post<MessageStreamChunk>({
        id: msg.id,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        data: {
          direction: 'output',
          status: 400,
          seq: 0,
          payload: error instanceof Error ? error.message : 'Invalid stream window',
          final: true,
        },
        twoway: false,
      });
      return;
    }
    if (
      this.streamProducers.has(msg.id)
      || this.streamProducers.size >= MAX_CONCURRENT_STREAMS
      || (msg.streams?.input && !this.canAcceptInputStream(msg.id))
    ) {
      this.post<MessageStreamChunk>({
        id: msg.id,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        data: {
          direction: 'output',
          status: 429,
          seq: 0,
          payload: 'Stream capacity exceeded',
          final: true,
        },
        twoway: false,
      });
      return;
    }
    const controller = new AbortController();
    const producer: StreamProducerState = {
      credits: window,
      maxCredits: window,
      nextCreditSeq: 0,
      nextSeq: 0,
      cancelled: false,
      iteratorReturned: false,
    };
    this.aborts.set(msg.id, controller);
    this.streamProducers.set(msg.id, producer);
    const input = msg.streams?.input ? this.createInputConsumer(msg.id) : undefined;
    const takeCredit = async () => {
      while (producer.credits === 0 && !controller.signal.aborted && !producer.cancelled) {
        await new Promise<void>((resolve) => {
          producer.wake = resolve;
        });
        producer.wake = undefined;
      }
      if (controller.signal.aborted || producer.cancelled) throw new AbortException();
      producer.credits--;
    };
    Promise.resolve(this.exec(msg.data, controller.signal, input, { responseStream: true }))
      .then(async (value: AsyncIterable<any>) => {
        if (!isAsyncIterable(value)) {
          throw new Exception(500, 'Invalid async iterable');
        }
        const iterator = value[Symbol.asyncIterator]();
        producer.iterator = iterator;
        while (!controller.signal.aborted && !producer.cancelled) {
          await takeCredit();
          const next = await iterator.next();
          if (controller.signal.aborted || producer.cancelled) return;
          if (next.done) break;
          if (next.value == null) {
            throw new Exception(500, 'Stream chunk must not be null or undefined');
          }
          this.post<MessageStreamChunk>({
            id: msg.id,
            mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
            data: {
              direction: 'output',
              status: 200,
              seq: producer.nextSeq++,
              payload: next.value,
              final: false,
            },
            twoway: false,
          });
        }
        if (controller.signal.aborted || producer.cancelled) return;
        this.post<MessageStreamChunk>({
          id: msg.id,
          mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
          data: {
            direction: 'output',
            status: 200,
            seq: producer.nextSeq++,
            payload: undefined,
            final: true,
          },
          twoway: false,
        });
      })
      .catch(e => {
        if (controller.signal.aborted || producer.cancelled) return;
        // Cleanup may be asynchronous or uncooperative, so signal it before sending the failure.
        controller.abort();
        this.post<MessageStreamChunk>({
          id: msg.id,
          mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
          data: {
            direction: 'output',
            status: e instanceof Exception ? e.status : 500,
            seq: producer.nextSeq,
            payload: e instanceof Error ? e.message : 'Unknown error',
            final: true,
          },
          twoway: false,
        });
      })
      .finally(() => {
        if ((controller.signal.aborted || producer.cancelled) && producer.iterator?.return) {
          returnProducerIterator(producer);
        }
        producer.wake?.();
        this.cancelInputConsumer(msg.id);
        this.streamProducers.delete(msg.id);
        this.aborts.delete(msg.id);
      });
  }

  private onStreamResponse<T = any>(msg: MessageTransferFormat<MessageStreamChunk<T>>) {
    const id = msg.id;
    const res = msg.data;
    const consumer = this.streams.get(id);
    if (consumer && !consumer.completed && !consumer.cancelled) {
      const stream = consumer.stream;
      if (res?.direction === 'output') {
        if (
          !Number.isSafeInteger(res.seq)
          || res.seq !== consumer.nextSeq
          || typeof res.final !== 'boolean'
          || (typeof res.status !== 'string' && typeof res.status !== 'number')
          || (!res.final && res.payload == null)
        ) {
          this.failOutputConsumer(
            id,
            new Exception(409, `Invalid response stream frame: expected sequence ${consumer.nextSeq}, received ${String(res.seq)}`),
          );
          return;
        }
        consumer.touch();
        consumer.nextSeq++;
        if (res.status === 200) {
          if (res.final) {
            consumer.completed = true;
            this.cancelInputProducer(id);
            consumer.cleanup();
            stream.push(null);
          } else {
            if (consumer.creditsOwed >= consumer.maxCredits) {
              this.failOutputConsumer(id, new Exception(429, 'Response stream window exceeded'));
              return;
            }
            consumer.creditsOwed++;
            stream.push(res.payload);
          }
        } else {
          consumer.completed = true;
          this.cancelInputProducer(id);
          consumer.cleanup();
          const err = new Exception(res.status ?? 500, res.message ?? String(res.payload ?? 'Stream failed'));
          setImmediate(() => stream.destroy(err));
        }
      } else {
        this.failOutputConsumer(
          id,
          res
            ? new Exception(400, 'Invalid response stream direction')
            : new Exception(404, 'Empty chunk data'),
        );
      }
    }
  }

  private failOutputConsumer(id: number, error: Exception): void {
    const consumer = this.streams.get(id);
    if (!consumer || consumer.completed || consumer.cancelled) return;
    try {
      this.post({
        id,
        mode: MESSAGE_MODEM_TYPE.ABORT,
        twoway: false,
      });
    } catch {
      // The transport may already be closed.
    }
    consumer.cancelled = true;
    this.cancelInputProducer(id);
    consumer.cleanup();
    consumer.stream.destroy(error);
  }

  private onInputStreamData<T = any>(msg: MessageTransferFormat<MessageStreamChunk<T>>) {
    const consumer = this.inputStreams.get(msg.id);
    if (!consumer) return;
    const chunk = msg.data;
    if (
      !chunk
      || chunk.direction !== 'input'
      || !Number.isSafeInteger(chunk.seq)
      || chunk.seq !== consumer.nextSeq
      || typeof chunk.final !== 'boolean'
      || (!chunk.final && chunk.payload == null)
    ) {
      const received = chunk?.seq;
      this.failInputConsumer(
        msg.id,
        new Exception(
          409,
          `Invalid request input sequence: expected ${consumer.nextSeq}, received ${String(received)}`,
        ),
      );
      return;
    }

    consumer.nextSeq++;
    if (chunk.final) {
      consumer.completed = true;
      this.inputStreams.delete(msg.id);
      consumer.stream.push(null);
      return;
    }
    if (consumer.creditsOwed >= consumer.maxCredits) {
      this.failInputConsumer(
        msg.id,
        new Exception(429, 'Request input stream window exceeded'),
      );
      return;
    }
    consumer.creditsOwed++;
    consumer.stream.push(chunk.payload);
  }

  private onStreamCredit(msg: MessageTransferFormat<MessageStreamCredit>): void {
    const credit = msg.data;
    if (
      !credit
      || (credit.direction !== 'input' && credit.direction !== 'output')
    ) return;

    const producer = credit.direction === 'input'
      ? this.inputStreamProducers.get(msg.id)
      : this.streamProducers.get(msg.id);
    if (!producer || producer.cancelled) return;
    if (!Number.isSafeInteger(credit.seq) || credit.seq < 0) {
      if (credit.direction === 'input') {
        this.failInputProducer(msg.id, new Exception(400, 'Invalid request input credit sequence'));
      } else {
        this.failOutputProducer(msg.id, new Exception(400, 'Invalid response stream credit sequence'));
      }
      return;
    }
    if (credit.seq < producer.nextCreditSeq) return;
    if (credit.seq > producer.nextCreditSeq) {
      if (credit.direction === 'input') {
        this.failInputProducer(msg.id, new Exception(409, 'Request input credit sequence skipped'));
      } else {
        this.failOutputProducer(msg.id, new Exception(409, 'Response stream credit sequence skipped'));
      }
      return;
    }

    if (producer.maxCredits === undefined) {
      if (credit.direction !== 'input') return;
      try {
        producer.maxCredits = streamWindow(credit.window);
      } catch {
        this.failInputProducer(msg.id, new Exception(400, 'Invalid request input stream window'));
        return;
      }
    } else if (credit.window !== undefined && credit.window !== producer.maxCredits) {
      if (credit.direction === 'input') {
        this.failInputProducer(msg.id, new Exception(409, 'Request input stream window changed'));
      } else {
        this.failOutputProducer(msg.id, new Exception(409, 'Response stream window changed'));
      }
      return;
    }
    if (producer.credits >= producer.maxCredits) {
      if (credit.direction === 'input') {
        this.failInputProducer(msg.id, new Exception(429, 'Request input credit window exceeded'));
      } else {
        this.failOutputProducer(msg.id, new Exception(429, 'Response stream credit window exceeded'));
      }
      return;
    }

    producer.credits++;
    producer.nextCreditSeq++;
    producer.wake?.();
  }

  private failOutputProducer(id: number, error: Exception): void {
    const producer = this.streamProducers.get(id);
    if (!producer) return;
    try {
      this.post<MessageStreamChunk>({
        id,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        twoway: false,
        data: {
          direction: 'output',
          status: error.status,
          seq: producer.nextSeq,
          final: true,
          message: error.message,
        },
      });
    } catch {
      // The transport may already be closed.
    }
    this.cancelOutputProducer(id);
    const controller = this.aborts.get(id);
    this.aborts.delete(id);
    if (controller && !controller.signal.aborted) controller.abort();
  }

  private cancelOutputProducer(id: number): void {
    const producer = this.streamProducers.get(id);
    if (!producer) return;
    this.streamProducers.delete(id);
    producer.cancelled = true;
    producer.wake?.();
    returnProducerIterator(producer);
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
        if (msg.streams?.output) {
          this.onStreamRequest(msg);
        } else {
          this.onRequest(msg);
        }
        break;
      // 处理响应消息
      case MESSAGE_MODEM_TYPE.RESPONSE:
        this.onResponse(msg);
        break;
      case MESSAGE_MODEM_TYPE.STREAM_DATA: {
        const chunk = msg.data as MessageStreamChunk | undefined;
        if (chunk?.direction === 'input') this.onInputStreamData(msg);
        else if (chunk?.direction === 'output') this.onStreamResponse(msg);
        else if (this.streams.has(msg.id)) this.onStreamResponse(msg);
        else if (this.inputStreams.has(msg.id)) this.onInputStreamData(msg);
        break;
      }
      // 处理终止消息
      case MESSAGE_MODEM_TYPE.ABORT: {
        const id = msg.id;
        const controller = this.aborts.get(id);
        if (controller) {
          this.aborts.delete(id);
          if (!controller.signal.aborted) {
            controller.abort();
          }
        }
        this.cancelOutputProducer(id);
        this.cancelInputConsumer(id, 'Request aborted');
        break;
      }
      case MESSAGE_MODEM_TYPE.STREAM_CREDIT:
        this.onStreamCredit(msg as MessageTransferFormat<MessageStreamCredit>);
        break;
      case MESSAGE_MODEM_TYPE.STREAM_CANCEL: {
        const cancel = msg.data as MessageStreamCancel | undefined;
        if (cancel?.direction === 'input') {
          this.cancelInputProducer(msg.id);
          if (cancel.status !== undefined) {
            const error = new Exception(
              cancel.status,
              cancel.message ?? 'Request input stream rejected',
            );
            const stack = this.stacks.get(msg.id);
            if (stack) stack.reject(error);
            else this.failOutputConsumer(msg.id, error);
          }
        } else if (cancel?.direction === 'output') {
          this.cancelOutputProducer(msg.id);
          const controller = this.aborts.get(msg.id);
          this.aborts.delete(msg.id);
          if (controller && !controller.signal.aborted) controller.abort();
        }
        break;
      }
    }
  }
}

function isAsyncIterable<T = any>(value: any): value is AsyncIterable<T> {
  return value != null && typeof value[Symbol.asyncIterator] === 'function';
}
