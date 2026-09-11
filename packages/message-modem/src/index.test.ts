import { Readable } from 'node:stream'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MessageModem,
  MESSAGE_MODEM_TYPE,
  type MessageInput,
  type MessageTransferFormat,
  Exception,
  AbortException,
  MessageInputError,
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

  protected async exec(data: any, _signal?: AbortSignal, _input?: Readable): Promise<any> {
    return data;
  }

  public send<T>(data: T, options?: number | {
    timeout?: number;
    signal?: AbortSignal;
    input?: MessageInput;
  }) {
    if (typeof options === 'number') {
      return super._send(data, { timeout: options });
    }
    return super._send(data, {
      timeout: options?.timeout,
      signal: options?.signal,
      input: options?.input,
    });
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
    input?: MessageInput;
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

    it('rejects a pending request with an explicit protocol error for a malformed response', async () => {
      const modem = new TestModem();
      const request = modem.send('data');

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.RESPONSE,
        twoway: false,
        data: null,
      });

      await expect(request).rejects.toMatchObject({
        status: 502,
        message: 'Invalid response frame',
      });
      expect(modem['stacks'].size).toBe(0);
    });
  });

  describe('stream', () => {
    it('appends stream frame types without changing existing message type values', () => {
      expect(MESSAGE_MODEM_TYPE.REQUEST).toBe(0);
      expect(MESSAGE_MODEM_TYPE.RESPONSE).toBe(1);
      expect(MESSAGE_MODEM_TYPE.ABORT).toBe(2);
      expect(MESSAGE_MODEM_TYPE.STREAM_CREDIT).toBe(3);
      expect(MESSAGE_MODEM_TYPE.STREAM_DATA).toBe(4);
      expect(MESSAGE_MODEM_TYPE.STREAM_CANCEL).toBe(5);
    });

    it('declares streamed output on the REQUEST frame', () => {
      const modem = new TestModem();
      modem.stream('data');
      const msg = modem.posted.find(m => m.mode === MESSAGE_MODEM_TYPE.REQUEST);
      expect(msg?.streams).toEqual({ output: {} });
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
        m => m.mode === MESSAGE_MODEM_TYPE.STREAM_DATA && m.data?.status === 500
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

    it.each([null, undefined])('rejects an output stream chunk that Node Readable cannot represent: %s', async (value) => {
      const { a, b } = createPair();
      b['exec'] = async function* () {
        yield value;
      };

      const stream = a.stream('data');
      const error = new Promise<Error>((resolve) => stream.once('error', resolve));
      stream.resume();

      await expect(error).resolves.toMatchObject({
        status: 500,
        message: expect.stringContaining('null or undefined'),
      });
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
      expect(b.posted.filter((msg) => msg.mode === MESSAGE_MODEM_TYPE.STREAM_DATA)).toHaveLength(1);
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
        .toMatchObject({ streams: { output: { window: 4 } } });
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
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        twoway: false,
        data: { direction: 'output', status: 200, seq, payload: seq, final: false },
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
        id: 0,
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

    it('rejects an invalid output window on the request frame', async () => {
      const modem = new TestModem();

      modem.receive({
        id: 7,
        mode: MESSAGE_MODEM_TYPE.REQUEST,
        twoway: true,
        streams: { output: { window: 65 } },
        data: 'legacy',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(modem.posted.filter(({ mode }) => mode === MESSAGE_MODEM_TYPE.STREAM_DATA))
        .toEqual([expect.objectContaining({
          data: expect.objectContaining({ direction: 'output', status: 400, final: true }),
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

    it('releases a producer immediately when iterator.next never settles', async () => {
      const a = new TestModem();
      const b = new TestModem();
      a.peer = b;
      b.peer = a;
      const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
      b['exec'] = async () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<unknown>>(() => {}),
            return: iteratorReturn,
          };
        },
      });

      const stream = a.stream('stuck-next');
      await new Promise((resolve) => setImmediate(resolve));
      expect(b['streamProducers'].size).toBe(1);

      stream.destroy();
      await new Promise((resolve) => setImmediate(resolve));

      expect(iteratorReturn).toHaveBeenCalledTimes(1);
      expect(b['streamProducers'].size).toBe(0);
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
        data: { direction: 'output', seq: 0, window: 1 },
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

      b.receive({ id: 0, mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT, twoway: false, data: { direction: 'output', seq: 0, window: 1 } });
      b.receive({ id: 0, mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT, twoway: false, data: { direction: 'output', seq: 0, window: 1 } });
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

  describe('request input stream', () => {
    it('streams request input and resolves a normal response', async () => {
      const { a, b } = createPair();
      b['exec'] = async (data: unknown, _signal: AbortSignal, input?: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of input ?? []) chunks.push(Buffer.from(chunk));
        return { data, body: Buffer.concat(chunks).toString('utf8') };
      };

      const result = await a.send(
        { filename: 'hello.txt' },
        { input: Readable.from([Buffer.from('hello'), Buffer.from(' world')]) },
      );

      expect(result).toEqual({
        data: { filename: 'hello.txt' },
        body: 'hello world',
      });
      expect(a.posted[0]).toMatchObject({
        mode: MESSAGE_MODEM_TYPE.REQUEST,
        streams: { input: true },
      });
    });

    it('automatically treats an async iterable argument as request input', async () => {
      const { a, b } = createPair();
      b['exec'] = async (data: unknown, _signal: AbortSignal, input?: Readable) => {
        const chunks: string[] = [];
        for await (const chunk of input ?? []) chunks.push(String(chunk));
        return { data, chunks };
      };

      const result = await a.send(Readable.from(['a', 'b']));

      expect(result).toEqual({ data: undefined, chunks: ['a', 'b'] });
    });

    it('automatically sends Uint8Array input as one binary chunk', async () => {
      const { a, b } = createPair();
      b['exec'] = async (_data: unknown, _signal: AbortSignal, input?: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of input ?? []) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString('hex');
      };

      await expect(a.send(new Uint8Array([0, 1, 2, 255])))
        .resolves.toBe('000102ff');
    });

    it('rejects two competing request input streams before posting', () => {
      const modem = new TestModem();

      expect(() => modem.send(
        Readable.from(['data-stream']),
        { input: Readable.from(['option-stream']) },
      )).toThrow('only one request input stream');
      expect(modem.posted).toEqual([]);
    });

    it('supports streamed input together with streamed output', async () => {
      const { a, b } = createPair();
      b['exec'] = async function* (
        _data: unknown,
        _signal: AbortSignal,
        input?: Readable,
      ) {
        for await (const chunk of input ?? []) {
          yield Buffer.from(chunk).toString('utf8').toUpperCase();
        }
      };

      const output = a.stream(
        { operation: 'uppercase' },
        { input: Readable.from(['one', 'two']) },
      );
      const chunks: string[] = [];
      for await (const chunk of output) chunks.push(chunk);

      expect(chunks).toEqual(['ONE', 'TWO']);
    });

    it('does not pull an unconsumed request body without input credit', async () => {
      const { a, b } = createPair();
      let nextCalls = 0;
      const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
      const source = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              nextCalls++;
              return { done: false as const, value: Buffer.from('chunk') };
            },
            return: iteratorReturn,
          };
        },
      };
      b['exec'] = async () => 'accepted-without-reading';

      await expect(a.send({ filename: 'ignored.bin' }, { input: source }))
        .resolves.toBe('accepted-without-reading');
      await new Promise((resolve) => setImmediate(resolve));

      expect(nextCalls).toBeLessThanOrEqual(1);
      expect(iteratorReturn).toHaveBeenCalledTimes(1);
    });

    it('rejects the request and aborts the peer when its input source fails', async () => {
      const { a, b } = createPair();
      let handlerSignal: AbortSignal | undefined;
      b['exec'] = async (_data: unknown, signal: AbortSignal, input?: Readable) => {
        handlerSignal = signal;
        for await (const _chunk of input ?? []) {
          // Consume until the source fails.
        }
        return 'unexpected';
      };
      const source = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('first');
          throw new Error('upload source failed');
        },
      };

      await expect(a.send({ filename: 'broken.bin' }, { input: source }))
        .rejects.toMatchObject({
          name: 'MessageInputError',
          message: 'upload source failed',
          cause: expect.any(Error),
        } satisfies Partial<MessageInputError>);
      await new Promise((resolve) => setImmediate(resolve));

      expect(handlerSignal?.aborted).toBe(true);
    });

    it.each([null, undefined])('rejects an input stream chunk that Node Readable cannot represent: %s', async (value) => {
      const { a, b } = createPair();
      b['exec'] = async (_data: unknown, _signal: AbortSignal, input?: Readable) => {
        for await (const _chunk of input ?? []) {
          // Consume until input validation fails.
        }
        return 'unexpected';
      };
      const source = {
        async *[Symbol.asyncIterator]() {
          yield value;
        },
      };

      await expect(a.send({ filename: 'invalid.bin' }, { input: source }))
        .rejects.toMatchObject({
          name: 'MessageInputError',
          message: expect.stringContaining('null or undefined'),
        });
    });

    it('returns the request input iterator when the caller aborts', async () => {
      const { a, b } = createPair();
      const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
      const source = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: false as const, value: Buffer.from('first') }),
            return: iteratorReturn,
          };
        },
      };
      b['exec'] = async () => new Promise(() => {});
      const controller = new AbortController();

      const request = a.send({ filename: 'slow.bin' }, {
        input: source,
        signal: controller.signal,
      });
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();

      await expect(request).rejects.toBeInstanceOf(AbortException);
      expect(iteratorReturn).toHaveBeenCalledTimes(1);
      expect(a['inputStreamProducers'].size).toBe(0);
    });

    it('fails immediately when the receiver advertises an invalid input window', async () => {
      const modem = new TestModem();
      const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
      const source = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: false as const, value: Buffer.from('chunk') }),
            return: iteratorReturn,
          };
        },
      };
      const request = modem.send({ filename: 'invalid-credit.bin' }, {
        input: source,
        timeout: 200,
      });

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
        twoway: false,
        data: { direction: 'input', seq: 0, window: 65 },
      });

      await expect(request).rejects.toMatchObject({ status: 400 });
      expect(iteratorReturn).not.toHaveBeenCalled();
      expect(modem['inputStreamProducers'].size).toBe(0);
    });

    it('fails immediately when input credit skips a sequence number', async () => {
      const modem = new TestModem();
      const request = modem.send({ filename: 'future-credit.bin' }, {
        input: Readable.from(['body']),
        timeout: 200,
      });

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
        twoway: false,
        data: { direction: 'input', seq: 1, window: 1 },
      });

      await expect(request).rejects.toMatchObject({ status: 409 });
      expect(modem['inputStreamProducers'].size).toBe(0);
    });

    it.each([-1, 0.5])('fails immediately for invalid input credit sequence %s', async (seq) => {
      const modem = new TestModem();
      const request = modem.send({ filename: 'invalid-sequence.bin' }, {
        input: Readable.from(['body']),
        timeout: 200,
      });

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
        twoway: false,
        data: { direction: 'input', seq, window: 1 },
      });

      await expect(request).rejects.toMatchObject({ status: 400 });
      expect(modem['inputStreamProducers'].size).toBe(0);
    });

    it('fails immediately when input credits exceed the negotiated window', async () => {
      const modem = new TestModem();
      const request = modem.send({ filename: 'excess-credit.bin' }, {
        input: Readable.from(['body']),
        timeout: 200,
      });

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
        twoway: false,
        data: { direction: 'input', seq: 0, window: 1 },
      });
      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_CREDIT,
        twoway: false,
        data: { direction: 'input', seq: 1, window: 1 },
      });

      await expect(request).rejects.toMatchObject({ status: 429 });
      expect(modem['inputStreamProducers'].size).toBe(0);
    });

    it('cancels an input producer that exceeds the granted receive window', async () => {
      const modem = new TestModem();
      const inputError = vi.fn();
      modem['exec'] = async (_data: unknown, _signal: AbortSignal, input?: Readable) => {
        input?.on('error', inputError);
        return new Promise(() => {});
      };
      modem.receive({
        id: 9,
        mode: MESSAGE_MODEM_TYPE.REQUEST,
        twoway: true,
        streams: { input: true },
        data: {},
      });

      modem.receive({
        id: 9,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        twoway: false,
        data: { direction: 'input', seq: 0, payload: 'first', final: false },
      });
      modem.receive({
        id: 9,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        twoway: false,
        data: { direction: 'input', seq: 1, payload: 'overflow', final: false },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(inputError).toHaveBeenCalledWith(expect.objectContaining({ status: 429 }));
      expect(modem.posted).toContainEqual(expect.objectContaining({
        id: 9,
        mode: MESSAGE_MODEM_TYPE.STREAM_CANCEL,
        data: expect.objectContaining({ direction: 'input' }),
      }));
      expect(modem['inputStreams'].size).toBe(0);
    });

    it('fails the original request immediately when the receiver rejects its input stream', async () => {
      const { a, b } = createPair();
      b['exec'] = async () => new Promise(() => {});
      const request = a.send({ filename: 'overflow.bin' }, {
        input: Readable.from(['first']),
        timeout: 500,
      });

      b.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        twoway: false,
        data: { direction: 'input', seq: 1, payload: 'overflow', final: false },
      });

      await expect(request).rejects.toMatchObject({ status: 409 });
      expect(b['aborts'].size).toBe(0);
      expect(b['inputStreams'].size).toBe(0);
    });
  });

  describe('onStreamResponse - empty chunk data', () => {
    it('ignores unknown stream response id', () => {
      const modem = new TestModem();
      modem.receive({
        id: 999,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        data: { direction: 'output', status: 200, seq: 0, payload: 'data', final: true },
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
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
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
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        data: { direction: 'output', status: 200, seq: 1, payload: 'unexpected', final: false },
        twoway: false,
      });

      await expect(error).resolves.toMatchObject({ status: 409 });
      expect(modem.posted).toContainEqual(expect.objectContaining({
        mode: MESSAGE_MODEM_TYPE.ABORT,
        id: 0,
      }));
    });

    it('ignores chunks received after the final response frame', async () => {
      const modem = new TestModem();
      const stream = modem.stream('data');
      const errors: Error[] = [];
      stream.on('error', (error) => errors.push(error));
      const closed = new Promise<void>((resolve) => stream.once('close', resolve));
      stream.resume();

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        twoway: false,
        data: { direction: 'output', status: 200, seq: 0, final: true },
      });
      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        twoway: false,
        data: { direction: 'output', status: 200, seq: 1, payload: 'late', final: false },
      });

      await closed;
      expect(errors).toEqual([]);
    });

    it('releases completed response state even when the caller does not consume the stream', () => {
      const modem = new TestModem();
      modem.stream('data');

      modem.receive({
        id: 0,
        mode: MESSAGE_MODEM_TYPE.STREAM_DATA,
        twoway: false,
        data: { direction: 'output', status: 200, seq: 0, final: true },
      });

      expect(modem['streams'].size).toBe(0);
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
      b.receive({ id: 0, mode: MESSAGE_MODEM_TYPE.ABORT, twoway: false });

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
