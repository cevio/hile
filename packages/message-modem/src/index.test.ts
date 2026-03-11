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

  public send<T>(data: T, timeout?: number) {
    return super._send(data, timeout);
  }

  public push<T>(data: T, timeout?: number): void {
    super._push(data, timeout);
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
      const result = await a.send('hello').response();
      expect(result).toBe('hello');
    });

    it('handles complex data', async () => {
      const { a, b } = createPair();
      const payload = { user: 'test', items: [1, 2, 3] };
      const result = await a.send(payload).response();
      expect(result).toEqual(payload);
    });

    it('multiple sequential requests', async () => {
      const { a, b } = createPair();
      const r1 = await a.send(1).response();
      const r2 = await a.send(2).response();
      const r3 = await a.send(3).response();
      expect(r1).toBe(1);
      expect(r2).toBe(2);
      expect(r3).toBe(3);
    });

    it('multiple concurrent requests', async () => {
      const { a, b } = createPair();
      const [r1, r2, r3] = await Promise.all([
        a.send('a').response(),
        a.send('b').response(),
        a.send('c').response(),
      ]);
      expect(r1).toBe('a');
      expect(r2).toBe('b');
      expect(r3).toBe('c');
    });

    it('bidirectional communication', async () => {
      const pair1 = createPair();
      const pair2 = createPair();
      const fromA = await pair1.a.send('from-a').response();
      const fromB = await pair2.b.send('from-b').response();
      expect(fromA).toBe('from-a');
      expect(fromB).toBe('from-b');
    });
  });

  describe('message format', () => {
    it('REQUEST message has correct format', () => {
      const modem = new TestModem();
      modem.send('test');
      const msg = modem.posted[0];
      expect(msg.mode).toBe(MESSAGE_MODEM_TYPE.REQUEST);
      expect(msg.twoway).toBe(true);
      expect(msg.data).toBe('test');
      expect(typeof msg.id).toBe('number');
    });

    it('message IDs auto-increment', () => {
      const modem = new TestModem();
      modem.send('a');
      modem.send('b');
      modem.send('c');
      expect(modem.posted[0].id).toBe(0);
      expect(modem.posted[1].id).toBe(1);
      expect(modem.posted[2].id).toBe(2);
    });
  });

  describe('error handling', () => {
    it('Exception in exec returns status and message', async () => {
      const { a, b } = createPair();
      b['exec'] = async () => { throw new Exception(403, 'forbidden'); };

      await expect(a.send('x').response()).rejects.toThrow('forbidden');
      try {
        await a.send('x').response();
      } catch (e) {
        expect(e).toBeInstanceOf(Exception);
        expect((e as Exception).status).toBe(403);
      }
    });

    it('generic Error in exec returns status 500', async () => {
      const { a, b } = createPair();
      b['exec'] = async () => { throw new Error('internal'); };

      try {
        await a.send('x').response();
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
      const req = a.send('test');
      const promise = req.response();
      req.abort();
      await expect(promise).rejects.toThrow('Abort');
    });

    it('abort sends ABORT message to peer', async () => {
      const a = new TestModem();
      const req = a.send('test');
      const promise = req.response().catch(() => {});
      req.abort();
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
      const req = a.send('slow');
      const promise = req.response();

      await new Promise(r => setTimeout(r, 50));
      req.abort();

      await expect(promise).rejects.toThrow('Abort');
    });
  });

  describe('timeout', () => {
    it('times out if no response within timeout period', async () => {
      const modem = new TestModem();
      await expect(modem.send('data', 50).response()).rejects.toThrow();
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
      modem.send('request');
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
});
