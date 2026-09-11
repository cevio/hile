import { Readable } from 'node:stream';
import { isMessageInput, type MessageInput } from '@hile/message-modem';
import {
  defineMicroMessage,
  type Client,
  type MicroMessageHandlerExtras,
  type MicroMessageMetadata,
} from '@hile/micro';
import type { MessageRegisterProps } from '@hile/message-loader';
import type { z } from 'zod';
import { HttpOverMicroError } from './errors';
import {
  httpFieldsToRecord,
  normalizeHttpHeaders,
  type HttpFieldInput,
  type HttpFieldValues,
} from './fields';
import {
  HTTP_OVER_MICRO_PROTOCOL,
  HTTP_OVER_MICRO_VERSION,
  httpOverMicroRequestEnvelopeSchema,
  httpOverMicroResponseHeadSchema,
  httpResponseMustBeEmpty,
  normalizeHttpMethod,
  resolveInlineBodyLimit,
  snapshotInlineBody,
  type HttpOverMicroRequestEnvelope,
  type HttpOverMicroResponseHead,
  type HttpOverMicroLimits,
} from './protocol';

export interface HttpOverMicroSchemas {
  headers?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
  body?: z.ZodType;
}

type SchemaOutput<TSchema, TFallback> = TSchema extends z.ZodType
  ? z.output<TSchema>
  : TFallback;

export interface HttpOverMicroMessageConfig<TSchemas extends HttpOverMicroSchemas = HttpOverMicroSchemas> {
  method: string | readonly string[];
  schema?: TSchemas;
  limits?: HttpOverMicroLimits;
}

export interface HttpOverMicroHandlerResponse<TBody = unknown> {
  status?: number;
  headers?: HttpFieldInput;
  body?: TBody | MessageInput;
}

export interface HttpOverMicroHandlerContext<TSchemas extends HttpOverMicroSchemas = HttpOverMicroSchemas> {
  request: {
    method: string;
    headers: SchemaOutput<TSchemas['headers'], HttpFieldValues>;
    query: SchemaOutput<TSchemas['query'], HttpFieldValues>;
    body: SchemaOutput<TSchemas['body'], unknown | Readable | undefined>;
  };
  params: SchemaOutput<TSchemas['params'], Record<string, string>>;
  url: string;
  client: Client;
  metadata?: MicroMessageMetadata;
  signal?: AbortSignal;
  invocation: MicroMessageHandlerExtras['invocation'];
}

export type HttpOverMicroHandler<TSchemas extends HttpOverMicroSchemas = HttpOverMicroSchemas> = (
  context: HttpOverMicroHandlerContext<TSchemas>,
) => HttpOverMicroHandlerResponse | Promise<HttpOverMicroHandlerResponse>;

function invalidRequest(message: string, cause?: unknown): HttpOverMicroError {
  return new HttpOverMicroError('INVALID_REQUEST', 400, message, { cause });
}

function invalidResponse(message: string, cause?: unknown): HttpOverMicroError {
  return new HttpOverMicroError('INVALID_RESPONSE', 500, message, { cause });
}

async function parseWithSchema(schema: z.ZodType | undefined, value: unknown, field: string) {
  if (!schema) return value;
  const parsed = await schema.safeParseAsync(value);
  if (!parsed.success) throw invalidRequest(`Invalid HTTP request ${field}`, parsed.error);
  return parsed.data;
}

function normalizeAllowedMethods(method: string | readonly string[]): readonly string[] {
  try {
    let source: readonly string[];
    if (typeof method === 'string') source = [method];
    else if (Array.isArray(method)) source = method;
    else throw new TypeError('method must be a string or string array');
    if (source.length === 0) throw new TypeError('At least one HTTP method is required');
    return Object.freeze([...new Set(source.map(normalizeHttpMethod))]);
  } catch (cause) {
    throw new HttpOverMicroError('INVALID_DEFINITION', 500, 'HTTP-over-Micro methods are invalid', { cause });
  }
}

function validateSchemas(schemas: HttpOverMicroSchemas | undefined): void {
  if (schemas === undefined) return;
  if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) {
    throw new HttpOverMicroError('INVALID_DEFINITION', 500, 'HTTP-over-Micro schema must be an object');
  }
  for (const field of ['headers', 'query', 'params', 'body'] as const) {
    const schema = schemas[field];
    if (schema !== undefined && typeof schema.safeParseAsync !== 'function') {
      throw new HttpOverMicroError(
        'INVALID_DEFINITION',
        500,
        `HTTP-over-Micro ${field} schema must be a Zod schema`,
      );
    }
  }
}

