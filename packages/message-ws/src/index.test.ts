import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { MessageWs } from './index'
import { Exception } from '@hile/message-modem'

class EchoWs extends MessageWs {
  protected exec(data: any): Promise<any> {
    return Promise.resolve(data);
  }

  public request<T = any>(data: any, options?: number | { timeout?: number; signal?: AbortSignal }) {
    if (typeof options === 'number') {
      return this._send<T>(data, { timeout: options });
    }
    return this._send<T>(data, { timeout: options?.timeout, signal: options?.signal });
  }

  public stream(data: any, options?: { signal?: AbortSignal }) {
    return this._stream(data, options);
  }
}

class CustomWs extends MessageWs {
  public execFn: (data: any) => Promise<any> = async (d) => d;
  protected exec(data: any): Promise<any> {
    return this.execFn(data);
  }

  public request<T = any>(data: any, options?: number | { timeout?: number; signal?: AbortSignal }) {
    if (typeof options === 'number') {
      return this._send<T>(data, { timeout: options });
    }
    return this._send<T>(data, { timeout: options?.timeout, signal: options?.signal });
  }

  public stream(data: any, options?: { signal?: AbortSignal }) {
    return this._stream(data, options);
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

describe('@hile/message-ws', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    // 绑定 127.0.0.1，避免部分环境下 ::1 / 代理对 localhost 升级返回非 101
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', r));
    const addr = wss.address();
    port = typeof addr === 'object' ? addr!.port : 0;
  });

  afterEach(async () => {
    wss.clients.forEach((c) => c.close());
    await new Promise<void>((r) => wss.close(() => r()));
  });

