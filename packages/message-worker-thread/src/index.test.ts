import { describe, it, expect, vi, afterEach } from 'vitest'
import { MessageChannel } from 'node:worker_threads'
import { MessageWorkerThread } from './index'
import { Exception } from '@hile/message-modem'

class EchoWorkerThread extends MessageWorkerThread {
  protected exec(data: any): Promise<any> {
    return Promise.resolve(data);
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

class CustomWorkerThread extends MessageWorkerThread {
  public execFn: (data: any) => Promise<any> = async (d) => d;
  protected exec(data: any): Promise<any> {
    return this.execFn(data);
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

function createPair() {
  const { port1, port2 } = new MessageChannel();
  const main = new EchoWorkerThread(port1);
  const worker = new EchoWorkerThread(port2);
  return { main, worker, port1, port2 };
}

function createCustomPair(workerExec: (data: any) => Promise<any>) {
  const { port1, port2 } = new MessageChannel();
  const main = new EchoWorkerThread(port1);
  const worker = new CustomWorkerThread(port2);
  worker.execFn = workerExec;
  return { main, worker, port1, port2 };
}

describe('@hile/message-worker-thread', () => {
  const disposables: MessageWorkerThread[] = [];
  const ports: { close: () => void }[] = [];

  afterEach(() => {
    disposables.forEach(d => d.dispose());
    disposables.length = 0;
    ports.forEach(p => p.close());
    ports.length = 0;
  });

  function track(m: MessageWorkerThread, w: MessageWorkerThread, p1: any, p2: any) {
    disposables.push(m, w);
    ports.push(p1, p2);
  }

  describe('constructor', () => {
    it('throws if parentPort is not available and no port provided', () => {
      expect(() => {
        new EchoWorkerThread(undefined as any);
      }).toThrow('parentPort is not available');
    });
  });

  describe('request / response', () => {
    it('echo round trip', async () => {
      const { main, worker, port1, port2 } = createPair();
      track(main, worker, port1, port2);

      const result = await main.request('hello').response();
      expect(result).toBe('hello');
    });

    it('handles complex data', async () => {
      const { main, worker, port1, port2 } = createPair();
      track(main, worker, port1, port2);

      const payload = { users: [{ id: 1, name: 'Alice' }], total: 1 };
      const result = await main.request(payload).response();
      expect(result).toEqual(payload);
    });

    it('transforms data in exec', async () => {
      const { main, worker, port1, port2 } = createCustomPair(async (n) => n * 2);
      track(main, worker, port1, port2);

      const result = await main.request(21).response();
      expect(result).toBe(42);
    });

    it('multiple sequential requests', async () => {
      const { main, worker, port1, port2 } = createPair();
      track(main, worker, port1, port2);

      expect(await main.request(1).response()).toBe(1);
      expect(await main.request(2).response()).toBe(2);
      expect(await main.request(3).response()).toBe(3);
    });

    it('multiple concurrent requests', async () => {
      const { main, worker, port1, port2 } = createPair();
      track(main, worker, port1, port2);

      const [a, b, c] = await Promise.all([
        main.request('a').response(),
        main.request('b').response(),
        main.request('c').response(),
      ]);
      expect(a).toBe('a');
      expect(b).toBe('b');
      expect(c).toBe('c');
    });

    it('worker can also send requests to main', async () => {
      const { port1, port2 } = new MessageChannel();
      const main = new CustomWorkerThread(port1);
      main.execFn = async (data) => `main got: ${data}`;
      const worker = new EchoWorkerThread(port2);
      track(main, worker, port1, port2);

      const result = await worker.request('ping').response();
      expect(result).toBe('main got: ping');
    });

    it('supports typed response generic', async () => {
      const { main, worker, port1, port2 } = createCustomPair(async () => ({ id: 1, name: 'test' }));
      track(main, worker, port1, port2);

      const result = await main.request(null).response<{ id: number; name: string }>();
      expect(result.id).toBe(1);
      expect(result.name).toBe('test');
    });
  });

  describe('error handling', () => {
    it('Exception in exec preserves status', async () => {
      const { main, worker, port1, port2 } = createCustomPair(async () => {
        throw new Exception(403, 'forbidden');
      });
      track(main, worker, port1, port2);

      try {
        await main.request('x').response();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(Exception);
        expect((e as Exception).status).toBe(403);
        expect((e as Exception).message).toBe('forbidden');
      }
    });

    it('generic Error maps to status 500', async () => {
      const { main, worker, port1, port2 } = createCustomPair(async () => {
        throw new Error('oops');
      });
      track(main, worker, port1, port2);

      try {
        await main.request('x').response();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(Exception);
        expect((e as Exception).status).toBe(500);
        expect((e as Exception).message).toBe('oops');
      }
    });
  });

  describe('abort', () => {
    it('abort rejects with AbortException', async () => {
      const { main, worker, port1, port2 } = createCustomPair(
        () => new Promise((r) => setTimeout(() => r('slow'), 10000))
      );
      track(main, worker, port1, port2);

      const req = main.request('data');
      const promise = req.response();
      req.abort();
      await expect(promise).rejects.toThrow('Abort');
    });
  });

  describe('timeout', () => {
    it('times out if no response', async () => {
      const { main, worker, port1, port2 } = createCustomPair(
        () => new Promise((r) => setTimeout(() => r('late'), 10000))
      );
      track(main, worker, port1, port2);

      await expect(
        main.request('data', 50).response()
      ).rejects.toThrow();
    });
  });

  describe('dispose', () => {
    it('removes message listener from port', () => {
      const { port1, port2 } = new MessageChannel();
      const before = port1.listenerCount('message');

      const modem = new EchoWorkerThread(port1);
      expect(port1.listenerCount('message')).toBe(before + 1);

      modem.dispose();
      expect(port1.listenerCount('message')).toBe(before);
      port1.close();
      port2.close();
    });
  });
});
