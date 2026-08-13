export type RscServerFunctionWireValue = {
  type: string;
  value?: unknown;
};

export interface RscServerFunctionCodecLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxBinaryBytes?: number;
  maxStringBytes?: number;
}

interface CodecBudget {
  maxDepth: number;
  maxNodes: number;
  maxBinaryBytes: number;
  maxStringBytes: number;
  nodes: number;
  binaryBytes: number;
  stringBytes: number;
}

const textEncoder = new TextEncoder();

function createBudget(limits: RscServerFunctionCodecLimits = {}): CodecBudget {
  const values = {
    maxDepth: limits.maxDepth ?? 64,
    maxNodes: limits.maxNodes ?? 10_000,
    maxBinaryBytes: limits.maxBinaryBytes ?? 16 * 1024 * 1024,
    maxStringBytes: limits.maxStringBytes ?? 16 * 1024 * 1024,
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return { ...values, nodes: 0, binaryBytes: 0, stringBytes: 0 };
}

function consumeNode(budget: CodecBudget, depth: number): void {
  if (depth > budget.maxDepth) throw new TypeError('RSC server function value exceeds maximum depth');
  if (++budget.nodes > budget.maxNodes) throw new TypeError('RSC server function value exceeds maximum node count');
}

function consumeString(budget: CodecBudget, value: string): void {
  budget.stringBytes += textEncoder.encode(value).byteLength;
  if (budget.stringBytes > budget.maxStringBytes) throw new TypeError('RSC server function value exceeds maximum string bytes');
}

function consumeBinary(budget: CodecBudget, bytes: number): void {
  budget.binaryBytes += bytes;
  if (budget.binaryBytes > budget.maxBinaryBytes) throw new TypeError('RSC server function value exceeds maximum binary bytes');
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new TypeError('RSC wire bytes must be base64 text');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError('RSC wire bytes must be valid base64 text');
  }
  try {
    if (typeof Buffer !== 'undefined') {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.toString('base64') !== value) throw new Error('non-canonical base64');
      return Uint8Array.from(decoded);
    }
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError('RSC wire bytes must be valid base64 text');
  }
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  return Object.getPrototypeOf(value) === Object.prototype;
}

function typedArrayName(value: ArrayBufferView): string | undefined {
  if (value instanceof DataView) return 'DataView';
  const name = value.constructor.name;
  return [
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
    'BigUint64Array',
  ].includes(name) ? name : undefined;
}

