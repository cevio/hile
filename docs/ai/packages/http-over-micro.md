# HTTP Over Micro

Package: `@hile/http-over-micro`.

## Use When

Use this package when one HTTP ingress must project a request to a Registry-discovered Hile microservice while preserving HTTP method, duplicate headers, query values, status, cookies, redirects, JSON bodies, and streamed file bodies.

The package defines the transport contract only. The public listener and its authentication, authorization, route selection, header policy, and final Koa response remain owned by the gateway.

## Do Not Use When

- Do not use it for ordinary in-process HTTP controllers that do not cross a Micro boundary.
- Do not use it as a durable queue or retry layer.
- Do not use it for RSC Flight, MCP, WebSocket upgrades, HTTP trailers, or informational `1xx` responses; those protocols keep their own transports.
- Do not put business logic in the gateway merely because the gateway performs the HTTP projection.

## Install

```bash
pnpm add @hile/http-over-micro @hile/micro zod
```

## Imports

```ts
import {
  callHttpOverMicro,
  defineHttpOverMicroMessage,
} from '@hile/http-over-micro'
import { z } from 'zod'
```

## Copy-Paste Example

Provider message:

```ts
// src/messages/posts/[slug].msg.ts
import { defineHttpOverMicroMessage } from '@hile/http-over-micro'
import { z } from 'zod'

export default defineHttpOverMicroMessage({
  method: 'POST',
  schema: {
    headers: z.object({ authorization: z.string().startsWith('Bearer ') }),
    query: z.object({ draft: z.enum(['true', 'false']).default('false') }),
    params: z.object({ slug: z.string().min(1) }),
    body: z.object({ title: z.string().min(1), content: z.string() }),
  },
}, async ({ request, params, invocation }) => {
  // Call a model here; the example only shows the transport result.
  return {
    status: 201,
    headers: {
      location: `/posts/${params.slug}`,
      'set-cookie': ['flash=created; Path=/; HttpOnly', 'draft=; Max-Age=0; Path=/'],
    },
    body: {
      created: true,
      draft: request.query.draft === 'true',
      requestId: invocation.context.values.requestId,
    },
  }
})
```

Gateway-side call:

```ts
const response = await callHttpOverMicro(
  app,
  'cn.zlooks.blog.server',
  '/posts/hello',
  {
    method: ctx.method,
    headers: ctx.headers,
    query: Object.entries(ctx.query).flatMap(([name, value]) =>
      Array.isArray(value) ? value.map(item => [name, item] as const) : [[name, String(value)] as const],
    ),
    body: ctx.request.body,
  },
  { context: executionContext },
)

ctx.status = response.status
for (const [name, value] of response.headers) ctx.append(name, value)
return response.body
```

Pass only gateway-approved end-to-end request headers. The sample assumes a body parser has already produced `ctx.request.body`; use the untouched incoming `Readable` instead for raw uploads.

## More Examples

### Upload and download without a transport switch

The caller supplies a normal JSON value or an `AsyncIterable`, `Uint8Array`, or `ArrayBuffer`. `callHttpOverMicro()` snapshots JSON values into the request envelope and automatically moves binary or iterable bodies into Micro request input.

```ts
import { createReadStream } from 'node:fs'

const response = await callHttpOverMicro(app, 'files.server', '/files', {
  method: 'PUT',
  headers: { 'content-type': 'application/octet-stream' },
  body: createReadStream('/tmp/archive.tar'),
}, { context })

if (response.bodyKind === 'stream') {
  for await (const chunk of response.body) consumeDownloadedChunk(chunk)
}
```

Provider:

```ts
import { Readable } from 'node:stream'

export default defineHttpOverMicroMessage({ method: ['GET', 'PUT'] }, async ({ request }) => {
  if (request.method === 'PUT') {
    if (!(request.body instanceof Readable)) {
      return { status: 400, body: { error: 'stream required' } }
    }
    await saveUpload(request.body)
    return { status: 204 }
  }

  return {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    body: openDownloadStream(),
  }
})
```

Streaming request bodies are non-replayable. Leave retries unset or set `retries: 0`; an explicit nonzero value fails before dispatch.

### Response metadata before response bytes

