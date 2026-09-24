import { HILE_RSC_DOCUMENT_METADATA_LIMITS } from './constants';

export type RscDocumentMetadataPrimitive = string | number | boolean | null;

export type RscDocumentMetadataValue =
  | RscDocumentMetadataPrimitive
  | readonly RscDocumentMetadataValue[]
  | { readonly [key: string]: RscDocumentMetadataValue };

/** Framework-neutral data returned by a route for the Host-owned document head. */
export type RscDocumentMetadata = Readonly<Record<string, RscDocumentMetadataValue>>;

interface MetadataBudget {
  nodes: number;
  stringBytes: number;
}

const encoder = new TextEncoder();

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineOwnValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function consumeNode(budget: MetadataBudget, depth: number): void {
  if (depth > HILE_RSC_DOCUMENT_METADATA_LIMITS.depth) {
    throw new TypeError('RSC document metadata exceeds maximum depth');
  }
  if (++budget.nodes > HILE_RSC_DOCUMENT_METADATA_LIMITS.nodes) {
    throw new TypeError('RSC document metadata exceeds maximum node count');
  }
}

function consumeString(budget: MetadataBudget, value: string): void {
  budget.stringBytes += encoder.encode(value).byteLength;
  if (budget.stringBytes > HILE_RSC_DOCUMENT_METADATA_LIMITS.stringBytes) {
    throw new TypeError('RSC document metadata exceeds maximum string bytes');
  }
}

function cloneValue(
  value: unknown,
  budget: MetadataBudget,
  depth: number,
  ancestors: WeakSet<object>,
): RscDocumentMetadataValue {
  consumeNode(budget, depth);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    consumeString(budget, value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('RSC document metadata numbers must be finite');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`RSC document metadata ${typeof value} values are not serializable`);
  }
  if (ancestors.has(value)) {
    throw new TypeError('RSC document metadata cyclic values are not serializable');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > HILE_RSC_DOCUMENT_METADATA_LIMITS.nodes - budget.nodes) {
        throw new TypeError('RSC document metadata exceeds maximum node count');
      }
      const result: RscDocumentMetadataValue[] = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('RSC document metadata sparse arrays are not serializable');
        }
        result.push(cloneValue(value[index], budget, depth + 1, ancestors));
      }
      return Object.freeze(result);
    }
    if (!isPlainObject(value)) {
      throw new TypeError('RSC document metadata supports only plain objects and arrays');
    }
    const result: Record<string, RscDocumentMetadataValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key.length > HILE_RSC_DOCUMENT_METADATA_LIMITS.keyLength) {
        throw new TypeError('RSC document metadata key exceeds maximum length');
      }
      consumeString(budget, key);
      defineOwnValue(result, key, cloneValue(entry, budget, depth + 1, ancestors));
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

/** Validates, bounds, clones, and freezes metadata before or after transport. */
export function validateRscDocumentMetadata(value: unknown): RscDocumentMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('RSC document metadata must be a serializable object');
  }
  return cloneValue(
    value,
    { nodes: 0, stringBytes: 0 },
    0,
    new WeakSet(),
  ) as RscDocumentMetadata;
}
