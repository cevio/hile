import { EventEmitter, once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  createContentFirstRscHtmlMiddleware,
  createContentFirstRscHtmlTransform,
} from './content-first';

describe('content-first RSC HTML', () => {
  it('streams document HTML before ordered inline Next Flight scripts', async () => {
    const html = await transform([
      '<!doctype html><html><head><script>window.before=true</script></head><body>',
      '<script>console.log("self.__next_f.push(")</script>',
      '<main><h1>文章标题</h1>',
      '<script>(self.__next_f=self.__next_f||[]).pu',
      'sh([0])</script><p>文章正文</p>',
      '<script nonce="nonce">self.__next_f.push([1,"payload"])</scr',
      'ipt></main></body></html>',
    ]);

    expect(html).toContain('<script>window.before=true</script>');
    expect(html.indexOf('console.log')).toBeLessThan(html.indexOf('文章正文'));
    expect(html.indexOf('文章正文')).toBeLessThan(
      html.indexOf('(self.__next_f=self.__next_f||[]).push('),
    );
    expect(html.indexOf('push([0])')).toBeLessThan(html.indexOf('push([1,"payload"])'));
    expect(html.lastIndexOf('self.__next_f')).toBeLessThan(html.indexOf('</body>'));
  });

  it('preserves the content-first result across single-byte input chunks', async () => {
    const source = Buffer.from(
      '<html><body><main>正文'
      + '<script>(self.__next_f=self.__next_f||[]).push([0])</script>'
      + '<p>更多正文</p>'
      + '<script nonce="n">self.__next_f.push([1,"payload"])</script>'
      + '</main></body></html>',
    );
    const expected = await transformBuffers([source]);
    const chunks = [...source].map((byte) => Buffer.from([byte]));

    const actual = await transformBuffers(chunks);

    expect(actual.equals(expected)).toBe(true);
  });

  it('does not confuse longer custom-element names with script tags', async () => {
    const html = await transform([
      '<html><body><scripture>custom element</scripture>',
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script>',
      '<main>正文</main></body></html>',
    ]);

    expect(html.indexOf('正文')).toBeLessThan(
      html.indexOf('(self.__next_f=self.__next_f||[]).push('),
    );
  });

  it('falls back to bounded streaming without losing or duplicating bytes', async () => {
    const source = [
      '<html><body><main>A',
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script>',
      'B<script>self.__next_f.push([1,"payload"])</script>C</main></body></html>',
    ];

    const html = await transform(source, 8);

    expect(html).toBe(source.join(''));
  });

  it('flushes previously deferred scripts at the overflow point without losing bytes', async () => {
    const source = [
      '<html><body><main>A',
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script>',
      'B<script>self.__next_f.push([1,"payload"])</script>C</main></body></html>',
    ];
    const firstScriptBytes = Buffer.byteLength(source[1]!);

    const html = await transform(source, firstScriptBytes);

    expect(html).toBe(
      '<html><body><main>AB'
      + '<script>(self.__next_f=self.__next_f||[]).push([0])</script>'
      + '<script>self.__next_f.push([1,"payload"])</script>'
      + 'C</main></body></html>',
    );
  });

  it('bounds incomplete script scanning and passes remaining bytes through', async () => {
    const stream = createContentFirstRscHtmlTransform({ maxDeferredFlightBytes: 64 });
    const output: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => output.push(chunk));
    const prefix = '<html><body>A<script>(self.__next_f=self.__next_f||[]).push([1,"'
      + 'x'.repeat(128);
    await new Promise<void>((resolve, reject) => {
      stream.write(Buffer.from(prefix), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    expect(Buffer.concat(output).toString('utf8')).toBe(prefix);

    const suffix = '"])</script>B</body></html>';
    stream.end(suffix);
    await once(stream, 'end');
    expect(Buffer.concat(output).toString('utf8')).toBe(prefix + suffix);
  });

  it('wraps only HTML responses and preserves response callbacks', async () => {
    const middleware = createContentFirstRscHtmlMiddleware();
    const response = new MemoryServerResponse();
    const writeCallback = vi.fn();
    const endCallback = vi.fn();

    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: response as unknown as ServerResponse,
    }, async () => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.write('<html><body><main>正文', writeCallback);
      response.write('<script>(self.__next_f=self.__next_f||[]).push([0])</script>');
      response.end('</main></body></html>', endCallback);
    });
    if (!response.writableEnded) await once(response, 'finish');

    expect(response.body.indexOf('正文')).toBeLessThan(response.body.indexOf('self.__next_f'));
    expect(response.body.indexOf('self.__next_f')).toBeLessThan(response.body.indexOf('</body>'));
    expect(writeCallback).toHaveBeenCalledOnce();
    expect(endCallback).toHaveBeenCalledOnce();

    const jsonResponse = new MemoryServerResponse();
    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: jsonResponse as unknown as ServerResponse,
    }, async () => {
      jsonResponse.setHeader('content-type', 'application/json');
      jsonResponse.end('{"script":"self.__next_f.push"}');
    });

    expect(jsonResponse.body).toBe('{"script":"self.__next_f.push"}');

    const htmlPrefixResponse = new MemoryServerResponse();
    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: htmlPrefixResponse as unknown as ServerResponse,
    }, async () => {
      htmlPrefixResponse.setHeader('content-type', 'text/html+fragment');
      htmlPrefixResponse.end(
        '<script>(self.__next_f=self.__next_f||[]).push([0])</script>正文',
      );
    });

    expect(htmlPrefixResponse.body).toBe(
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script>正文',
    );

    const compressedResponse = new MemoryServerResponse();
    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: compressedResponse as unknown as ServerResponse,
    }, async () => {
      compressedResponse.setHeader('content-type', 'text/html');
      compressedResponse.setHeader('content-encoding', 'zstd');
      compressedResponse.end(
        '<script>(self.__next_f=self.__next_f||[]).push([0])</script>正文',
      );
    });

    expect(compressedResponse.body).toBe(
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script>正文',
    );

    const emptyResponse = new MemoryServerResponse();
    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: emptyResponse as unknown as ServerResponse,
    }, async () => {
      emptyResponse.setHeader('content-type', 'text/html');
      emptyResponse.setHeader('content-encoding', 'gzip');
      emptyResponse.end();
    });
    if (!emptyResponse.writableEnded) await once(emptyResponse, 'finish');

    expect(emptyResponse.writableEnded).toBe(true);
    expect(emptyResponse.destroyError).toBeUndefined();

    const headResponse = new MemoryServerResponse();
    await middleware({
      req: { method: 'HEAD' } as IncomingMessage,
      res: headResponse as unknown as ServerResponse,
    }, async () => {
      headResponse.setHeader('content-type', 'text/html');
      headResponse.setHeader('content-encoding', 'gzip');
      headResponse.end('not a gzip body');
    });

    expect(headResponse.body).toBe('not a gzip body');
    expect(headResponse.destroyError).toBeUndefined();

    const notModifiedResponse = new MemoryServerResponse();
    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: notModifiedResponse as unknown as ServerResponse,
    }, async () => {
      notModifiedResponse.statusCode = 304;
      notModifiedResponse.setHeader('content-type', 'text/html');
      notModifiedResponse.setHeader('content-encoding', 'gzip');
      notModifiedResponse.end('not a gzip body');
    });

    expect(notModifiedResponse.body).toBe('not a gzip body');
    expect(notModifiedResponse.destroyError).toBeUndefined();
  });

  it('reorders gzip-compressed HTML and preserves gzip delivery', async () => {
    const middleware = createContentFirstRscHtmlMiddleware();
    const response = new MemoryServerResponse();
    const source = '<html><body>'
      + '<script>(self.__next_f=self.__next_f||[]).push([0])</script>'
      + '<main><h1>正文</h1></main></body></html>';

    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: response as unknown as ServerResponse,
    }, async () => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('content-encoding', 'gzip');
      const compressed = gzipSync(source);
      response.setHeader('content-length', String(compressed.length));
      response.setHeader('etag', '"original"');
      response.setHeader('content-digest', 'sha-256=:original:');
      response.end(compressed);
    });
    if (!response.writableEnded) await once(response, 'finish');

    const html = gunzipSync(response.bodyBytes).toString('utf8');
    expect(response.getHeader('content-encoding')).toBe('gzip');
    expect(response.getHeader('content-length')).toBeUndefined();
    expect(response.getHeader('etag')).toBeUndefined();
    expect(response.getHeader('content-digest')).toBeUndefined();
    expect(html.indexOf('正文')).toBeLessThan(html.indexOf('self.__next_f'));
    expect(html.indexOf('self.__next_f')).toBeLessThan(html.indexOf('</body>'));
  });

  it('passes through gzip when a fixed content length was already sent', async () => {
    const middleware = createContentFirstRscHtmlMiddleware();
    const response = new MemoryServerResponse();
    const compressed = gzipSync(
      '<script>(self.__next_f=self.__next_f||[]).push([0])</script>正文',
    );

    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: response as unknown as ServerResponse,
    }, async () => {
      response.setHeader('content-type', 'text/html');
      response.setHeader('content-encoding', 'gzip');
      response.setHeader('content-length', String(compressed.length));
      response.headersSent = true;
      response.end(compressed);
    });

    expect(response.bodyBytes).toEqual(compressed);
    expect(response.getHeader('content-length')).toBe(String(compressed.length));
  });

  it('reorders gzip after headers were sent without a fixed content length', async () => {
    const middleware = createContentFirstRscHtmlMiddleware();
    const response = new MemoryServerResponse();
    const source = '<script>(self.__next_f=self.__next_f||[]).push([0])</script>正文';

    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: response as unknown as ServerResponse,
    }, async () => {
      response.setHeader('content-type', 'text/html');
      response.setHeader('content-encoding', 'gzip');
      response.headersSent = true;
      response.end(gzipSync(source));
    });
    if (!response.writableEnded) await once(response, 'finish');

    const html = gunzipSync(response.bodyBytes).toString('utf8');
    expect(html.indexOf('正文')).toBeLessThan(html.indexOf('self.__next_f'));
  });

  it('passes through HTML when a representation validator was already sent', async () => {
    const middleware = createContentFirstRscHtmlMiddleware();
    const response = new MemoryServerResponse();
    const source = '<script>(self.__next_f=self.__next_f||[]).push([0])</script>正文';

    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: response as unknown as ServerResponse,
    }, async () => {
      response.setHeader('content-type', 'text/html');
      response.setHeader('etag', '"original"');
      response.headersSent = true;
      response.end(source);
    });

    expect(response.body).toBe(source);
    expect(response.getHeader('etag')).toBe('"original"');
  });

  it('destroys the response when gzip decoding fails', async () => {
    const middleware = createContentFirstRscHtmlMiddleware();
    const response = new MemoryServerResponse();
    const closed = once(response, 'close');

    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: response as unknown as ServerResponse,
    }, async () => {
      response.setHeader('content-type', 'text/html');
      response.setHeader('content-encoding', 'gzip');
      response.end('not gzip');
    });
    await closed;

    expect(response.destroyError).toBeInstanceOf(Error);
  });

  it('tears down a backpressured transform when the client disconnects', async () => {
    const middleware = createContentFirstRscHtmlMiddleware();
    const response = new BackpressuredServerResponse();

    await middleware({
      req: { method: 'GET' } as IncomingMessage,
      res: response as unknown as ServerResponse,
    }, async () => {
      response.setHeader('content-type', 'text/html');
      response.write('<html><body>正文');
      response.closeEarly();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.destroyError?.message).toContain('closed before content-first');
  });
});

