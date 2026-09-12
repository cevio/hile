import { Readable } from 'node:stream';
import { isMessageInput, type MessageInput } from '@hile/message-modem';
import type { ApplicationStreamOptions } from '@hile/micro';
import { HttpOverMicroError } from './errors';
import {
  normalizeHttpHeaders,
  normalizeHttpQuery,
  type HttpFieldEntry,
  type HttpFieldInput,
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
  type HttpOverMicroLimits,
} from './protocol';

export interface HttpOverMicroApplication {
  stream(
    namespace: string,
    url: string,
    data: unknown,
    options: ApplicationStreamOptions,
  ): Promise<Readable>;
}

export interface HttpOverMicroRequest<TBody = unknown> {
  method: string;
  headers?: HttpFieldInput;
  query?: HttpFieldInput;
  body?: TBody | MessageInput;
}

export type HttpOverMicroCallOptions = Omit<ApplicationStreamOptions, 'input' | 'protocol'> & {
  limits?: HttpOverMicroLimits;
};

type ResponseBase = {
  status: number;
  headers: readonly HttpFieldEntry[];
};

export type HttpOverMicroResponse<T = unknown> =
  | (ResponseBase & { bodyKind: 'empty'; body: undefined })
  | (ResponseBase & { bodyKind: 'inline'; body: T })
  | (ResponseBase & { bodyKind: 'stream'; body: Readable });

const END = Symbol('http-over-micro-end');

async function readNext(stream: Readable): Promise<unknown | typeof END> {
  const immediate = stream.read();
  if (immediate !== null) return immediate;
  if (stream.readableEnded) return END;
  if (stream.destroyed) throw stream.errored ?? new Error('Micro response stream closed');

  return await new Promise<unknown | typeof END>((resolve, reject) => {
    const cleanup = () => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
    };
    const onReadable = () => {
      const value = stream.read();
      if (value === null) return;
      cleanup();
      resolve(value);
    };
    const onEnd = () => {
      cleanup();
      resolve(END);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      if (stream.readableEnded) {
        resolve(END);
        return;
      }
      reject(stream.errored ?? new Error('Micro response stream closed'));
    };
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    // Close the read-before-listen race if a chunk arrived while handlers were attached.
    onReadable();
  });
}

function invalidResponse(message: string, cause?: unknown): HttpOverMicroError {
  return new HttpOverMicroError('INVALID_RESPONSE', 502, message, { cause });
}

function invalidRequest(message: string, cause?: unknown): HttpOverMicroError {
  return new HttpOverMicroError('INVALID_REQUEST', 400, message, { cause });
}

function closeInvalidStream(stream: Readable): void {
  if (!stream.destroyed) stream.destroy();
}

export async function callHttpOverMicro<TResponse = unknown, TRequest = unknown>(
  application: HttpOverMicroApplication,
  namespace: string,
  url: string,
  request: HttpOverMicroRequest<TRequest>,
  options: HttpOverMicroCallOptions,
): Promise<HttpOverMicroResponse<TResponse>> {
  if (!request || typeof request !== 'object') {
    throw invalidRequest('HTTP-over-Micro request must be an object');
  }
  const maxInlineBodyBytes = resolveInlineBodyLimit(options.limits?.maxInlineBodyBytes);
  const input = isMessageInput(request.body) ? request.body : undefined;
  if (input && options.retries !== undefined && options.retries !== 0) {
    throw new TypeError('Streamed HTTP request bodies are non-replayable and require retries: 0');
  }

  let envelope: HttpOverMicroRequestEnvelope;
  try {
    envelope = {
      protocol: HTTP_OVER_MICRO_PROTOCOL,
      version: HTTP_OVER_MICRO_VERSION,
      type: 'request',
      method: normalizeHttpMethod(request.method),
      headers: normalizeHttpHeaders(request.headers),
      query: normalizeHttpQuery(request.query),
      body: input
        ? { kind: 'stream' }
        : request.body === undefined
          ? { kind: 'empty' }
          : { kind: 'inline', value: snapshotInlineBody(request.body, maxInlineBodyBytes, 'request') },
    };
  } catch (cause) {
    if (cause instanceof HttpOverMicroError) throw cause;
    throw invalidRequest('Invalid HTTP-over-Micro request metadata', cause);
  }
  const checkedEnvelope = httpOverMicroRequestEnvelopeSchema.safeParse(envelope);
  if (!checkedEnvelope.success) {
    throw invalidRequest('Invalid HTTP-over-Micro request', checkedEnvelope.error);
  }

  const { limits: _limits, ...streamOptions } = options;
  const stream = await application.stream(namespace, url, checkedEnvelope.data, {
    ...streamOptions,
    retries: streamOptions.retries ?? 0,
    ...(input ? { input } : {}),
    protocol: HTTP_OVER_MICRO_PROTOCOL,
  });
  const first = await readNext(stream);
  if (first === END) throw invalidResponse('HTTP-over-Micro response ended before its response head');

  const parsedHead = httpOverMicroResponseHeadSchema.safeParse(first);
  if (!parsedHead.success) {
    closeInvalidStream(stream);
    throw invalidResponse('Invalid HTTP-over-Micro response head', parsedHead.error);
  }
  const base = { status: parsedHead.data.status, headers: parsedHead.data.headers };
  if (parsedHead.data.body.kind !== 'empty'
    && httpResponseMustBeEmpty(checkedEnvelope.data.method, parsedHead.data.status)) {
    closeInvalidStream(stream);
    throw invalidResponse(
      `HTTP ${checkedEnvelope.data.method} response with status ${parsedHead.data.status} must not include a body`,
    );
  }

  if (parsedHead.data.body.kind === 'stream') {
    return { ...base, bodyKind: 'stream', body: stream };
  }

  const trailing = await readNext(stream);
  if (trailing !== END) {
    closeInvalidStream(stream);
    throw invalidResponse('Inline HTTP-over-Micro response contains trailing stream frames');
  }
  if (parsedHead.data.body.kind === 'empty') {
    return { ...base, bodyKind: 'empty', body: undefined };
  }
  let body: unknown;
  try {
    body = snapshotInlineBody(parsedHead.data.body.value, maxInlineBodyBytes, 'response');
  } catch (cause) {
    throw invalidResponse('Invalid HTTP-over-Micro inline response body', cause);
  }
  return { ...base, bodyKind: 'inline', body: body as TResponse };
}
