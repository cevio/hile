# @hile/redis-stream-queue

Redis Streams backed durable job queue primitives for Hile applications.

Use this package when work should not block the current request but still needs to be persisted, retried, recovered after worker crashes, and inspected when it finally fails.

## Install

```bash
pnpm add @hile/redis-stream-queue @hile/ioredis
```

The package accepts any Redis client matching `RedisStreamQueueLike`. In Hile apps the usual client comes from `@hile/ioredis`.

## Quick Start

```typescript
import { RedisStreamQueue, defineQueue } from '@hile/redis-stream-queue'

type EmailPayload = {
  template: 'welcome'
  userId: string
}

const emailQueue = defineQueue<EmailPayload>('email')
const queue = new RedisStreamQueue(redis, { prefix: 'myapp:' })

await queue.add(emailQueue, {
  template: 'welcome',
  userId: 'user-1',
}, {
  jobId: 'welcome:user-1',
  maxAttempts: 5,
  backoff: { type: 'exponential', baseMs: 1_000 },
})

queue.worker(emailQueue, async (job) => {
  await sendEmail(job.data)
}, {
  group: 'email-workers',
  consumer: 'worker-1',
  concurrency: 8,
}).start()
```

## Core Concepts

### defineQueue(name, schema?)

`defineQueue()` declares the queue name and optional payload schema.

```typescript
const imageQueue = defineQueue('image-resize', {
  parse(value) {
    if (typeof value !== 'object' || value === null) throw new Error('invalid payload')
    return value as { imageId: string; size: 'small' | 'large' }
  },
})
```

The schema can expose `parse(value)` or `safeParse(value)`. Payloads are validated before enqueueing and again when workers read them.

### queue.add(queue, payload, options?)

Adds a durable job.

```typescript
await queue.add(emailQueue, payload, {
  jobId: 'welcome:user-1',
  delay: 30_000,
  maxAttempts: 5,
  backoff: { type: 'fixed', delay: 5_000 },
})
```

Options:

| Option | Meaning |
|---|---|
| `jobId` | Deduplication key. A second add with the same `jobId` returns `{ duplicate: true }`. |
| `delay` | Milliseconds before the job becomes visible to workers. |
| `maxAttempts` | Maximum attempts before the job goes to DLQ. Defaults to `1`. |
| `backoff` | Retry delay. Use a number, `{ type: 'fixed', delay }`, or `{ type: 'exponential', baseMs, maxMs }`. |

### queue.worker(queue, handler, options?)

Creates a worker around a Redis consumer group.

```typescript
const worker = queue.worker(emailQueue, async (job) => {
  await sendEmail(job.data)
}, {
  group: 'email-workers',
  consumer: process.env.HOSTNAME ?? 'local',
  concurrency: 4,
  claimIdle: 60_000,
})

worker.start()
```

`runOnce()` is available for tests and controlled scripts:

```typescript
await worker.runOnce()
await worker.stop()
```

### readDeadLetters(queue)

Reads failed jobs from the dead-letter stream:

```typescript
const failed = await queue.readDeadLetters(emailQueue, { count: 20 })
```

## State Machine

| State | Redis structure | Meaning |
|---|---|---|
| `scheduled` | sorted set `{prefix}queue:{name}:delayed` | Job has a future `runAt`. |
| `ready` | stream `{prefix}queue:{name}:stream` | Job is visible to the consumer group. |
| `pending` | Redis Streams PEL | A worker received the job but has not acked it yet. |
| `retrying` | delayed sorted set | A failed job is waiting for backoff before another attempt. |
| `done` | acked stream entry | Handler completed and the pending entry was acked. |
| `dead-lettered` | stream `{prefix}queue:{name}:dlq` | Attempts were exhausted. |

## Crash Recovery

Workers use Redis consumer groups. If a worker reads a job and dies before `XACK`, the job remains in the pending entries list. Another worker can claim it after `claimIdle` milliseconds and continue processing.

## Context Propagation

If `@hile/context` has an active context when a job is enqueued, the queue stores a snapshot and restores it while the worker handler runs.

```typescript
await runWithContext<AppContext>({ shopId: 'shop-1' }, async () => {
  await queue.add(emailQueue, payload)
})
```

```typescript
queue.worker(emailQueue, async () => {
  const context = getContext<AppContext>()
  console.log(context.shopId)
})
```

## Boundaries

- This package is for background jobs, not request/response RPC.
- It provides at-least-once delivery. Handlers must be idempotent.
- It does not promise exactly-once execution.
- Delayed jobs and retries are promoted when workers poll the queue.
- Payload and context values must be JSON-serializable.
- `jobId` prevents duplicate enqueue for the same key; it does not make the handler side effect exactly-once.

## Testing

```bash
pnpm --filter @hile/redis-stream-queue test
pnpm --filter @hile/redis-stream-queue build
```

## License

MIT