async function transform(chunks: readonly string[], maxDeferredFlightBytes?: number): Promise<string> {
  const output = await transformBuffers(
    chunks.map((chunk) => Buffer.from(chunk)),
    maxDeferredFlightBytes,
  );
  return output.toString('utf8');
}

async function transformBuffers(
  chunks: readonly Buffer[],
  maxDeferredFlightBytes?: number,
): Promise<Buffer> {
  const stream = createContentFirstRscHtmlTransform({
    ...(maxDeferredFlightBytes === undefined ? {} : { maxDeferredFlightBytes }),
  });
  const output: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => output.push(chunk));
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await once(stream, 'end');
  return Buffer.concat(output);
}

class MemoryServerResponse extends EventEmitter {
  public statusCode = 200;
  public writableEnded = false;
  public headersSent = false;
  public destroyed = false;
  public destroyError: Error | undefined;
  readonly #headers = new Map<string, string>();
  readonly #chunks: Buffer[] = [];

  public get body(): string {
    return this.bodyBytes.toString('utf8');
  }

  public get bodyBytes(): Buffer {
    return Buffer.concat(this.#chunks);
  }

  public getHeader(name: string): string | undefined {
    return this.#headers.get(name.toLowerCase());
  }

  public setHeader(name: string, value: string): this {
    this.#headers.set(name.toLowerCase(), value);
    return this;
  }

  public removeHeader(name: string): void {
    this.#headers.delete(name.toLowerCase());
  }

  public write(chunk: string | Buffer, callback?: () => void): boolean {
    this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback?.();
    return true;
  }

  public end(chunk?: string | Buffer | (() => void), callback?: () => void): this {
    const finalCallback = typeof chunk === 'function' ? chunk : callback;
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) this.#chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
    finalCallback?.();
    this.emit('finish');
    return this;
  }

  public destroy(error?: Error): this {
    this.destroyError = error;
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
}

class BackpressuredServerResponse extends MemoryServerResponse {
  public override write(chunk: string | Buffer, callback?: () => void): boolean {
    super.write(chunk, callback);
    return false;
  }

  public closeEarly(): void {
    this.destroyed = true;
    this.emit('close');
  }
}
