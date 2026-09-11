export type HttpFieldEntry = readonly [name: string, value: string];

export const MAX_HTTP_FIELD_ENTRIES = 256;

export type HttpFieldInput =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | Iterable<HttpFieldEntry>;

export type HttpFieldValues = Readonly<Record<string, string | readonly string[]>>;

function isIterable(value: object): value is Iterable<unknown> {
  return Symbol.iterator in value && typeof value[Symbol.iterator] === 'function';
}

function appendEntry(
  entries: Array<[string, string]>,
  name: unknown,
  value: unknown,
  normalizeName: boolean,
): void {
  if (entries.length >= MAX_HTTP_FIELD_ENTRIES) {
    throw new TypeError(`HTTP fields must not contain more than ${MAX_HTTP_FIELD_ENTRIES} entries`);
  }
  if (typeof name !== 'string' || typeof value !== 'string') {
    throw new TypeError('HTTP field names and values must be strings');
  }
  entries.push([normalizeName ? name.toLowerCase() : name, value]);
}

function normalizeEntries(
  input: HttpFieldInput | undefined,
  normalizeName: boolean,
): Array<[string, string]> {
  if (input === undefined) return [];
  if (!input || typeof input !== 'object') {
    throw new TypeError('HTTP fields must be a record or an iterable of string pairs');
  }

  const entries: Array<[string, string]> = [];
  if (isIterable(input)) {
    for (const pair of input) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new TypeError('HTTP field iterables must contain [name, value] pairs');
      }
      appendEntry(entries, pair[0], pair[1], normalizeName);
    }
    return entries;
  }

  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      appendEntry(entries, name, value, normalizeName);
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError('HTTP field record values must be strings or string arrays');
    }
    for (const item of value) appendEntry(entries, name, item, normalizeName);
  }
  return entries;
}

/** Normalizes header names to lowercase while preserving duplicate values. */
export function normalizeHttpHeaders(input?: HttpFieldInput): Array<[string, string]> {
  return normalizeEntries(input, true);
}

/** Preserves query-key casing and duplicate values. */
export function normalizeHttpQuery(input?: HttpFieldInput): Array<[string, string]> {
  return normalizeEntries(input, false);
}

/** Converts duplicate entries to string arrays without losing their order. */
export function httpFieldsToRecord(entries: readonly HttpFieldEntry[]): HttpFieldValues {
  const output: Record<string, string | readonly string[]> = Object.create(null);
  for (const [name, value] of entries) {
    const current = output[name];
    if (current === undefined) output[name] = value;
    else if (typeof current === 'string') output[name] = [current, value];
    else output[name] = [...current, value];
  }
  return output;
}