  function connectPair(): Promise<{ client: WebSocket; server: WebSocket }> {
    return new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      const onErr = (err: Error) => reject(err);
      client.once('error', onErr);
      wss.once('connection', (server) => {
        client.off('error', onErr);
        resolve({ client, server });
      });
    });
  }

  describe('post guard', () => {
    it('throws if WebSocket is not open', async () => {
      const { client } = await connectPair();
      await waitForOpen(client);
      const modem = new EchoWs(client);
      client.close();
      await new Promise<void>((r) => client.once('close', r));

      expect(() => {
        (modem as any).post({ id: 0, mode: 0, twoway: true, data: null });
      }).toThrow('WebSocket is not open');
      modem.dispose();
    });
  });

  describe('request / response', () => {
    it('echo round trip', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new EchoWs(server);

      const result = await clientModem.request('hello');
      expect(result).toBe('hello');

      clientModem.dispose();
      serverModem.dispose();
    });

    it('handles complex data', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new EchoWs(server);

      const payload = { users: [{ id: 1, name: 'Alice' }], total: 1 };
      const result = await clientModem.request(payload);
      expect(result).toEqual(payload);

      clientModem.dispose();
      serverModem.dispose();
    });

    it('transforms data in exec', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = async (n) => n * 2;

      const result = await clientModem.request(21);
      expect(result).toBe(42);

      clientModem.dispose();
      serverModem.dispose();
    });

    it('multiple sequential requests', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new EchoWs(server);

      expect(await clientModem.request(1)).toBe(1);
      expect(await clientModem.request(2)).toBe(2);
      expect(await clientModem.request(3)).toBe(3);

      clientModem.dispose();
      serverModem.dispose();
    });

    it('multiple concurrent requests', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new EchoWs(server);

      const [a, b, c] = await Promise.all([
        clientModem.request('a'),
        clientModem.request('b'),
        clientModem.request('c'),
      ]);
      expect(a).toBe('a');
      expect(b).toBe('b');
      expect(c).toBe('c');

      clientModem.dispose();
      serverModem.dispose();
    });

    it('server can also send requests to client', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new CustomWs(client);
      clientModem.execFn = async (data) => `client got: ${data}`;
      const serverModem = new EchoWs(server);

      const result = await serverModem.request('ping');
      expect(result).toBe('client got: ping');

      clientModem.dispose();
      serverModem.dispose();
    });

    it('supports typed response generic', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = async () => ({ id: 1, name: 'test' });

      const result = await clientModem.request<{ id: number; name: string }>(null);
      expect(result.id).toBe(1);
      expect(result.name).toBe('test');

      clientModem.dispose();
      serverModem.dispose();
    });
  });

  describe('binary streams', () => {
    it('round trips multiple binary chunks byte-for-byte', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);
      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = async () => ({
        async *[Symbol.asyncIterator]() {
          yield Buffer.from([0, 1, 2, 255]);
          yield new Uint8Array([3, 4, 5]);
          yield Buffer.alloc(0);
        },
      });

      const chunks: Buffer[] = [];
      for await (const chunk of clientModem.stream('flight')) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        Buffer.from([0, 1, 2, 255]),
        Buffer.from([3, 4, 5]),
        Buffer.alloc(0),
      ]);
      clientModem.dispose();
      serverModem.dispose();
    });

    it('preserves mixed text and binary chunk order', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);
      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = async () => ({
        async *[Symbol.asyncIterator]() {
          yield 'begin';
          yield Buffer.from('flight');
          yield { end: true };
        },
      });

      const chunks: any[] = [];
      for await (const chunk of clientModem.stream('mixed')) chunks.push(chunk);

      expect(chunks[0]).toBe('begin');
      expect(chunks[1]).toEqual(Buffer.from('flight'));
      expect(chunks[2]).toEqual({ end: true });
      clientModem.dispose();
      serverModem.dispose();
    });

    it('supports a binary stream while JSON requests are in flight', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);
      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = async (value) => {
        if (value === 'stream') {
          return {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from('a');
              await new Promise((resolve) => setTimeout(resolve, 10));
              yield Buffer.from('b');
            },
          };
        }
        return `json:${value}`;
      };

      const streamChunks: Buffer[] = [];
      const consume = (async () => {
        for await (const chunk of clientModem.stream('stream')) streamChunks.push(chunk);
      })();
      const responses = await Promise.all([
        clientModem.request('one'),
        clientModem.request('two'),
      ]);
      await consume;

      expect(responses).toEqual(['json:one', 'json:two']);
      expect(streamChunks).toEqual([Buffer.from('a'), Buffer.from('b')]);
      clientModem.dispose();
      serverModem.dispose();
    });
  });

  describe('error handling', () => {
    it('closes the connection with a protocol error for a malformed binary frame', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);
      const modem = new EchoWs(client);
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        server.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      server.send(Buffer.from('not-a-hile-frame'));

      await expect(closed).resolves.toEqual({ code: 1002, reason: 'Invalid Hile message frame' });
      modem.dispose();
    });

    it('Exception in exec preserves status', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = async () => { throw new Exception(403, 'forbidden'); };

      try {
        await clientModem.request('x');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(Exception);
        expect((e as Exception).status).toBe(403);
        expect((e as Exception).message).toBe('forbidden');
      }

      clientModem.dispose();
      serverModem.dispose();
    });

    it('generic Error maps to status 500', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = async () => { throw new Error('oops'); };

      try {
        await clientModem.request('x');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(Exception);
        expect((e as Exception).status).toBe(500);
        expect((e as Exception).message).toBe('oops');
      }

      clientModem.dispose();
      serverModem.dispose();
    });
  });

  describe('abort', () => {
    it('abort rejects with AbortException', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = () => new Promise((r) => setTimeout(() => r('slow'), 10000));

      const controller = new AbortController();
      const promise = clientModem.request('data', { signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toThrow('Abort');

      clientModem.dispose();
      serverModem.dispose();
    });
  });

  describe('timeout', () => {
    it('times out if no response', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const clientModem = new EchoWs(client);
      const serverModem = new CustomWs(server);
      serverModem.execFn = () => new Promise((r) => setTimeout(() => r('late'), 10000));

      await expect(
        clientModem.request('data', 100)      ).rejects.toThrow();

      clientModem.dispose();
      serverModem.dispose();
    });
  });

  describe('dispose', () => {
    it('removes message listener from ws', async () => {
      const { client, server } = await connectPair();
      await waitForOpen(client);

      const before = client.listenerCount('message');
      const modem = new EchoWs(client);
      expect(client.listenerCount('message')).toBe(before + 1);

      modem.dispose();
      expect(client.listenerCount('message')).toBe(before);
    });
  });
});
