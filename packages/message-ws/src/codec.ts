import {
  MESSAGE_MODEM_TYPE,
  type MessageStreamChunk,
  type MessageTransferFormat,
} from '@hile/message-modem';

const FRAME_MAGIC_BYTES = Buffer.from([0x48, 0x49, 0x4c, 0x45]);
const MAX_HEADER_BYTES = 1024 * 1024;

export const HILE_MESSAGE_FRAME_MAGIC = Buffer.from(FRAME_MAGIC_BYTES);
export const HILE_MESSAGE_FRAME_VERSION = 1;
export const HILE_MESSAGE_FRAME_HEADER_SIZE = FRAME_MAGIC_BYTES.length + 1 + 4;

export type MessageFrameErrorCode =
  | 'ERR_MESSAGE_FRAME_JSON'
  | 'ERR_MESSAGE_FRAME_TRUNCATED'
  | 'ERR_MESSAGE_FRAME_MAGIC'
  | 'ERR_MESSAGE_FRAME_VERSION'
  | 'ERR_MESSAGE_FRAME_HEADER_LENGTH'
  | 'ERR_MESSAGE_FRAME_ENVELOPE';

export class MessageFrameError extends Error {
  public readonly code: MessageFrameErrorCode;

  constructor(code: MessageFrameErrorCode, message: string) {
    super(message);
    this.name = 'MessageFrameError';
    this.code = code;
  }
}

function fail(code: MessageFrameErrorCode, message: string): never {
  throw new MessageFrameError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBinaryPayload(value: unknown): value is Uint8Array {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail('ERR_MESSAGE_FRAME_JSON', 'message frame contains invalid JSON');
  }
}

function toBuffer(raw: Buffer | ArrayBuffer | Buffer[] | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === 'string') return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

type BinaryStreamResponse = MessageTransferFormat<MessageStreamChunk<Uint8Array>> & {
  mode: MESSAGE_MODEM_TYPE.RESPONSE;
  stream: true;
  streamVersion: 1;
  data: MessageStreamChunk<Uint8Array>;
};

function isBinaryStreamResponse(
  message: MessageTransferFormat,
): message is BinaryStreamResponse {
  return message.mode === MESSAGE_MODEM_TYPE.RESPONSE
    && message.stream === true
    && message.streamVersion === 1
    && isRecord(message.data)
    && isBinaryPayload(message.data.payload);
}

function validateBinaryEnvelope(value: unknown): asserts value is MessageTransferFormat<MessageStreamChunk> {
  if (!isRecord(value)) {
    fail('ERR_MESSAGE_FRAME_ENVELOPE', 'binary frame header must be an object');
  }
  if (
    !Number.isSafeInteger(value.id)
    || (value.id as number) < 0
    || value.mode !== MESSAGE_MODEM_TYPE.RESPONSE
    || value.twoway !== false
    || value.stream !== true
    || value.streamVersion !== 1
    || !isRecord(value.data)
  ) {
    fail('ERR_MESSAGE_FRAME_ENVELOPE', 'binary frame header is not a stream response');
  }
  if (Object.prototype.hasOwnProperty.call(value.data, 'payload')) {
    fail('ERR_MESSAGE_FRAME_ENVELOPE', 'binary frame header must not contain an inline payload');
  }
  if (
    !Number.isSafeInteger(value.data.seq)
    || (value.data.seq as number) < 0
    || typeof value.data.final !== 'boolean'
    || !(
      typeof value.data.status === 'string'
      || typeof value.data.status === 'number'
    )
  ) {
    fail('ERR_MESSAGE_FRAME_ENVELOPE', 'binary frame chunk metadata is invalid');
  }
}

export function encodeMessageFrame(message: MessageTransferFormat): string | Buffer {
  if (!isBinaryStreamResponse(message)) return JSON.stringify(message);

  const payload = Buffer.from(
    message.data.payload.buffer,
    message.data.payload.byteOffset,
    message.data.payload.byteLength,
  );
  const { payload: _payload, ...chunkHeader } = message.data;
  const header = Buffer.from(JSON.stringify({
    ...message,
    data: chunkHeader,
  }));
  if (header.length === 0 || header.length > MAX_HEADER_BYTES) {
    fail('ERR_MESSAGE_FRAME_HEADER_LENGTH', 'binary frame header is too large');
  }

  const frame = Buffer.allocUnsafe(HILE_MESSAGE_FRAME_HEADER_SIZE + header.length + payload.length);
  FRAME_MAGIC_BYTES.copy(frame, 0);
  frame.writeUInt8(HILE_MESSAGE_FRAME_VERSION, FRAME_MAGIC_BYTES.length);
  frame.writeUInt32BE(header.length, FRAME_MAGIC_BYTES.length + 1);
  header.copy(frame, HILE_MESSAGE_FRAME_HEADER_SIZE);
  payload.copy(frame, HILE_MESSAGE_FRAME_HEADER_SIZE + header.length);
  return frame;
}

export function decodeMessageFrame(
  raw: Buffer | ArrayBuffer | Buffer[] | Uint8Array | string,
  isBinary: boolean,
  options: { copyBinaryPayload?: boolean } = {},
): MessageTransferFormat {
  const bytes = toBuffer(raw);
  if (!isBinary) {
    return parseJson(bytes.toString('utf8')) as MessageTransferFormat;
  }
  if (bytes.length < HILE_MESSAGE_FRAME_HEADER_SIZE) {
    fail('ERR_MESSAGE_FRAME_TRUNCATED', 'binary frame is shorter than its fixed header');
  }
  if (!bytes.subarray(0, FRAME_MAGIC_BYTES.length).equals(FRAME_MAGIC_BYTES)) {
    fail('ERR_MESSAGE_FRAME_MAGIC', 'binary frame has an invalid magic value');
  }
  const version = bytes.readUInt8(FRAME_MAGIC_BYTES.length);
  if (version !== HILE_MESSAGE_FRAME_VERSION) {
    fail('ERR_MESSAGE_FRAME_VERSION', `unsupported binary frame version: ${version}`);
  }
  const headerLength = bytes.readUInt32BE(FRAME_MAGIC_BYTES.length + 1);
  if (
    headerLength === 0
    || headerLength > MAX_HEADER_BYTES
    || HILE_MESSAGE_FRAME_HEADER_SIZE + headerLength > bytes.length
  ) {
    fail('ERR_MESSAGE_FRAME_HEADER_LENGTH', 'binary frame header length is invalid');
  }

  const headerEnd = HILE_MESSAGE_FRAME_HEADER_SIZE + headerLength;
  const envelope = parseJson(
    bytes.subarray(HILE_MESSAGE_FRAME_HEADER_SIZE, headerEnd).toString('utf8'),
  );
  validateBinaryEnvelope(envelope);
  const payload = bytes.subarray(headerEnd);
  return {
    ...envelope,
    data: {
      ...envelope.data,
      payload: options.copyBinaryPayload === false ? payload : Buffer.from(payload),
    },
  };
}