async function* iterateBody(body: MessageInput): AsyncIterable<unknown> {
  if (body instanceof ArrayBuffer) {
    yield new Uint8Array(body);
    return;
  }
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  for await (const chunk of body) {
    if (chunk === null || chunk === undefined) throw invalidResponse('HTTP response stream emitted an empty chunk');
    yield chunk;
  }
}

function createHead(
  status: number,
  headers: HttpFieldInput | undefined,
  body: HttpOverMicroResponseHead['body'],
): HttpOverMicroResponseHead {
  let candidate: HttpOverMicroResponseHead;
  try {
    candidate = {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
      version: HTTP_OVER_MICRO_VERSION,
      type: 'response',
      status,
      headers: normalizeHttpHeaders(headers),
      body,
    };
  } catch (cause) {
    throw invalidResponse('Invalid HTTP response headers', cause);
  }
  const parsed = httpOverMicroResponseHeadSchema.safeParse(candidate);
  if (!parsed.success) throw invalidResponse('Invalid HTTP response metadata', parsed.error);
  return parsed.data;
}

export function defineHttpOverMicroMessage<
  const TSchemas extends HttpOverMicroSchemas = HttpOverMicroSchemas,
>(
  config: HttpOverMicroMessageConfig<TSchemas>,
  handler: HttpOverMicroHandler<TSchemas>,
): MessageRegisterProps<HttpOverMicroRequestEnvelope, MicroMessageHandlerExtras> {
  if (!config || typeof config !== 'object') {
    throw new HttpOverMicroError('INVALID_DEFINITION', 500, 'HTTP-over-Micro config is required');
  }
  if (typeof handler !== 'function') {
    throw new HttpOverMicroError('INVALID_DEFINITION', 500, 'HTTP-over-Micro handler is required');
  }
  const methods = normalizeAllowedMethods(config.method);
  const methodSet = new Set(methods);
  let maxInlineBodyBytes: number;
  try {
    maxInlineBodyBytes = resolveInlineBodyLimit(config.limits?.maxInlineBodyBytes);
  } catch (cause) {
    throw new HttpOverMicroError('INVALID_DEFINITION', 500, 'HTTP-over-Micro limits are invalid', { cause });
  }
  const schemas = config.schema;
  validateSchemas(schemas);

  return defineMicroMessage<HttpOverMicroRequestEnvelope>(async function* ({
    data,
    input,
    params,
    url,
    client,
    metadata,
    signal,
    invocation,
  }) {
    const parsedEnvelope = httpOverMicroRequestEnvelopeSchema.safeParse(data);
    if (!parsedEnvelope.success) {
      throw invalidRequest('Invalid HTTP-over-Micro request envelope', parsedEnvelope.error);
    }
    const envelope = parsedEnvelope.data;
    if (!methodSet.has(envelope.method)) {
      yield createHead(405, { allow: methods.join(', ') }, { kind: 'empty' });
      return;
    }

    let body: unknown | Readable | undefined;
    if (envelope.body.kind === 'stream') {
      if (!input) throw invalidRequest('HTTP request declares a stream body but no Micro input was received');
      body = input;
    } else {
      if (input) throw invalidRequest('HTTP request sent Micro input without declaring a stream body');
      body = envelope.body.kind === 'inline' ? envelope.body.value : undefined;
    }

    const request = {
      method: envelope.method,
      headers: await parseWithSchema(schemas?.headers, httpFieldsToRecord(envelope.headers), 'headers'),
      query: await parseWithSchema(schemas?.query, httpFieldsToRecord(envelope.query), 'query'),
      body: await parseWithSchema(schemas?.body, body, 'body'),
    } as HttpOverMicroHandlerContext<TSchemas>['request'];
    const parsedParams = (await parseWithSchema(schemas?.params, params ?? {}, 'params')) as HttpOverMicroHandlerContext<TSchemas>['params'];
    const response = await handler({
      request,
      params: parsedParams,
      url,
      client,
      metadata,
      signal,
      invocation,
    });
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw invalidResponse('HTTP-over-Micro handler must return a response object');
    }

    const status = response.status ?? 200;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      throw invalidResponse('HTTP response status must be an integer from 200 through 599');
    }
    const responseBody = response.body;
    if (responseBody !== undefined && httpResponseMustBeEmpty(envelope.method, status)) {
      throw invalidResponse(`HTTP ${envelope.method} response with status ${status} must not include a body`);
    }

    if (responseBody === undefined) {
      yield createHead(status, response.headers, { kind: 'empty' });
      return;
    }
    if (isMessageInput(responseBody)) {
      yield createHead(status, response.headers, { kind: 'stream' });
      yield* iterateBody(responseBody as MessageInput);
      return;
    }

    const inlineBody = snapshotInlineBody(responseBody, maxInlineBodyBytes, 'response');
    yield createHead(status, response.headers, { kind: 'inline', value: inlineBody });
  });
}
