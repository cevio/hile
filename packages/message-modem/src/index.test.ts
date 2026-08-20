import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MessageModem,
  MESSAGE_MODEM_TYPE,
  type MessageTransferFormat,
  Exception,
  AbortException,
  TimeoutException,
} from './index'

class TestModem extends MessageModem {
  public peer?: TestModem;
  public posted: MessageTransferFormat[] = [];

  protected post<T>(data: MessageTransferFormat<T>): void {
    this.posted.push(data as MessageTransferFormat);
    if (this.peer) {
      this.peer.receive(data as MessageTransferFormat);
    }
  }

  protected async exec(data: any): Promise<any> {
    return data;
  }

  public send<T>(data: T, options?: number | { timeout?: number; signal?: AbortSignal }) {
    if (typeof options === 'number') {
      return super._send(data, { timeout: options });
    }
    return super._send(data, { timeout: options?.timeout, signal: options?.signal });
  }

  public push<T>(data: T, options?: number | { timeout?: number; signal?: AbortSignal }): void {
    if (typeof options === 'number') {
      super._push(data, { timeout: options });
    } else {
      super._push(data, { timeout: options?.timeout, signal: options?.signal });
    }
  }

  public stream<T>(data: T, options?: {
    signal?: AbortSignal;
    timeout?: number;
    idleTimeout?: number;
    window?: number;
  }) {
    return super._stream(data, options);
  }
}

function createPair() {
  const a = new TestModem();
  const b = new TestModem();
  a.peer = b;
  b.peer = a;
  return { a, b };
}

