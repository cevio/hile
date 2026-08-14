import { describe, expect, it, vi } from 'vitest';
import { streamExecution } from './stream.js';

describe('streamExecution', () => {
  it('applies bounded backpressure to provider emit calls', async () => {
    let secondEmitCompleted = false;
    const stream = streamExecution({ signal: new AbortController().signal }, async context => {
      await context.emit.progress(1);
      await context.emit.progress(2);
      secondEmitCompleted = true;
      return { content: [] };
    }, { maxBufferedFrames: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondEmitCompleted).toBe(false);

    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: { type: 'progress', progress: 1, total: undefined, message: undefined }, done: false });
    await vi.waitFor(() => expect(secondEmitCompleted).toBe(true));
    await iterator.return?.();
  });
});
