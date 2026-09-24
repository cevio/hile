import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform, type TransformCallback, Writable } from 'node:stream';
import { assertRscNextCompatibility } from './compatibility';

const DEFAULT_MAX_DEFERRED_FLIGHT_BYTES = 512 * 1024;
const SCRIPT_OPEN = Buffer.from('<script');
const SCRIPT_OPEN_END = Buffer.from('>');
const SCRIPT_SELF_CLOSE_BYTE = '/'.charCodeAt(0);
const SCRIPT_CLOSE = Buffer.from('</script>');
const BODY_CLOSE = Buffer.from('</body>');
const HTML_CLOSE = Buffer.from('</html>');
const PARTIAL_MARKER_BYTES = Math.max(SCRIPT_OPEN.length, BODY_CLOSE.length, HTML_CLOSE.length) - 1;
const NEXT_FLIGHT_BOOTSTRAP = Buffer.from('(self.__next_f=self.__next_f||[]).push(');
const NEXT_FLIGHT_CHUNK = Buffer.from('self.__next_f.push(');

export interface ContentFirstRscHtmlOptions {
  /**
   * Maximum inline Flight bytes retained while the document HTML continues
   * streaming. Exceeding the limit flushes the retained scripts at the
   * overflow point and passes all remaining bytes through unchanged.
   */
  maxDeferredFlightBytes?: number;
}

export interface ContentFirstRscHtmlContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export type ContentFirstRscHtmlMiddleware = (
  context: ContentFirstRscHtmlContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * Keeps server-rendered document content ahead of Next.js inline Flight data.
 * The Flight scripts remain byte-identical and retain their original order.
 */
export function createContentFirstRscHtmlMiddleware(
  options: ContentFirstRscHtmlOptions = {},
): ContentFirstRscHtmlMiddleware {
  assertRscNextCompatibility();
  const normalized = normalizeOptions(options);
  return async (context, next) => {
    installContentFirstResponseWriter(context.res, normalized);
    return next();
  };
}

export function createContentFirstRscHtmlTransform(
  options: ContentFirstRscHtmlOptions = {},
): Transform {
  assertRscNextCompatibility();
  const normalized = normalizeOptions(options);
  return new ContentFirstRscHtmlTransform(normalized.maxDeferredFlightBytes);
}

interface NormalizedContentFirstOptions {
  readonly maxDeferredFlightBytes: number;
}

function normalizeOptions(options: ContentFirstRscHtmlOptions): NormalizedContentFirstOptions {
  const maxDeferredFlightBytes = options.maxDeferredFlightBytes
    ?? DEFAULT_MAX_DEFERRED_FLIGHT_BYTES;
  if (!Number.isSafeInteger(maxDeferredFlightBytes) || maxDeferredFlightBytes < 1) {
    throw new TypeError('maxDeferredFlightBytes must be a positive safe integer');
  }
  return { maxDeferredFlightBytes };
}

class ContentFirstRscHtmlTransform extends Transform {
  readonly #maxDeferredFlightBytes: number;
  #pending: Buffer = Buffer.alloc(0);
  #deferredFlight: Buffer[] = [];
  #deferredFlightBytes = 0;
  #passthrough = false;

  public constructor(maxDeferredFlightBytes: number) {
    super();
    this.#maxDeferredFlightBytes = maxDeferredFlightBytes;
  }

  public override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.#pending = this.#pending.length === 0
        ? bytes
        : Buffer.concat([this.#pending, bytes]);
      this.#drainPending(false);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public override _flush(callback: TransformCallback): void {
    try {
      this.#drainPending(true);
      this.#flushDeferredFlight();
      this.#pushPending();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #drainPending(final: boolean): void {
    if (this.#passthrough) {
      this.#pushPending();
      return;
    }

    while (this.#pending.length > 0) {
      const scriptStart = findScriptOpen(this.#pending);
      const documentClose = firstIndex(this.#pending, BODY_CLOSE, HTML_CLOSE);
      if (documentClose >= 0 && (scriptStart < 0 || documentClose < scriptStart)) {
        this.#pushPrefix(documentClose);
        this.#flushDeferredFlight();
        this.#passthrough = true;
        this.#pushPending();
        return;
      }
      if (scriptStart < 0) {
        const retained = final ? 0 : Math.min(PARTIAL_MARKER_BYTES, this.#pending.length);
        this.#pushPrefix(this.#pending.length - retained);
        return;
      }

      this.#pushPrefix(scriptStart);
      const openEnd = this.#pending.indexOf(SCRIPT_OPEN_END, SCRIPT_OPEN.length);
      const closeStart = openEnd < 0
        ? -1
        : this.#pending.indexOf(SCRIPT_CLOSE, openEnd + SCRIPT_OPEN_END.length);
      if (openEnd < 0 || closeStart < 0) {
        if (final) {
          this.#pushPending();
        } else if (this.#pending.length > this.#maxDeferredFlightBytes) {
          this.#flushDeferredFlight();
          this.#passthrough = true;
          this.#pushPending();
        }
        return;
      }

      const scriptEnd = closeStart + SCRIPT_CLOSE.length;
      const script = this.#pending.subarray(0, scriptEnd);
      this.#pending = this.#pending.subarray(scriptEnd);
      if (!isNextFlightScript(script, openEnd)) {
        this.push(script);
        continue;
      }
      if (this.#deferredFlightBytes + script.length <= this.#maxDeferredFlightBytes) {
        this.#deferredFlight.push(script);
        this.#deferredFlightBytes += script.length;
        continue;
      }

      this.#flushDeferredFlight();
      this.push(script);
      this.#passthrough = true;
      this.#pushPending();
      return;
    }
  }

  #flushDeferredFlight(): void {
    for (const script of this.#deferredFlight) this.push(script);
    this.#deferredFlight = [];
    this.#deferredFlightBytes = 0;
  }

  #pushPrefix(length: number): void {
    if (length <= 0) return;
    this.push(this.#pending.subarray(0, length));
    this.#pending = this.#pending.subarray(length);
  }

  #pushPending(): void {
    if (this.#pending.length === 0) return;
    this.push(this.#pending);
    this.#pending = Buffer.alloc(0);
  }
}

function firstIndex(source: Buffer, ...needles: readonly Buffer[]): number {
  let result = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle);
    if (index >= 0 && (result < 0 || index < result)) result = index;
  }
  return result;
}

function findScriptOpen(source: Buffer): number {
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(SCRIPT_OPEN, offset);
    if (index < 0) return -1;
    const boundary = source[index + SCRIPT_OPEN.length];
    if (
      boundary === undefined
      || boundary === SCRIPT_OPEN_END[0]
      || boundary === SCRIPT_SELF_CLOSE_BYTE
      || isAsciiWhitespace(boundary)
    ) {
      return index;
    }
    offset = index + SCRIPT_OPEN.length;
  }
  return -1;
}

function isNextFlightScript(script: Buffer, openEnd: number): boolean {
  const body = script.subarray(
    openEnd + SCRIPT_OPEN_END.length,
    script.length - SCRIPT_CLOSE.length,
  );
  let contentStart = 0;
  while (contentStart < body.length && isAsciiWhitespace(body[contentStart]!)) contentStart += 1;
  const content = body.subarray(contentStart);
  return startsWith(content, NEXT_FLIGHT_BOOTSTRAP) || startsWith(content, NEXT_FLIGHT_CHUNK);
}

function startsWith(source: Buffer, prefix: Buffer): boolean {
  return source.length >= prefix.length && source.subarray(0, prefix.length).equals(prefix);
}

function isAsciiWhitespace(value: number): boolean {
  return value === 9 || value === 10 || value === 12 || value === 13 || value === 32;
}

function installContentFirstResponseWriter(
  response: ServerResponse,
  options: NormalizedContentFirstOptions,
): void {
  const originalWrite = response.write;
  const originalEnd = response.end;
  let transform: Transform | undefined;
  let passthrough: boolean | undefined;
  let endCallback: (() => void) | undefined;

  const writeOriginal = (...args: unknown[]) => Reflect.apply(originalWrite, response, args);
  const endOriginal = (...args: unknown[]) => Reflect.apply(originalEnd, response, args);
  const ensureTransform = (): Transform | undefined => {
    if (passthrough !== undefined) return transform;
    passthrough = !isTransformableHtml(response);
    if (passthrough) return undefined;

    transform = new ContentFirstRscHtmlTransform(options.maxDeferredFlightBytes);
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const accepted = writeOriginal(chunk) !== false;
        if (accepted) {
          callback();
          return;
        }
        const onDrain = () => {
          response.off('close', onClose);
          callback();
        };
        const onClose = () => {
          response.off('drain', onDrain);
          callback(createResponseClosedError());
        };
        if (response.destroyed) {
          callback(createResponseClosedError());
          return;
        }
        response.once('drain', onDrain);
        response.once('close', onClose);
      },
    });
    const onResponseClose = () => {
      if (!destination.writableFinished) transform?.destroy(createResponseClosedError());
    };
    response.once('close', onResponseClose);
    transform.pipe(destination);
    transform.once('error', (error) => destination.destroy(error));
    destination.once('error', (error) => {
      response.off('close', onResponseClose);
      response.destroy(error);
    });
    destination.once('finish', () => {
      response.off('close', onResponseClose);
      if (endCallback) endOriginal(endCallback);
      else endOriginal();
    });
    return transform;
  };

  response.write = function write(
    chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ): boolean {
    const stream = ensureTransform();
    if (!stream) return writeOriginal(...defined([chunk, encodingOrCallback, callback])) as boolean;
    const accepted = stream.write(...defined([chunk, encodingOrCallback, callback]) as [unknown]);
    if (!accepted) stream.once('drain', () => response.emit('drain'));
    return accepted;
  } as ServerResponse['write'];

  response.end = function end(
    chunkOrCallback?: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ): ServerResponse {
    const stream = ensureTransform();
    if (!stream) return endOriginal(...defined([chunkOrCallback, encodingOrCallback, callback])) as ServerResponse;
    const args = defined([chunkOrCallback, encodingOrCallback, callback]);
    const candidate = args.at(-1);
    if (typeof candidate === 'function') {
      endCallback = candidate as () => void;
      args.pop();
    }
    stream.end(...args as [unknown]);
    return response;
  } as ServerResponse['end'];
}

function createResponseClosedError(): Error {
  return new Error('HTTP response closed before content-first transform completed');
}

function isTransformableHtml(response: ServerResponse): boolean {
  const contentType = String(response.getHeader('content-type') ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'text/html') return false;
  const contentEncoding = String(response.getHeader('content-encoding') ?? '')
    .trim()
    .toLowerCase();
  return contentEncoding === '' || contentEncoding === 'identity';
}

function defined(values: readonly unknown[]): unknown[] {
  const result = [...values];
  while (result.length > 0 && result.at(-1) === undefined) result.pop();
  return result;
}
