---
name: redis-stream-queue
description: Use when implementing Redis Streams backed durable job queues, background workers, retry/backoff, delayed jobs, consumer-group pending recovery, DLQ handling, or Hile queue context propagation.
---

# Redis Stream Queue

Use `@hile/redis-stream-queue` when work should be persisted and processed asynchronously by background workers.

## Core Rule

This package provides at-least-once background job execution. Handlers must be idempotent; do not claim exactly-once delivery.

```typescript
const emailQueue = defineQueue<EmailPayload>('email')

await queue.add(emailQueue, payload, {
  jobId: `welcome:${payload.userId}`,
  maxAttempts: 5,
  backoff: { type: 'exponential', baseMs: 1_000 },
})

queue.worker(emailQueue, async (job) => {
  await sendEmail(job.data)
}, { concurrency: 8 }).start()
```

## Design Boundaries

- Use Redis Streams consumer groups for ready jobs.
- Use the pending entries list plus `XCLAIM` for worker crash recovery.
- Use a delayed sorted set for delayed jobs and retry backoff.
- Move exhausted jobs to `{prefix}queue:{name}:dlq`.
- Store job attempts, first/last failure reason, and context metadata.
- Validate payloads through the queue schema before enqueueing and before handling.
- `jobId` is enqueue dedupe only; side effects still need idempotency.

## Testing Priorities

- Pending job claimed by another worker after `claimIdle`.
- Failed job retries with configured backoff.
- Exhausted job appears in DLQ.
- Duplicate `jobId` enqueues only one job.
- Worker concurrency caps simultaneous handlers.
- Active `@hile/context` is restored inside handlers.