async function encodeValue(
  input: unknown,
  ancestors: WeakSet<object>,
  budget: CodecBudget,
  depth: number,
): Promise<RscServerFunctionWireValue> {
  const value = await input;
  consumeNode(budget, depth);
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string') consumeString(budget, value);
    return { type: typeof value, value };
  }
  if (typeof value === 'number') {
    const encoded = Number.isNaN(value)
      ? 'nan'
      : value === Infinity
        ? 'infinity'
        : value === -Infinity
          ? '-infinity'
          : Object.is(value, -0)
            ? '-0'
            : value;
    return { type: 'number', value: encoded };
  }
  if (typeof value === 'bigint') {
    const encoded = value.toString();
    consumeString(budget, encoded);
    return { type: 'bigint', value: encoded };
  }
  if (typeof value === 'symbol') {
    const key = Symbol.keyFor(value);
    if (key === undefined) throw new TypeError('RSC server function symbols must be global');
    consumeString(budget, key);
    return { type: 'symbol', value: key };
  }
  if (typeof value === 'function') {
    throw new TypeError('RSC server function arguments cannot contain a client function');
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported RSC server function value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError('RSC server function value is cyclic');
  ancestors.add(value);
  try {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError('RSC server function date is invalid');
      const encoded = value.toISOString();
      consumeString(budget, encoded);
      return { type: 'date', value: encoded };
    }
    if (value instanceof ArrayBuffer) {
      consumeBinary(budget, value.byteLength);
      return { type: 'array-buffer', value: bytesToBase64(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      const name = typedArrayName(value);
      if (!name) throw new TypeError('Unsupported RSC typed array');
      consumeBinary(budget, value.byteLength);
      return {
        type: 'typed-array',
        value: {
          name,
          bytes: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        },
      };
    }
    if (value instanceof Map) {
      return {
        type: 'map',
        value: await Promise.all([...value].map(async ([key, entry]) => [
          await encodeValue(key, ancestors, budget, depth + 1),
          await encodeValue(entry, ancestors, budget, depth + 1),
        ])),
      };
    }
    if (value instanceof Set) {
      return {
        type: 'set',
        value: await Promise.all([...value].map((entry) => encodeValue(entry, ancestors, budget, depth + 1))),
      };
    }
    if (typeof FormData !== 'undefined' && value instanceof FormData) {
      const entries: Array<[string, RscServerFunctionWireValue]> = [];
      for (const [name, entry] of value.entries()) {
        consumeString(budget, name);
        entries.push([name, await encodeValue(entry, ancestors, budget, depth + 1)]);
      }
      return { type: 'form-data', value: entries };
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      consumeBinary(budget, value.size);
      const isFile = typeof File !== 'undefined' && value instanceof File;
      consumeString(budget, value.type);
      if (isFile) consumeString(budget, (value as File).name);
      return {
        type: isFile ? 'file' : 'blob',
        value: {
          bytes: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
          mime: value.type,
          ...(isFile ? {
            name: (value as File).name,
            lastModified: (value as File).lastModified,
          } : {}),
        },
      };
    }
    if (Array.isArray(value)) {
      return {
        type: 'array',
        value: await Promise.all(value.map((entry) => encodeValue(entry, ancestors, budget, depth + 1))),
      };
    }
    if (!isPlainObject(value)) {
      throw new TypeError('RSC server function values must be a plain object or supported built-in');
    }
    const entries = await Promise.all(Object.entries(value).map(async ([key, entry]) => [
      key,
      (consumeString(budget, key), await encodeValue(entry, ancestors, budget, depth + 1)),
    ] as const));
    return { type: 'object', value: Object.fromEntries(entries) };
  } finally {
    ancestors.delete(value);
  }
}

export function encodeRscServerFunctionValue(
  value: unknown,
  limits?: RscServerFunctionCodecLimits,
): Promise<RscServerFunctionWireValue> {
  return encodeValue(value, new WeakSet(), createBudget(limits), 0);
}

function requireWire(value: unknown): RscServerFunctionWireValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('RSC server function wire value must be an object');
  }
  const wire = value as RscServerFunctionWireValue;
  if (typeof wire.type !== 'string' || wire.type.length === 0) {
    throw new TypeError('RSC server function wire value must have a type');
  }
  return wire;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function decodeTypedArray(value: unknown, budget: CodecBudget): ArrayBufferView {
  const metadata = requireRecord(value, 'RSC typed array metadata');
  if (typeof metadata.name !== 'string') throw new TypeError('RSC typed array name is invalid');
  const bytes = base64ToBytes(metadata.bytes);
  consumeBinary(budget, bytes.byteLength);
  const buffer = ownedArrayBuffer(bytes);
  const constructors: Record<string, (buffer: ArrayBuffer) => ArrayBufferView> = {
    DataView: (entry) => new DataView(entry),
    Int8Array: (entry) => new Int8Array(entry),
    Uint8Array: (entry) => new Uint8Array(entry),
    Uint8ClampedArray: (entry) => new Uint8ClampedArray(entry),
    Int16Array: (entry) => new Int16Array(entry),
    Uint16Array: (entry) => new Uint16Array(entry),
    Int32Array: (entry) => new Int32Array(entry),
    Uint32Array: (entry) => new Uint32Array(entry),
    Float32Array: (entry) => new Float32Array(entry),
    Float64Array: (entry) => new Float64Array(entry),
    BigInt64Array: (entry) => new BigInt64Array(entry),
    BigUint64Array: (entry) => new BigUint64Array(entry),
  };
  const create = constructors[metadata.name];
  if (!create) throw new TypeError(`Unsupported RSC wire typed array: ${metadata.name}`);
  try {
    return create(buffer);
  } catch {
    throw new TypeError(`Invalid byte length for RSC wire typed array: ${metadata.name}`);
  }
}