Every HTTP-over-Micro call uses one Micro response stream. Its first chunk is a response head; body chunks follow only when `body.kind` is `stream`:

```ts
type RequestEnvelope = {
  protocol: '@hile/http-over-micro'
  version: 1
  type: 'request'
  method: string
  headers: Array<[string, string]>
  query: Array<[string, string]>
  body: { kind: 'empty' } | { kind: 'inline'; value: unknown } | { kind: 'stream' }
}

type ResponseHead = {
  protocol: '@hile/http-over-micro'
  version: 1
  type: 'response'
  status: number
  headers: Array<[string, string]>
  body: { kind: 'empty' } | { kind: 'inline'; value: unknown } | { kind: 'stream' }
}
```

Header tuples deliberately preserve order and duplicate fields such as `Set-Cookie`. Header names are canonical lowercase on the wire. Query tuples preserve repeated query values without inventing an object serialization rule.

### Zod parses, not merely checks

`schema.headers`, `schema.query`, `schema.params`, and `schema.body` each receive the logical value seen by the handler. Schema transforms and coercions are returned to the handler.

For a streamed request, `schema.body` receives the `Readable`. Use a Zod custom or union schema only when that endpoint intentionally accepts a stream; a JSON-object body schema rejects the stream naturally.

## Compose With

- Use `@hile/http` or `@hile/http-next` for the one public HTTP listener and file-system Controller.
- Use `@hile/micro` for Registry discovery, context propagation, cancellation, timeouts, and credit-based input/output flow control.
- Use `@hile/model` behind the provider handler for reusable business behavior.
- Use the gateway's own policy to select which headers and cookies may cross the boundary; this package preserves selected values but does not authorize them.

## Runtime And Lifecycle Notes

- `defineHttpOverMicroMessage()` returns a normal `defineMicroMessage()` definition and is loaded or registered through the standard Micro message loader.
- The Micro route remains the file/message path. HTTP method is protocol data and one definition may accept one method or a method list. Unsupported methods return `405` plus `Allow` without invoking the handler.
- Inline bodies use JSON serialization semantics and default to a 1 MiB bound. Override `limits.maxInlineBodyBytes` explicitly on both ends when a deployment requires another limit; use streams for files and large byte bodies.
- Final response statuses are `200..599`. `HEAD`, `204`, `205`, and `304` responses reject bodies. `1xx`, protocol upgrades, and trailers are intentionally out of scope.
- Destroying the returned streamed body cancels the underlying Micro response. `signal`, total timeout, idle timeout, and stream window are passed to `Application.stream()`.
- Credit-based backpressure bounds buffered chunks, not the total number of transferred bytes. The HTTP ingress and provider handler must each enforce their endpoint-specific upload/download byte limit while consuming a stream.
- The caller owns the returned response stream and must consume or destroy it. The package fully consumes empty and inline responses before resolving.
- Cookies and `Location` are opaque response headers. The public gateway remains responsible for cookie ownership, security attributes, redirect policy, and hop-by-hop header removal.
- Treat `namespace` and `url` as routing authority. A public gateway must resolve them through its validated provider catalog or an equivalent allow policy; never dispatch an arbitrary client-supplied namespace directly.

## Anti-Patterns

- Do not handcraft the request envelope or consume the response-head frame yourself; use `callHttpOverMicro()`.
- Do not call `Application.call()` for this protocol. A response may need headers followed by a body stream, so the package intentionally uses `Application.stream()` for every result.
- Do not encode files as Base64 inside an inline JSON body.
- Do not collapse response headers into a plain object when duplicate `Set-Cookie` values matter.
- Do not enable retries for an upload stream.
- Do not forward every inbound header, raw cookie, or identity credential merely because the protocol can carry it.

## Verification Checklist

- Unit tests cover inline, empty, malformed, method-mismatch, and Zod-coercion cases.
- A real Registry-discovered WebSocket test carries request and response streams at the same time.
- Duplicate response headers survive in order.
- Invalid request metadata fails with HTTP status `400`; invalid upstream response metadata fails locally with `502`.
- Inline bodies are bounded and JSON-serializable; files use stream bodies.
- Cancellation, timeout, idle timeout, and backpressure remain owned by `@hile/micro` and `@hile/message-modem`.
