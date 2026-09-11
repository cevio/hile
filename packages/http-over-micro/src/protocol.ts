import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { HttpOverMicroError } from './errors';
import { MAX_HTTP_FIELD_ENTRIES, type HttpFieldEntry } from './fields';

export const HTTP_OVER_MICRO_PROTOCOL = '@hile/http-over-micro' as const;
export const HTTP_OVER_MICRO_VERSION = 1 as const;
export const DEFAULT_MAX_INLINE_BODY_BYTES = 1024 * 1024;

export interface HttpOverMicroLimits {
  maxInlineBodyBytes?: number;
}

const MAX_METHOD_LENGTH = 64;
const MAX_FIELD_NAME_LENGTH = 256;
const MAX_FIELD_VALUE_LENGTH = 16 * 1024;
const MAX_FIELDS_BYTES = 64 * 1024;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type HttpOverMicroBodyDescriptor<T = unknown> =
  | { kind: 'empty' }
  | { kind: 'inline'; value: T }
  | { kind: 'stream' };

export interface HttpOverMicroRequestEnvelope<T = unknown> {
  protocol: typeof HTTP_OVER_MICRO_PROTOCOL;
  version: typeof HTTP_OVER_MICRO_VERSION;
  type: 'request';
  method: string;
  headers: readonly HttpFieldEntry[];
  query: readonly HttpFieldEntry[];
  body: HttpOverMicroBodyDescriptor<T>;
}

export interface HttpOverMicroResponseHead<T = unknown> {
  protocol: typeof HTTP_OVER_MICRO_PROTOCOL;
  version: typeof HTTP_OVER_MICRO_VERSION;
  type: 'response';
  status: number;
  headers: readonly HttpFieldEntry[];
  body: HttpOverMicroBodyDescriptor<T>;
}

const methodSchema = z.string()
  .min(1)
  .max(MAX_METHOD_LENGTH)
  .regex(HTTP_TOKEN)
  .transform(value => value.toUpperCase());

const headerEntrySchema = z.tuple([
  z.string().min(1).max(MAX_FIELD_NAME_LENGTH).regex(HTTP_TOKEN)
    .refine(value => value === value.toLowerCase(), 'Header names must be lowercase'),
  z.string().max(MAX_FIELD_VALUE_LENGTH).refine(value => !/[\r\n\0]/.test(value), 'Invalid header value'),
]);

const queryEntrySchema = z.tuple([
  z.string().max(MAX_FIELD_NAME_LENGTH).refine(value => !value.includes('\0'), 'Invalid query name'),
  z.string().max(MAX_FIELD_VALUE_LENGTH).refine(value => !value.includes('\0'), 'Invalid query value'),
]);

function boundedEntries(schema: typeof headerEntrySchema | typeof queryEntrySchema) {
  return z.array(schema).max(MAX_HTTP_FIELD_ENTRIES).superRefine((entries, context) => {
    let bytes = 0;
    for (const [name, value] of entries) {
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (bytes > MAX_FIELDS_BYTES) {
        context.addIssue({ code: 'custom', message: `HTTP fields must not exceed ${MAX_FIELDS_BYTES} bytes` });
        return;
      }
    }
  });
}

const bodyDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }).strict(),
  z.object({ kind: z.literal('inline'), value: z.unknown() }).strict()
    .refine(body => body.value !== undefined, 'Inline body value must not be undefined'),
  z.object({ kind: z.literal('stream') }).strict(),
]);

export const httpOverMicroRequestEnvelopeSchema = z.object({
  protocol: z.literal(HTTP_OVER_MICRO_PROTOCOL),
  version: z.literal(HTTP_OVER_MICRO_VERSION),
  type: z.literal('request'),
  method: methodSchema,
  headers: boundedEntries(headerEntrySchema),
  query: boundedEntries(queryEntrySchema),
  body: bodyDescriptorSchema,
}).strict();

export const httpOverMicroResponseHeadSchema = z.object({
  protocol: z.literal(HTTP_OVER_MICRO_PROTOCOL),
  version: z.literal(HTTP_OVER_MICRO_VERSION),
  type: z.literal('response'),
  status: z.number().int().min(200).max(599),
  headers: boundedEntries(headerEntrySchema),
  body: bodyDescriptorSchema,
}).strict();

export function normalizeHttpMethod(value: string): string {
  const parsed = methodSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpOverMicroError('INVALID_REQUEST', 400, 'Invalid HTTP method', { cause: parsed.error });
  }
  return parsed.data;
}

export function resolveInlineBodyLimit(value?: number): number {
  if (value === undefined) return DEFAULT_MAX_INLINE_BODY_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('maxInlineBodyBytes must be a positive safe integer');
  }
  return value;
}

export function httpResponseMustBeEmpty(method: string, status: number): boolean {
  return method === 'HEAD' || status === 204 || status === 205 || status === 304;
}

export function snapshotInlineBody(
  value: unknown,
  maxBytes: number,
  subject: 'request' | 'response',
): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new HttpOverMicroError(
      subject === 'request' ? 'INVALID_REQUEST' : 'INVALID_RESPONSE',
      subject === 'request' ? 400 : 500,
      `${subject === 'request' ? 'Request' : 'Response'} inline body must be JSON-serializable`,
      { cause },
    );
  }
  if (serialized === undefined) {
    throw new HttpOverMicroError(
      subject === 'request' ? 'INVALID_REQUEST' : 'INVALID_RESPONSE',
      subject === 'request' ? 400 : 500,
      `${subject === 'request' ? 'Request' : 'Response'} inline body must be JSON-serializable`,
    );
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxBytes) {
    throw new HttpOverMicroError(
      subject === 'request' ? 'INVALID_REQUEST' : 'INVALID_RESPONSE',
      subject === 'request' ? 413 : 500,
      `${subject === 'request' ? 'Request' : 'Response'} inline body exceeds ${maxBytes} bytes`,
    );
  }
  return JSON.parse(serialized);
}