describe('@hile/message-modem', () => {
  describe('Exception classes', () => {
    it('Exception carries status and message', () => {
      const e = new Exception(400, 'bad request');
      expect(e.status).toBe(400);
      expect(e.message).toBe('bad request');
      expect(e).toBeInstanceOf(Error);
    });

    it('TimeoutException has ETIMEDOUT code', () => {
      const e = new TimeoutException();
      expect(e.status).toBe(TimeoutException.code);
      expect(e.message).toBe('Timeout');
    });

    it('TimeoutException accepts custom message', () => {
      const e = new TimeoutException('custom');
      expect(e.message).toBe('custom');
    });

    it('AbortException has ECONNABORTED code', () => {
      const e = new AbortException();
      expect(e.status).toBe(AbortException.code);
      expect(e.message).toBe('Abort');
    });
  });

  describe('basic request/response', () => {
    it('round trip returns exec result from peer', async () => {
      const { a, b } = createPair();
      const result = await a.send('hello');
      expect(result).toBe('hello');
    });

    it('handles complex data', async () => {
      const { a, b } = createPair();
      const payload = { user: 'test', items: [1, 2, 3] };
      const result = await a.send(payload);
      expect(result).toEqual(payload);
    });

    it('multiple sequential requests', async () => {
      const { a, b } = createPair();
      const r1 = await a.send(1);
      const r2 = await a.send(2);
      const r3 = await a.send(3);
      expect(r1).toBe(1);
      expect(r2).toBe(2);
      expect(r3).toBe(3);
    });

    it('multiple concurrent requests', async () => {
      const { a, b } = createPair();
      const [r1, r2, r3] = await Promise.all([
        a.send('a'),
        a.send('b'),
        a.send('c'),
      ]);
      expect(r1).toBe('a');
      expect(r2).toBe('b');
      expect(r3).toBe('c');
    });

    it('bidirectional communication', async () => {
      const pair1 = createPair();
      const pair2 = createPair();
      const fromA = await pair1.a.send('from-a');
      const fromB = await pair2.b.send('from-b');
      expect(fromA).toBe('from-a');
      expect(fromB).toBe('from-b');
    });

    it('does not post a request when its signal is already aborted', async () => {
      const modem = new TestModem();
      const controller = new AbortController();
      controller.abort();

      await expect(modem.send('ignored', { signal: controller.signal }))
        .rejects.toBeInstanceOf(AbortException);
      expect(modem.posted).toEqual([]);
      expect(modem['stacks'].size).toBe(0);
    });
  });

  describe('message format', () => {
    it('REQUEST message has correct format', () => {
      const modem = new TestModem();
      modem.send('test').catch(() => {});
      const msg = modem.posted[0];
      expect(msg.mode).toBe(MESSAGE_MODEM_TYPE.REQUEST);
      expect(msg.twoway).toBe(true);
      expect(msg.data).toBe('test');
      expect(typeof msg.id).toBe('number');
    });

    it('message IDs auto-increment', () => {
      const modem = new TestModem();
      modem.send('a').catch(() => {});
      modem.send('b').catch(() => {});
      modem.send('c').catch(() => {});
      expect(modem.posted[0].id).toBe(0);
      expect(modem.posted[1].id).toBe(1);
      expect(modem.posted[2].id).toBe(2);
    });
  });

  describe('error handling', () => {
    it('Exception in exec returns status and message', async () => {
      const { a, b } = createPair();
      b['exec'] = async () => { throw new Exception(403, 'forbidden'); };

      await expect(a.send('x')).rejects.toThrow('forbidden');
      try {
        await a.send('x');
      } catch (e) {
        expect(e).toBeInstanceOf(Exception);
        expect((e as Exception).status).toBe(403);
      }
    });

    it('generic Error in exec returns status 500', async () => {
      const { a, b } = createPair();
      b['exec'] = async () => { throw new Error('internal'); };

      try {
        await a.send('x');
      } catch (e) {
        expect(e).toBeInstanceOf(Exception);
        expect((e as Exception).status).toBe(500);
        expect((e as Exception).message).toBe('internal');
      }
    });
  });

  describe('abort', () => {
    it('abort rejects with AbortException on sender side', async () => {
      const a = new TestModem();
      const controller = new AbortController();
      const promise = a.send('test', { signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toThrow('Abort');
    });

    it('abort sends ABORT message to peer', async () => {
      const a = new TestModem();
      const controller = new AbortController();
      const promise = a.send('test', { signal: controller.signal }).catch(() => {});
      controller.abort();
      await promise;
      const abortMsg = a.posted.find(m => m.mode === MESSAGE_MODEM_TYPE.ABORT);
      expect(abortMsg).toBeDefined();
      expect(abortMsg!.twoway).toBe(false);
    });

    it('abort cancels execution on peer', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;

      let execResolved = false;
      b['exec'] = () => new Promise(resolve => {
        setTimeout(() => { execResolved = true; resolve('done'); }, 5000);
      });

      b.peer = a;
      const controller = new AbortController();
      const promise = a.send('slow', { signal: controller.signal });

      await new Promise(r => setTimeout(r, 50));
      controller.abort();

      await expect(promise).rejects.toThrow('Abort');
    });

    it('abort during exec error returns early without sending error response', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;

      b['exec'] = (data: any, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('exec aborted')));
      });

      b.peer = a;
      const controller = new AbortController();
      const promise = a.send('will-fail', { signal: controller.signal }).catch(() => {});

      await new Promise(r => setTimeout(r, 50));
      controller.abort();
      await new Promise(r => setTimeout(r, 50));

      const resp = b.posted.find(m => m.mode === MESSAGE_MODEM_TYPE.RESPONSE);
      expect(resp).toBeUndefined();
    });
  });

  describe('timeout', () => {
    it('times out if no response within timeout period', async () => {
      const modem = new TestModem();
      await expect(modem.send('data', 50)).rejects.toThrow();
    });

    it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648])(
      'rejects invalid message timeout %s',
      (timeout) => {
        const modem = new TestModem();
        expect(() => modem.send('data', timeout)).toThrow(TypeError);
      },
    );

    it('validates timeout for one-way messages too', () => {
      const modem = new TestModem();
      expect(() => modem.push('data', 0)).toThrow(TypeError);
      expect(modem.posted).toEqual([]);
    });
  });

  describe('push (one-way)', () => {
    it('push sends REQUEST with twoway=false', () => {
      const modem = new TestModem();
      modem.push('fire-and-forget');
      const msg = modem.posted[0];
      expect(msg.mode).toBe(MESSAGE_MODEM_TYPE.REQUEST);
      expect(msg.twoway).toBe(false);
      expect(msg.data).toBe('fire-and-forget');
    });

    it('push triggers exec on peer but peer does not send RESPONSE', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      let execCalled = false;
      b['exec'] = async (data: any) => { execCalled = true; return data; };

      a.push('notify');
      await new Promise(r => setTimeout(r, 50));
      expect(execCalled).toBe(true);

      const responseMsgs = a.posted.filter(m => m.mode === MESSAGE_MODEM_TYPE.RESPONSE);
      const bResponseMsgs = b.posted.filter(m => m.mode === MESSAGE_MODEM_TYPE.RESPONSE);
      expect(bResponseMsgs.length).toBe(0);
    });

    it('send sends REQUEST with twoway=true', () => {
      const modem = new TestModem();
      modem.send('request').catch(() => {});
      const msg = modem.posted[0];
      expect(msg.twoway).toBe(true);
    });
  });

  describe('receive dispatch', () => {
    it('ignores RESPONSE for unknown IDs', () => {
      const modem = new TestModem();
      expect(() => {
        modem.receive({
          id: 99999,
          mode: MESSAGE_MODEM_TYPE.RESPONSE,
          twoway: false,
          data: { status: 200, data: 'ok', message: '' },
        });
      }).not.toThrow();
    });

    it('ignores ABORT for unknown IDs', () => {
      const modem = new TestModem();
      expect(() => {
        modem.receive({
          id: 88888,
          mode: MESSAGE_MODEM_TYPE.ABORT,
          twoway: false,
          data: 88888,
        });
      }).not.toThrow();
    });
  });

  describe('stream', () => {
    it('appends STREAM_CREDIT without changing existing message type values', () => {
      expect(MESSAGE_MODEM_TYPE.REQUEST).toBe(0);
      expect(MESSAGE_MODEM_TYPE.RESPONSE).toBe(1);
      expect(MESSAGE_MODEM_TYPE.ABORT).toBe(2);
      expect(MESSAGE_MODEM_TYPE.STREAM_CREDIT).toBe(3);
    });

    it('sends REQUEST with stream flag', () => {
      const modem = new TestModem();
      modem.stream('data');
      const msg = modem.posted.find(m => m.mode === MESSAGE_MODEM_TYPE.REQUEST);
      expect(msg?.stream).toBe(true);
      expect(msg?.twoway).toBe(true);
    });

    it('delivers multiple chunks from peer', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield 'a';
          yield 'b';
          yield 'c';
        }
      });

      const stream = a.stream('data');
      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual(['a', 'b', 'c']);
    });

    it('delivers single chunk', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield 'only';
        }
      });

      const stream = a.stream('data');
      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual(['only']);
    });

    it('handles empty iterator (no yield)', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          // no yields
        }
      });

      const stream = a.stream('data');
      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([]);
    });

    it('sends error RESPONSE when exec throws', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          throw new Exception(400, 'bad data');
        }
      });

      const stream = a.stream('data');
      const errorSpy = vi.fn();
      stream.on('error', errorSpy);
      await new Promise<void>(r => stream.on('close', () => r()));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.any(Exception));
    });

    it('non-stream onRequest rejects AsyncIterable return with 500', async () => {
      const { a, b } = createPair();

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield 'x';
        }
      });

      a.send('x').catch(() => {});
      await new Promise(r => setTimeout(r, 50));

      const resp = b.posted.find(m => m.mode === MESSAGE_MODEM_TYPE.RESPONSE);
      expect(resp).toBeDefined();
      expect(resp!.data).toMatchObject({
        status: 500,
        message: expect.stringContaining('Async iterable'),
      });
    });

    it('external abort signal sends ABORT message', async () => {
      const a = new TestModem();

      const controller = new AbortController();
      const stream = a.stream('data', { signal: controller.signal });
      stream.on('error', () => {});
      controller.abort();

      await new Promise<void>(r => stream.on('close', () => r()));

      const abortMsg = a.posted.find(m => m.mode === MESSAGE_MODEM_TYPE.ABORT);
      expect(abortMsg).toBeDefined();
    });

    it('generic Error in stream preserves its message with status 500', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield 'chunk';
          throw new Error('plain error');
        }
      });

      const stream = a.stream('data');
      stream.on('error', () => {});
      stream.resume();
      await new Promise<void>(r => stream.on('close', () => r()));

      const errorResp = b.posted.find(
        m => m.mode === MESSAGE_MODEM_TYPE.RESPONSE && m.stream && m.data?.status === 500
      );
      expect(errorResp).toBeDefined();
      expect(errorResp!.data.payload).toBe('plain error');
    });

    it('non-iterable exec return in stream throws 500', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => 'not-iterable';

      const stream = a.stream('data');
      const errorSpy = vi.fn();
      stream.on('error', errorSpy);
      await new Promise<void>(r => stream.on('close', () => r()));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const err = errorSpy.mock.calls[0][0];
      expect(err.message).toContain('Invalid async iterable');
    });

    it('iterable error mid-stream sends error RESPONSE then destroys stream', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield 'ok';
          throw new Exception(500, 'stream fail');
        }
      });

      const stream = a.stream('data');
      const chunks: any[] = [];
      const errorSpy = vi.fn();
      stream.on('data', (chunk: any) => chunks.push(chunk));
      stream.on('error', errorSpy);
      stream.resume();
      await new Promise<void>(r => stream.on('close', () => r()));

      expect(chunks).toEqual(['ok']);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('external abort during stream stops chunk delivery early', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield 'first';
          await new Promise(r => setTimeout(r, 100));
          yield 'second';
        }
      });

      const controller = new AbortController();
      const stream = a.stream('data', { signal: controller.signal });
      const chunks: any[] = [];
      stream.on('data', (chunk: any) => chunks.push(chunk));
      stream.on('error', () => {});

      await new Promise(r => setTimeout(r, 30));
      controller.abort();
      await new Promise(r => setTimeout(r, 200));

      expect(chunks).toEqual(['first']);
    });

    it('abort after all chunks skips completion post', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield 'only';
          await new Promise(r => setTimeout(r, 100));
        }
      });

      const controller = new AbortController();
      const stream = a.stream('data', { signal: controller.signal });
      const chunks: any[] = [];
      stream.on('data', (chunk: any) => chunks.push(chunk));
      stream.on('error', () => {});

      await new Promise(r => setTimeout(r, 30));
      controller.abort();
      await new Promise(r => setTimeout(r, 200));

      expect(chunks).toEqual(['only']);
    });

    it('abort before stream error discards error response', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield 'first';
          await new Promise(r => setTimeout(r, 100));
          throw new Error('fail');
        }
      });

      const controller = new AbortController();
      const stream = a.stream('data', { signal: controller.signal });
      const chunks: any[] = [];
      stream.on('data', (chunk: any) => chunks.push(chunk));
      stream.on('error', () => {});

      await new Promise(r => setTimeout(r, 30));
      controller.abort();
      await new Promise(r => setTimeout(r, 200));

      expect(chunks).toEqual(['first']);
    });

    it('does not pull more than one chunk while the consumer is paused', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;
      let nextCalls = 0;
      b['exec'] = async () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls++;
              if (nextCalls > 4) return { done: true, value: undefined };
              return { done: false, value: `chunk-${nextCalls}` };
            },
          };
        },
      });

      const stream = a.stream('paused');
      stream.on('error', () => {});
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(nextCalls).toBe(1);
      expect(b.posted.filter((msg) => msg.mode === MESSAGE_MODEM_TYPE.RESPONSE)).toHaveLength(1);
      stream.destroy();
    });

    it('advertises and enforces a bounded multi-chunk credit window', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;
      let nextCalls = 0;
      b['exec'] = async () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls++;
              return { done: false, value: nextCalls };
            },
          };
        },
      });

      const stream = a.stream('windowed', { window: 4 });
      stream.on('error', () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(a.posted.find(({ mode }) => mode === MESSAGE_MODEM_TYPE.REQUEST))
        .toMatchObject({ streamWindow: 4 });
      expect(nextCalls).toBe(4);

      expect(stream.read()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nextCalls).toBe(5);
      stream.destroy();
    });

    it('rejects a peer that sends more unconsumed chunks than the negotiated window', async () => {
      const modem = new TestModem();
      const stream = modem.stream('windowed', { window: 2 });
      const error = new Promise<Error>((resolve) => stream.once('error', resolve));
      const response = (seq: number) => modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.RESPONSE,
        stream: true,
        streamVersion: 1,
        twoway: false,
        data: { status: 200, seq, payload: seq, final: false },
      });

      response(0);
      response(1);
      response(2);

      await expect(error).resolves.toMatchObject({ status: 429 });
      expect(stream.readableLength).toBeLessThanOrEqual(2);
    });

    it('aborts a stream after its total timeout', async () => {
      const modem = new TestModem();
      const stream = modem.stream('timed', { timeout: 20 });
      const error = new Promise<Error>((resolve) => stream.once('error', resolve));
      stream.resume();

      await expect(Promise.race([
        error,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('stream did not time out')), 200)),
      ])).resolves.toBeInstanceOf(TimeoutException);
      expect(modem.posted).toContainEqual(expect.objectContaining({
        mode: MESSAGE_MODEM_TYPE.ABORT,
        data: 0,
      }));
    });

    it('rejects stream windows and timer delays outside runtime bounds', () => {
      const modem = new TestModem();

      expect(() => modem.stream('wide', { window: 65 })).toThrow('64');
      expect(() => modem.stream('long', { timeout: Number.MAX_SAFE_INTEGER }))
        .toThrow('2147483647');
      expect(() => modem.stream('idle', { idleTimeout: 0 })).toThrow('positive');
      expect(modem.posted).toEqual([]);
    });

    it('resets the idle timeout after every valid stream response', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;
      b['exec'] = async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'first';
          await new Promise((resolve) => setTimeout(resolve, 30));
          yield 'second';
          await new Promise(() => {});
        },
      });

      const stream = a.stream('idle', { timeout: 250, idleTimeout: 50 });
      const chunks: string[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      const error = new Promise<Error>((resolve) => stream.once('error', resolve));
      stream.resume();

      await expect(Promise.race([
        error,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('stream did not become idle')), 200)),
      ])).resolves.toBeInstanceOf(TimeoutException);
      expect(chunks).toEqual(['first', 'second']);
    });

    it('rejects legacy uncredited streams that do not negotiate version 1', async () => {
      const modem = new TestModem();
      modem['exec'] = async () => ({
        async *[Symbol.asyncIterator]() {
          yield 1;
          yield 2;
          yield 3;
        },
      });

      modem.receive({
        id: 7,
        mode: MESSAGE_MODEM_TYPE.REQUEST,
        twoway: true,
        stream: true,
        data: 'legacy',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(modem.posted.filter(({ mode }) => mode === MESSAGE_MODEM_TYPE.RESPONSE))
        .toEqual([expect.objectContaining({
          streamVersion: 1,
          data: expect.objectContaining({ status: 400, final: true }),
        })]);
    });

    it('resumes the producer one credit at a time as chunks are consumed', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;
      let nextCalls = 0;
      b['exec'] = async () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls++;
              if (nextCalls > 3) return { done: true, value: undefined };
              return { done: false, value: nextCalls };
            },
          };
        },
      });

      const stream = a.stream('credit');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nextCalls).toBe(1);

      expect(stream.read()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nextCalls).toBe(2);

      expect(stream.read()).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nextCalls).toBe(3);

      const chunks: number[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      await new Promise<void>((resolve) => stream.once('end', resolve));
      expect(chunks).toEqual([3]);
      expect(nextCalls).toBe(4);
    });

    it('calls iterator.return and aborts the handler when a paused consumer closes', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;
      let nextCalls = 0;
      const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
      let handlerSignal: AbortSignal | undefined;
      b['exec'] = async (_data: any, signal: AbortSignal) => {
        handlerSignal = signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                nextCalls++;
                return { done: false, value: nextCalls };
              },
              return: iteratorReturn,
            };
          },
        };
      };

      const stream = a.stream('close');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(nextCalls).toBe(1);

      stream.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(handlerSignal?.aborted).toBe(true);
      expect(iteratorReturn).toHaveBeenCalledTimes(1);
      expect(b['aborts'].size).toBe(0);
    });

    it('aborts the producer when a for-await consumer breaks early', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;
      const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
      let handlerSignal: AbortSignal | undefined;
      b['exec'] = async (_data: any, signal: AbortSignal) => {
        handlerSignal = signal;
        let value = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { done: false, value: ++value };
              },
              return: iteratorReturn,
            };
          },
        };
      };

      for await (const chunk of a.stream('break')) {
        expect(chunk).toBe(1);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(handlerSignal?.aborted).toBe(true);
      expect(iteratorReturn).toHaveBeenCalledTimes(1);
    });

    it('does not post a request when the external signal is already aborted', async () => {
      const modem = new TestModem();
      const controller = new AbortController();
      controller.abort();

      const stream = modem.stream('already-aborted', { signal: controller.signal });
      const error = new Promise<Error>((resolve) => stream.once('error', resolve));
      stream.resume();

      await expect(error).resolves.toBeInstanceOf(AbortException);
      expect(modem.posted).toHaveLength(0);
      expect(modem['streams'].size).toBe(0);
    });

    it('ignores credits for unknown or completed stream producers', async () => {
      const modem = new TestModem();

      expect(() => modem.receive({
        id: 100,
        mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
        twoway: false,
        data: { id: 999, seq: 0 },
      })).not.toThrow();
      expect(modem['streamProducers'].size).toBe(0);
    });

    it('caps duplicate credits so a peer cannot bypass stream backpressure', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;
      let nextCalls = 0;
      b['exec'] = async () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls++;
              return { done: false, value: nextCalls };
            },
          };
        },
      });
      const stream = a.stream('duplicate-credit');
      stream.on('error', () => {});
      await new Promise((resolve) => setTimeout(resolve, 20));

      b.receive({ id: 10, mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT, twoway: false, data: { id: 0, seq: 0 } });
      b.receive({ id: 11, mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT, twoway: false, data: { id: 0, seq: 0 } });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(nextCalls).toBe(2);
      stream.destroy();
    });

    it('cleans producer and consumer stream state after normal completion', async () => {
      const { a, b } = createPair();
      b['exec'] = async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'done';
        },
      });

      const chunks: string[] = [];
      for await (const chunk of a.stream('complete')) chunks.push(chunk);
      await new Promise((resolve) => setImmediate(resolve));

      expect(chunks).toEqual(['done']);
      expect(a['streams'].size).toBe(0);
      expect(b['streamProducers'].size).toBe(0);
      expect(b['aborts'].size).toBe(0);
    });
  });

  describe('onStreamResponse - empty chunk data', () => {
    it('ignores unknown stream response id', () => {
      const modem = new TestModem();
      modem.receive({
        id: 999,
        mode: MESSAGE_MODEM_TYPE.RESPONSE,
        stream: true,
        data: { status: 200, seq: 0, payload: 'data', final: true },
        twoway: false,
      });
      // no throw = pass
      expect(true).toBe(true);
    });
    it('null chunk data destroys stream with 404', async () => {
      const modem = new TestModem();
      const stream = modem.stream('data');
      const errorSpy = vi.fn();
      stream.on('error', errorSpy);

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.RESPONSE,
        stream: true,
        data: null,
        twoway: false,
      });

      await new Promise<void>(r => stream.on('close', () => r()));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    });

    it('rejects out-of-order stream chunks and aborts the producer', async () => {
      const modem = new TestModem();
      const stream = modem.stream('data');
      const error = new Promise<Error>((resolve) => stream.once('error', resolve));
      stream.resume();

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.RESPONSE,
        stream: true,
        data: { status: 200, seq: 1, payload: 'unexpected', final: false },
        twoway: false,
      });

      await expect(error).resolves.toMatchObject({ status: 409 });
      expect(modem.posted).toContainEqual(expect.objectContaining({
        mode: MESSAGE_MODEM_TYPE.ABORT,
        data: 0,
      }));
    });
  });

  describe('abort guard in onRequest', () => {
    it('abort before exec resolves prevents RESPONSE', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      let resolveExec!: (v: string) => void;
      b['exec'] = () => new Promise(r => { resolveExec = r });

      // Fire request — don't await (no RESPONSE will come back)
      a.send('test');

      // Let onRequest set up the controller
      await new Promise(r => setImmediate(r));

      // Abort the request on b's side
      b.receive({ id: 99, mode: MESSAGE_MODEM_TYPE.ABORT, twoway: false, data: 0 });

      await new Promise(r => setImmediate(r));

      // Resolve exec — .then fires but abort guard returns early
      resolveExec('late');

      await new Promise(r => setImmediate(r));

      // b should not have posted any RESPONSE for id 0
      const bResponses = b.posted.filter(m => m.mode === MESSAGE_MODEM_TYPE.RESPONSE);
      expect(bResponses).toHaveLength(0);
    });
  });

  describe('_dispose cleanup', () => {
    it('_dispose rejects pending requests', async () => {
      const modem = new TestModem();
      const promise = modem.send('pending');

      modem['_dispose']();

      await expect(promise).rejects.toThrow('Abort');
    });

    it('_dispose aborts active controllers and streams', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      // Make b's exec never resolve so abort controllers stay in the map
      b['exec'] = () => new Promise(() => {});

      // a sends a request to b → b creates an abort controller
      a.send('request').catch(() => {});
      await new Promise(r => setTimeout(r, 50));

      expect(b['aborts'].size).toBe(1);

      // a creates a stream → b creates another abort controller
      const stream = a.stream('stream-data');
      stream.on('error', () => {}); // prevent unhandled error on destroy
      stream.resume();
      await new Promise(r => setTimeout(r, 50));

      expect(b['aborts'].size).toBe(2);
      expect(a['streams'].size).toBe(1);

      b['_dispose']();
      expect(b['aborts'].size).toBe(0);
      expect(b['stacks'].size).toBe(0);

      // a has streams registered — disposing a covers stream.destroy
      a['_dispose']();
      expect(a['streams'].size).toBe(0);
    });
  });

  describe('id overflow', () => {
    it('createIncrementId resets after MAX_SAFE_INTEGER', () => {
      const modem = new TestModem();
      modem['id'] = Number.MAX_SAFE_INTEGER - 1;

      // Post-increment makes this.id = MAX_SAFE_INTEGER, overflow check fires, resets to 0
      const id1 = modem['createIncrementId']();
      expect(id1).toBe(0);
      expect(modem['id']).toBe(0);

      // Second call starts fresh from 0
      const id2 = modem['createIncrementId']();
      expect(id2).toBe(0);
      expect(modem['id']).toBe(1);
    });
  });

  describe('push with error', () => {
    it('push with exec error does not send RESPONSE', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;

      b['exec'] = async () => { throw new Exception(500, 'push error'); };

      a.push('will-fail');
      await new Promise(r => setTimeout(r, 50));

      const bResponses = b.posted.filter(m => m.mode === MESSAGE_MODEM_TYPE.RESPONSE);
      expect(bResponses).toHaveLength(0);
    });
  });
});