async function decodeValue(
  value: RscServerFunctionWireValue,
  budget: CodecBudget,
  depth: number,
): Promise<unknown> {
  consumeNode(budget, depth);
  const wire = requireWire(value);
  switch (wire.type) {
    case 'null': return null;
    case 'undefined': return undefined;
    case 'string':
      if (typeof wire.value !== 'string') throw new TypeError('RSC wire string is invalid');
      consumeString(budget, wire.value);
      return wire.value;
    case 'boolean':
      if (typeof wire.value !== 'boolean') throw new TypeError('RSC wire boolean is invalid');
      return wire.value;
    case 'number':
      if (typeof wire.value === 'number') return wire.value;
      if (wire.value === 'nan') return Number.NaN;
      if (wire.value === 'infinity') return Infinity;
      if (wire.value === '-infinity') return -Infinity;
      if (wire.value === '-0') return -0;
      throw new TypeError('RSC wire number is invalid');
    case 'bigint':
      if (typeof wire.value !== 'string' || !/^-?\d+$/.test(wire.value)) {
        throw new TypeError('RSC wire bigint is invalid');
      }
      consumeString(budget, wire.value);
      return BigInt(wire.value);
    case 'symbol':
      if (typeof wire.value !== 'string') throw new TypeError('RSC wire symbol is invalid');
      consumeString(budget, wire.value);
      return Symbol.for(wire.value);
    case 'date': {
      if (typeof wire.value !== 'string') throw new TypeError('RSC wire date is invalid');
      consumeString(budget, wire.value);
      const date = new Date(wire.value);
      if (Number.isNaN(date.getTime()) || date.toISOString() !== wire.value) {
        throw new TypeError('RSC wire date is invalid');
      }
      return date;
    }
    case 'array-buffer': {
      const bytes = base64ToBytes(wire.value);
      consumeBinary(budget, bytes.byteLength);
      return ownedArrayBuffer(bytes);
    }
    case 'typed-array': return decodeTypedArray(wire.value, budget);
    case 'array':
      return Promise.all(requireArray(wire.value, 'RSC wire array')
        .map((entry) => decodeValue(entry as RscServerFunctionWireValue, budget, depth + 1)));
    case 'map': {
      const entries = requireArray(wire.value, 'RSC wire map');
      const decoded = await Promise.all(entries.map(async (entry) => {
        const pair = requireArray(entry, 'RSC wire map entry');
        if (pair.length !== 2) throw new TypeError('RSC wire map entry must contain two values');
        return [
          await decodeValue(pair[0] as RscServerFunctionWireValue, budget, depth + 1),
          await decodeValue(pair[1] as RscServerFunctionWireValue, budget, depth + 1),
        ] as const;
      }));
      return new Map(decoded);
    }
    case 'set':
      return new Set(await Promise.all(requireArray(wire.value, 'RSC wire set')
        .map((entry) => decodeValue(entry as RscServerFunctionWireValue, budget, depth + 1))));
    case 'object': {
      const record = requireRecord(wire.value, 'RSC wire object');
      return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, entry]) => [
        key,
        (consumeString(budget, key), await decodeValue(entry as RscServerFunctionWireValue, budget, depth + 1)),
      ])));
    }
    case 'form-data': {
      const formData = new FormData();
      for (const entry of requireArray(wire.value, 'RSC wire FormData')) {
        const pair = requireArray(entry, 'RSC wire FormData entry');
        if (pair.length !== 2 || typeof pair[0] !== 'string') {
          throw new TypeError('RSC wire FormData entry is invalid');
        }
        consumeString(budget, pair[0]);
        const decoded = await decodeValue(pair[1] as RscServerFunctionWireValue, budget, depth + 1);
        if (typeof decoded !== 'string' && !(decoded instanceof Blob)) {
          throw new TypeError('RSC wire FormData values must be strings or blobs');
        }
        formData.append(pair[0], decoded);
      }
      return formData;
    }
    case 'blob':
    case 'file': {
      const metadata = requireRecord(wire.value, `RSC wire ${wire.type}`);
      if (typeof metadata.mime !== 'string') throw new TypeError(`RSC wire ${wire.type} MIME type is invalid`);
      consumeString(budget, metadata.mime);
      const bytes = base64ToBytes(metadata.bytes);
      consumeBinary(budget, bytes.byteLength);
      if (wire.type === 'blob') return new Blob([ownedArrayBuffer(bytes)], { type: metadata.mime });
      if (
        typeof metadata.name !== 'string'
        || typeof metadata.lastModified !== 'number'
        || !Number.isSafeInteger(metadata.lastModified)
      ) {
        throw new TypeError('RSC wire file metadata is invalid');
      }
      consumeString(budget, metadata.name);
      return new File([ownedArrayBuffer(bytes)], metadata.name, {
        type: metadata.mime,
        lastModified: metadata.lastModified,
      });
    }
    default:
      throw new TypeError(`Unsupported RSC server function wire type: ${wire.type}`);
  }
}

export function decodeRscServerFunctionValue(
  value: RscServerFunctionWireValue,
  limits?: RscServerFunctionCodecLimits,
): Promise<unknown> {
  return decodeValue(value, createBudget(limits), 0);
}
