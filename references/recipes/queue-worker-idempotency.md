# Queue Worker With Idempotency

## Complete Example

```ts
// src/services/email-worker.boot.ts
import { defineService, loadService } from '@hile/core'
import redisService from '@hile/ioredis'
import { RedisIdempotency, stableHash } from '@hile/redis-idempotency'
import { RedisStreamQueue, defineQueue } from '@hile/redis-stream-queue'

type EmailPayload = {
  tenantId: string
  userId: string
  template: 'welcome'
}

const emailQueue = defineQueue<EmailPayload>('email')

export default defineService('email.worker', async (shutdown) => {
  const redis = await loadService(redisService)
  const queue = new RedisStreamQueue(redis, { prefix: 'app:' })
  const idempotency = new RedisIdempotency(redis)

  const worker = queue.worker(emailQueue, async (job) => {
    await idempotency.run(
      `idem:email:${job.data.tenantId}:${job.jobId ?? job.id}`,
      () => sendEmail(job.data),
      {
        lockTtl: 60_000,
        resultTtl: 86_400_000,
        fingerprint: stableHash(job.data),
      },
    )
  }, {
    group: 'email-workers',
    consumer: process.env.HOSTNAME ?? `${process.pid}`,
    concurrency: 8,
    claimIdle: 60_000,
  })

  worker.start()
  shutdown(() => worker.stop())

  return { queue, worker }
})
```

Enqueue:

```ts
await queue.add(emailQueue, {
  tenantId: 't1',
  userId: 'u1',
  template: 'welcome',
}, {
  jobId: 'welcome:t1:u1',
  maxAttempts: 5,
  backoff: { type: 'exponential', baseMs: 1_000, maxMs: 60_000 },
})
```

## File Layout

```text
src/
  services/email-worker.boot.ts
  queues/email.queue.ts
```

## User Intent

Use this recipe for at-least-once background work where side effects must survive retries safely.

## Packages To Use

- `@hile/redis-stream-queue`
- `@hile/redis-idempotency`
- `@hile/ioredis`
- `@hile/core`

## Implementation Steps

1. Define the queue and payload type.
2. Enqueue with a stable `jobId`.
3. Wrap side effects with `RedisIdempotency.run()`.
4. Use business identifiers in idempotency keys.
5. Monitor DLQ with `readDeadLetters()`.

## Failure And Cleanup Behavior

- Queue delivery is at-least-once.
- Failed attempts retry until `maxAttempts`, then move to DLQ.
- `jobId` dedupes enqueue, not side effects.
- Idempotency caches successful results but is not exactly-once.

## Verification Checklist

- Handler is idempotent.
- Idempotency key is business-derived.
- Worker stop is registered with `shutdown`.
- DLQ read path exists.
