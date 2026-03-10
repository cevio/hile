import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { MessageIpc } from './index'
import { Exception } from '@hile/message-modem'

class EchoIpc extends MessageIpc {
  protected exec(data: any): Promise<any> {
    return Promise.resolve(data);
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

class CustomIpc extends MessageIpc {
  public execFn: (data: any) => Promise<any> = async (d) => d;
  protected exec(data: any): Promise<any> {
    return this.execFn(data);
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

/**
 * 模拟 IPC 通道：两个 EventEmitter 互相连接，
 * 一端 send() 时另一端触发 'message' 事件。
 */
function createMockChannel() {
  const parentEmitter = new EventEmitter();
  const childEmitter = new EventEmitter();

  const parentSide = Object.assign(childEmitter, {
    send: (data: any) => parentEmitter.emit('message', data),
  });
  const childSide = Object.assign(parentEmitter, {
    send: (data: any) => childEmitter.emit('message', data),
  });

  return { parentSide, childSide } as {
    parentSide: any;
    childSide: any;
  };
}

function createEchoPair() {
  const { parentSide, childSide } = createMockChannel();
  const parent = new EchoIpc(parentSide);
  const child = new EchoIpc(childSide);
  return { parent, child, parentSide, childSide };
}

function createCustomPair(childExec: (data: any) => Promise<any>) {
  const { parentSide, childSide } = createMockChannel();
  const parent = new EchoIpc(parentSide);
  const child = new CustomIpc(childSide);
  child.execFn = childExec;
  return { parent, child, parentSide, childSide };
}

describe('@hile/message-ipc', () => {
  const disposables: MessageIpc[] = [];

  afterEach(() => {
    disposables.forEach(d => d.dispose());
    disposables.length = 0;
  });

  function track(...ipcs: MessageIpc[]) {
    disposables.push(...ipcs);
  }

  describe('constructor & post guard', () => {
    it('throws if IPC channel has no send method', () => {
      const noSend = new EventEmitter() as any;
      const modem = new EchoIpc(noSend);
      track(modem);

      expect(() => {
        (modem as any).post({ id: 0, mode: 0, twoway: true, data: null });
      }).toThrow('IPC channel is not available');
    });
  });

  describe('request / response', () => {
    it('echo round trip', async () => {
      const { parent, child } = createEchoPair();
      track(parent, child);

      const result = await parent.request('hello').response();
      expect(result).toBe('hello');
    });

    it('handles complex data', async () => {
      const { parent, child } = createEchoPair();
      track(parent, child);

      const payload = { users: [{ id: 1, name: 'Alice' }], total: 1 };
      const result = await parent.request(payload).response();
      expect(result).toEqual(payload);
    });

    it('transforms data in exec', async () => {
      const { parent, child } = createCustomPair(async (n) => n * 2);
      track(parent, child);

      const result = await parent.request(21).response();
      expect(result).toBe(42);
    });

    it('multiple sequential requests', async () => {
      const { parent, child } = createEchoPair();
      track(parent, child);

      expect(await parent.request(1).response()).toBe(1);
      expect(await parent.request(2).response()).toBe(2);
      expect(await parent.request(3).response()).toBe(3);
    });

    it('multiple concurrent requests', async () => {
      const { parent, child } = createEchoPair();
      track(parent, child);

      const [a, b, c] = await Promise.all([
        parent.request('a').response(),
        parent.request('b').response(),
        parent.request('c').response(),
      ]);
      expect(a).toBe('a');
      expect(b).toBe('b');
      expect(c).toBe('c');
    });

    it('child can also send requests to parent', async () => {
      const { parentSide, childSide } = createMockChannel();
      const parent = new CustomIpc(parentSide);
      parent.execFn = async (data) => `parent got: ${data}`;
      const child = new EchoIpc(childSide);
      track(parent, child);

      const result = await child.request('ping').response();
      expect(result).toBe('parent got: ping');
    });

    it('supports typed response generic', async () => {
      const { parent, child } = createCustomPair(async () => ({ id: 1, name: 'test' }));
      track(parent, child);

      const result = await parent.request(null).response<{ id: number; name: string }>();
      expect(result.id).toBe(1);
      expect(result.name).toBe('test');
    });
  });

  describe('error handling', () => {
    it('Exception in exec preserves status', async () => {
      const { parent, child } = createCustomPair(async () => {
        throw new Exception(403, 'forbidden');
      });
      track(parent, child);

      try {
        await parent.request('x').response();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(Exception);
        expect((e as Exception).status).toBe(403);
        expect((e as Exception).message).toBe('forbidden');
      }
    });

    it('generic Error maps to status 500', async () => {
      const { parent, child } = createCustomPair(async () => {
        throw new Error('oops');
      });
      track(parent, child);

      try {
        await parent.request('x').response();
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
      const { parent, child } = createCustomPair(
        () => new Promise((r) => setTimeout(() => r('slow'), 10000))
      );
      track(parent, child);

      const req = parent.request('data');
      const promise = req.response();
      req.abort();
      await expect(promise).rejects.toThrow('Abort');
    });
  });

  describe('timeout', () => {
    it('times out if no response', async () => {
      const { parent, child } = createCustomPair(
        () => new Promise((r) => setTimeout(() => r('late'), 10000))
      );
      track(parent, child);

      await expect(
        parent.request('data', 50).response()
      ).rejects.toThrow();
    });
  });

  describe('dispose', () => {
    it('removes message listener from channel', () => {
      const emitter = new EventEmitter();
      const channel = Object.assign(emitter, { send: vi.fn() }) as any;
      const before = emitter.listenerCount('message');

      const modem = new EchoIpc(channel);
      expect(emitter.listenerCount('message')).toBe(before + 1);

      modem.dispose();
      expect(emitter.listenerCount('message')).toBe(before);
    });
  });
});
