import { describe, expect, it } from 'vitest';
import {
  MESSAGE_MODEM_TYPE,
  type MessageTransferFormat,
} from '@hile/message-modem';
import {
  HILE_MESSAGE_FRAME_HEADER_SIZE,
  HILE_MESSAGE_FRAME_MAGIC,
  HILE_MESSAGE_FRAME_VERSION,
  MessageFrameError,
  decodeMessageFrame,
  encodeMessageFrame,
} from './codec';

function binaryMessage(payload: Uint8Array): MessageTransferFormat {
  return {
    id: 7,
    mode: MESSAGE_MODEM_TYPE.RESPONSE,
    twoway: false,
    stream: true,
    streamVersion: 1,
    data: {
      status: 200,
      seq: 3,
      payload,
      final: false,
    },
  };
}

function expectFrameError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('expected MessageFrameError');
  } catch (error) {
    expect(error).toBeInstanceOf(MessageFrameError);
    expect(error).toMatchObject({ code });
  }
}

describe('message-ws frame codec', () => {
  it('keeps ordinary request messages as JSON text', () => {
    const message: MessageTransferFormat = {
      id: 1,
      mode: MESSAGE_MODEM_TYPE.REQUEST,
      twoway: true,
      data: { text: 'hello' },
    };

    const encoded = encodeMessageFrame(message);

    expect(typeof encoded).toBe('string');
    expect(decodeMessageFrame(Buffer.from(encoded), false)).toEqual(message);
  });

  it('keeps non-binary stream chunks as JSON text', () => {
    const message: MessageTransferFormat = {
      id: 1,
      mode: MESSAGE_MODEM_TYPE.RESPONSE,
      twoway: false,
      stream: true,
      streamVersion: 1,
      data: { status: 200, seq: 0, payload: 'text', final: false },
    };

    expect(typeof encodeMessageFrame(message)).toBe('string');
  });

  it('keeps binary stream chunks on JSON for a legacy peer without protocol negotiation', () => {
    const message = binaryMessage(Buffer.from([1, 2, 3]));
    delete message.streamVersion;

    expect(typeof encodeMessageFrame(message)).toBe('string');
  });

  it('keeps Buffer payloads outside stream responses on the legacy JSON path', () => {
    const message: MessageTransferFormat = {
      id: 1,
      mode: MESSAGE_MODEM_TYPE.REQUEST,
      twoway: true,
      data: Buffer.from([1, 2, 3]),
    };

    const encoded = encodeMessageFrame(message);

    expect(typeof encoded).toBe('string');
    expect(JSON.parse(encoded as string).data).toEqual({ type: 'Buffer', data: [1, 2, 3] });
  });

  it.each([
    Buffer.from([0, 1, 2, 255]),
    new Uint8Array([4, 5, 6]),
    new Uint8Array(0),
  ])('round trips a binary stream payload without base64: %j', (payload) => {
    const message = binaryMessage(payload);

    const encoded = encodeMessageFrame(message);
    const decoded = decodeMessageFrame(encoded, true);

    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect(decoded).toMatchObject({
      id: 7,
      mode: MESSAGE_MODEM_TYPE.RESPONSE,
      stream: true,
      data: { status: 200, seq: 3, final: false },
    });
    expect(Buffer.from((decoded.data as any).payload)).toEqual(Buffer.from(payload));
  });

  it('respects Uint8Array byteOffset and byteLength', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const view = backing.subarray(1, 4);

    const decoded = decodeMessageFrame(encodeMessageFrame(binaryMessage(view)), true);

    expect((decoded.data as any).payload).toEqual(Buffer.from([1, 2, 3]));
  });

  it('supports unicode JSON metadata beside binary payload', () => {
    const message = binaryMessage(Buffer.from('flight'));
    (message.data as any).diagnostic = '上海/插件';

    const decoded = decodeMessageFrame(encodeMessageFrame(message), true);

    expect((decoded.data as any).diagnostic).toBe('上海/插件');
  });

  it('does not mutate the source message or payload', () => {
    const payload = Buffer.from([1, 2, 3]);
    const message = binaryMessage(payload);
    const before = {
      message: { ...(message.data as object) },
      payload: Buffer.from(payload),
    };

    encodeMessageFrame(message);

    expect(message.data).toEqual(before.message);
    expect(payload).toEqual(before.payload);
  });

  it('writes a stable magic, version, and big-endian header length', () => {
    const encoded = encodeMessageFrame(binaryMessage(Buffer.from([1]))) as Buffer;

    expect(encoded.subarray(0, HILE_MESSAGE_FRAME_MAGIC.length))
      .toEqual(HILE_MESSAGE_FRAME_MAGIC);
    expect(encoded.readUInt8(HILE_MESSAGE_FRAME_MAGIC.length)).toBe(HILE_MESSAGE_FRAME_VERSION);
    const headerLength = encoded.readUInt32BE(HILE_MESSAGE_FRAME_MAGIC.length + 1);
    expect(headerLength).toBeGreaterThan(0);
    expect(HILE_MESSAGE_FRAME_HEADER_SIZE + headerLength).toBeLessThanOrEqual(encoded.length);
  });

  it('decodes fragmented ws RawData arrays', () => {
    const encoded = encodeMessageFrame(binaryMessage(Buffer.from([1, 2, 3]))) as Buffer;
    const fragments = [encoded.subarray(0, 2), encoded.subarray(2, 8), encoded.subarray(8)];

    const decoded = decodeMessageFrame(fragments, true);

    expect((decoded.data as any).payload).toEqual(Buffer.from([1, 2, 3]));
  });

  it('decodes ArrayBuffer input', () => {
    const encoded = encodeMessageFrame(binaryMessage(Buffer.from([1, 2, 3]))) as Buffer;
    const arrayBuffer = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    );

    const decoded = decodeMessageFrame(arrayBuffer, true);

    expect((decoded.data as any).payload).toEqual(Buffer.from([1, 2, 3]));
  });

  it('rejects invalid JSON text frames with a structured error', () => {
    expectFrameError(
      () => decodeMessageFrame(Buffer.from('{not-json'), false),
      'ERR_MESSAGE_FRAME_JSON',
    );
  });

  it('rejects binary frames shorter than the fixed header', () => {
    expectFrameError(
      () => decodeMessageFrame(Buffer.alloc(HILE_MESSAGE_FRAME_HEADER_SIZE - 1), true),
      'ERR_MESSAGE_FRAME_TRUNCATED',
    );
  });

  it('rejects an invalid binary magic', () => {
    const encoded = encodeMessageFrame(binaryMessage(Buffer.from([1]))) as Buffer;
    encoded[0] ^= 0xff;

    expectFrameError(() => decodeMessageFrame(encoded, true), 'ERR_MESSAGE_FRAME_MAGIC');
  });

  it('rejects an unsupported binary frame version', () => {
    const encoded = encodeMessageFrame(binaryMessage(Buffer.from([1]))) as Buffer;
    encoded.writeUInt8(HILE_MESSAGE_FRAME_VERSION + 1, HILE_MESSAGE_FRAME_MAGIC.length);

    expectFrameError(() => decodeMessageFrame(encoded, true), 'ERR_MESSAGE_FRAME_VERSION');
  });

  it.each([0, 0xffffffff])('rejects impossible header length %s', (headerLength) => {
    const encoded = encodeMessageFrame(binaryMessage(Buffer.from([1]))) as Buffer;
    encoded.writeUInt32BE(headerLength, HILE_MESSAGE_FRAME_MAGIC.length + 1);

    expectFrameError(() => decodeMessageFrame(encoded, true), 'ERR_MESSAGE_FRAME_HEADER_LENGTH');
  });

  it('rejects invalid JSON in a binary header', () => {
    const header = Buffer.from('{');
    const frame = Buffer.alloc(HILE_MESSAGE_FRAME_HEADER_SIZE + header.length);
    HILE_MESSAGE_FRAME_MAGIC.copy(frame);
    frame.writeUInt8(HILE_MESSAGE_FRAME_VERSION, HILE_MESSAGE_FRAME_MAGIC.length);
    frame.writeUInt32BE(header.length, HILE_MESSAGE_FRAME_MAGIC.length + 1);
    header.copy(frame, HILE_MESSAGE_FRAME_HEADER_SIZE);

    expectFrameError(() => decodeMessageFrame(frame, true), 'ERR_MESSAGE_FRAME_JSON');
  });

  it.each([
    null,
    [],
    { id: 1, mode: MESSAGE_MODEM_TYPE.REQUEST, stream: true, data: {} },
    { id: 1, mode: MESSAGE_MODEM_TYPE.RESPONSE, stream: false, data: {} },
    { id: 1, mode: MESSAGE_MODEM_TYPE.RESPONSE, stream: true, data: null },
    {
      id: 1,
      mode: MESSAGE_MODEM_TYPE.RESPONSE,
      stream: true,
      data: { payload: 'ambiguous' },
    },
  ])('rejects a binary header with an invalid envelope: %j', (headerValue) => {
    const header = Buffer.from(JSON.stringify(headerValue));
    const frame = Buffer.alloc(HILE_MESSAGE_FRAME_HEADER_SIZE + header.length);
    HILE_MESSAGE_FRAME_MAGIC.copy(frame);
    frame.writeUInt8(HILE_MESSAGE_FRAME_VERSION, HILE_MESSAGE_FRAME_MAGIC.length);
    frame.writeUInt32BE(header.length, HILE_MESSAGE_FRAME_MAGIC.length + 1);
    header.copy(frame, HILE_MESSAGE_FRAME_HEADER_SIZE);

    expectFrameError(() => decodeMessageFrame(frame, true), 'ERR_MESSAGE_FRAME_ENVELOPE');
  });
});
