import { createHash } from 'node:crypto';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'string') return `string:${JSON.stringify(value)}`;
  if (type === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${String(value)}`;
  }
  if (type === 'boolean') return `boolean:${String(value)}`;
  if (type === 'bigint') return `bigint:${String(value)}`;
  if (type === 'symbol' || type === 'function') {
    throw new TypeError(`stableHash does not support ${type} values`);
  }

  if (typeof value !== 'object') {
    return `${type}:${String(value)}`;
  }

  if (seen.has(value)) {
    throw new TypeError('stableHash does not support circular values');
  }
  seen.add(value);

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('stableHash does not support invalid Date values');
    seen.delete(value);
    return `date:${value.toISOString()}`;
  }

  if (Buffer.isBuffer(value)) {
    seen.delete(value);
    return `buffer:${value.toString('base64')}`;
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) throw new TypeError('stableHash does not support sparse arrays');
      items.push(stableStringify(value[i], seen));
    }
    const result = `array:[${items.join(',')}]`;
    seen.delete(value);
    return result;
  }

  if (!isPlainObject(value)) {
    seen.delete(value);
    throw new TypeError(`stableHash does not support ${Object.prototype.toString.call(value)} values`);
  }

  const object = value;
  const keys = Object.keys(object).sort();
  const result = `object:{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(object[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
