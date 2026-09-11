import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { MessageIpc } from './index'
import { Exception, type MessageInput } from '@hile/message-modem'

class EchoIpc extends MessageIpc {
  protected exec(data: any): Promise<any> {
    return Promise.resolve(data);
  }

  public request<T = any>(data: any, options?: number | {
    timeout?: number;
    signal?: AbortSignal;
    input?: MessageInput;
  }) {
    if (typeof options === 'number') {
      return this._send<T>(data, { timeout: options });
    }
    return this._send<T>(data, {
      timeout: options?.timeout,
      signal: options?.signal,
      input: options?.input,
    });
  }
}

class CustomIpc extends MessageIpc {
  public execFn: (data: any, signal?: AbortSignal, input?: Readable) => Promise<any> = async (d) => d;
  protected exec(data: any, signal?: AbortSignal, input?: Readable): Promise<any> {
    return this.execFn(data, signal, input);
  }

  public request<T = any>(data: any, options?: number | { timeout?: number; signal?: AbortSignal }) {
    if (typeof options === 'number') {
      return this._send<T>(data, { timeout: options });
    }
    return this._send<T>(data, { timeout: options?.timeout, signal: options?.signal });
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

function createJsonMockChannel() {
  const parentEmitter = new EventEmitter();
  const childEmitter = new EventEmitter();
  const clone = (data: unknown) => JSON.parse(JSON.stringify(data));

  const parentSide = Object.assign(childEmitter, {
    send: (data: any) => parentEmitter.emit('message', clone(data)),
  });
  const childSide = Object.assign(parentEmitter, {
    send: (data: any) => childEmitter.emit('message', clone(data)),
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

    it('uses process as default channel when none provided', () => {
      const onSpy = vi.spyOn(process, 'on');
      const modem = new EchoIpc();
      track(modem);
      expect(onSpy).toHaveBeenCalledWith('message', expect.any(Function));
      onSpy.mockRestore();
    });
  });

  describe('request / response', () => {
    it('echo round trip', async () => {
      const { parent, child } = createEchoPair();
      track(parent, child);

      const result = await parent.request('hello');
      expect(result).toBe('hello');
    });

    it('handles complex data', async () => {
      const { parent, child } = createEchoPair();
      track(parent, child);

      const payload = { users: [{ id: 1, name: 'Alice' }], total: 1 };
      const result = await parent.request(payload);
      expect(result).toEqual(payload);
    });

    it('transforms data in exec', async () => {
      const { parent, child } = createCustomPair(async (n) => n * 2);
      track(parent, child);

      const result = await parent.request(21);
      expect(result).toBe(42);
    });

    it('multiple sequential requests', async () => {
      const { parent, child } = createEchoPair();
      track(parent, child);

      expect(await parent.request(1)).toBe(1);
      expect(await parent.request(2)).toBe(2);
      expect(await parent.request(3)).toBe(3);
    });

    it('multiple concurrent requests', async () => {
      const { parent, child } = createEchoPair();
      track(parent, child);

      const [a, b, c] = await Promise.all([
        parent.request('a'),
        parent.request('b'),
        parent.request('c'),
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

      const result = await child.request('ping');
      expect(result).toBe('parent got: ping');
    });

    it('supports typed response generic', async () => {
      const { parent, child } = createCustomPair(async () => ({ id: 1, name: 'test' }));
      track(parent, child);

      const result = await parent.request<{ id: number; name: string }>(null);
      expect(result.id).toBe(1);
      expect(result.name).toBe('test');
    });

    it('preserves binary request-stream chunks through default JSON IPC serialization', async () => {
      const { parentSide, childSide } = createJsonMockChannel();
      const parent = new EchoIpc(parentSide);
      const child = new CustomIpc(childSide);
      child.execFn = async (_data, _signal, input) => {
        const chunks: Buffer[] = [];
        for await (const chunk of input ?? []) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString('hex');
      };
      track(parent, child);

      await expect(parent.request(
        { filename: 'bytes.bin' },
        { input: Readable.from([new Uint8Array([0, 1, 2, 255])]) },
      )).resolves.toBe('000102ff');
    });
  });

  describe('error handling', () => {
    it('Exception in exec preserves status', async () => {
      const { parent, child } = createCustomPair(async () => {
        throw new Exception(403, 'forbidden');
      });
      track(parent, child);

      try {
        await parent.request('x');
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
        await parent.request('x');
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

      const controller = new AbortController();
      const promise = parent.request('data', { signal: controller.signal });
      controller.abort();
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
        parent.request('data', 50)      ).rejects.toThrow();
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
