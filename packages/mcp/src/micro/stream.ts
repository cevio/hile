import type { McpInvocationContext } from '../types.js';

export type McpExecutionFrame =
  | { type: 'progress'; progress: number; total?: number; message?: string }
  | { type: 'log'; level: 'debug' | 'info' | 'notice' | 'warning' | 'error'; data: unknown }
  | { type: 'result'; result: unknown };

class AsyncFrameChannel implements AsyncIterable<McpExecutionFrame> {
  private readonly frames: McpExecutionFrame[] = [];
  private consumer?: () => void;
  private readonly producers: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  private ended = false;
  private error?: unknown;
  private readonly onAbort: () => void;

  constructor(private readonly maxBufferedFrames: number, private readonly signal: AbortSignal) {
    this.onAbort = () => this.fail(signal.reason ?? new Error('MCP execution aborted'));
    if (signal.aborted) this.fail(signal.reason ?? new Error('MCP execution aborted'));
    else signal.addEventListener('abort', this.onAbort, { once: true });
  }

  async push(frame: McpExecutionFrame) {
    while (!this.ended && this.frames.length >= this.maxBufferedFrames) {
      await new Promise<void>((resolve, reject) => { this.producers.push({ resolve, reject }); });
    }
    if (this.ended) throw this.error ?? new Error('MCP execution stream is closed');
    this.frames.push(frame);
    this.consumer?.();
    this.consumer = undefined;
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.consumer?.();
    this.consumer = undefined;
    for (const producer of this.producers.splice(0)) producer.reject(this.error ?? new Error('MCP execution stream is closed'));
  }
  fail(error: unknown) { this.error = error; this.close(); }

  async *[Symbol.asyncIterator]() {
    try {
      for (;;) {
        if (this.frames.length) {
          const frame = this.frames.shift()!;
          this.producers.shift()?.resolve();
          yield frame;
          continue;
        }
        if (this.error) throw this.error;
        if (this.ended) return;
        await new Promise<void>(resolve => { this.consumer = resolve; });
      }
    } finally {
      if (!this.ended) this.fail(new Error('MCP execution stream consumer closed'));
    }
  }
}

export function streamExecution(
  base: Omit<McpInvocationContext, 'emit'>,
  execute: (context: McpInvocationContext) => Promise<unknown>,
  options: { maxBufferedFrames?: number } = {},
): AsyncIterable<McpExecutionFrame> {
  const maxBufferedFrames = options.maxBufferedFrames ?? 16;
  if (!Number.isSafeInteger(maxBufferedFrames) || maxBufferedFrames <= 0) {
    throw new RangeError('maxBufferedFrames must be a positive integer');
  }
  const channel = new AsyncFrameChannel(maxBufferedFrames, base.signal);
  const context: McpInvocationContext = {
    ...base,
    emit: {
      progress: (progress, total, message) => channel.push({ type: 'progress', progress, total, message }),
      log: (level, data) => channel.push({ type: 'log', level, data }),
    },
  };
  if (base.signal.aborted) return channel;
  void execute(context).then(async result => {
    await channel.push({ type: 'result', result });
    channel.close();
  }).catch(error => channel.fail(error));
  return channel;
}
