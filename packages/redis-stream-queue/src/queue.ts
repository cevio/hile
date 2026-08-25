import { randomUUID } from 'node:crypto';
import {
  createInvocationContext,
  MissingExecutionContextError,
  parseExecutionContext,
} from '@hile/context';
import { QueueSerializationError } from './errors';
import { parsePayload } from './define';
import type {
  QueueAddOptions,
  QueueAddResult,
  QueueBackoff,
  QueueDeadLetter,
  QueueDefinition,
  QueueJob,
  QueueWorkerHandler,
  QueueWorkerOptions,
  ReadDeadLettersOptions,
  RedisPendingEntry,
  RedisStreamEntry,
  RedisStreamQueueLike,
  RedisStreamQueueOptions,
  RedisStreamReadResult,
  StoredQueueBackoff,
  StoredQueueJob,
} from './types';

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_CLAIM_IDLE = 60_000;
const DEFAULT_POLL_INTERVAL = 1_000;
const DEFAULT_ERROR_RETRY_INTERVAL = 1_000;
const DEFAULT_READ_BLOCK = 0;
const PROMOTE_DELAYED_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then
  return 0
end
local streamId = redis.call('XADD', KEYS[2], '*', 'job', ARGV[1])
redis.call('ZREM', KEYS[1], ARGV[1])
return streamId
`;

export class RedisStreamQueue {
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(
    private readonly redis: RedisStreamQueueLike,
    options: RedisStreamQueueOptions = {},
  ) {
    this.prefix = options.prefix ?? '';
    this.now = options.now ?? Date.now;
  }

  public async add<TData>(
    definition: QueueDefinition<TData>,
    payload: TData,
    options: QueueAddOptions,
  ): Promise<QueueAddResult> {
    if (!options?.context) throw new MissingExecutionContextError(`queue enqueue ${definition.name}`);
    const data = parsePayload(definition, payload);
    const now = this.now();
    const delay = assertNonNegativeInteger(options.delay ?? 0, 'delay');
    const maxAttempts = assertPositiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 'maxAttempts');
    const runAt = now + delay;
    const id = randomUUID();
    const jobId = options.jobId;
    const context = parseExecutionContext(options.context);
    const job: StoredQueueJob = {
      v: 1,
      id,
      queue: definition.name,
      data,
      createdAt: now,
      runAt,
      attempts: 0,
      maxAttempts,
      backoff: normalizeBackoff(options.backoff),
      ...(jobId ? { jobId } : {}),
      context,
    };
    const encoded = this.encodeJob(definition, job);
    let reservedDedupe = false;

    if (jobId) {
      const result = await this.redis.set(this.dedupeKey(definition, jobId), id, 'NX');
      if (result !== 'OK') {
        const existing = await this.redis.get(this.dedupeKey(definition, jobId));
        return {
          accepted: false,
          duplicate: true,
          id: existing ?? id,
          jobId,
          runAt,
        };
      }
      reservedDedupe = true;
    }

    try {
      if (runAt > now) {
        await this.redis.zadd(this.delayedKey(definition), runAt, encoded);
        return {
          accepted: true,
          duplicate: false,
          id,
          ...(jobId ? { jobId } : {}),
          runAt,
        };
      }

      const streamId = await this.redis.xadd(this.streamKey(definition), '*', 'job', encoded);
      return {
        accepted: true,
        duplicate: false,
        id,
        ...(jobId ? { jobId } : {}),
        streamId,
        runAt,
      };
    } catch (err) {
      if (reservedDedupe && jobId) {
        await this.redis.del(this.dedupeKey(definition, jobId)).catch(() => undefined);
      }
      throw err;
    }
  }

  public worker<TData>(
    definition: QueueDefinition<TData>,
    handler: QueueWorkerHandler<TData>,
    options: QueueWorkerOptions = {},
  ): RedisStreamQueueWorker<TData> {
    return new RedisStreamQueueWorker(this, definition, handler, options);
  }

  public async readDeadLetters<TData>(
    definition: QueueDefinition<TData>,
    options: ReadDeadLettersOptions = {},
  ): Promise<Array<QueueDeadLetter<TData>>> {
    const entries = await this.redis.xrange(
      this.deadLetterKey(definition),
      '-',
      '+',
      'COUNT',
      options.count ?? 100,
    ) as RedisStreamEntry[];

    return entries.map(([streamId, fields]) => {
      const stored = this.decodeEntry(definition, fields);
      const data = parsePayload(definition, stored.data);
      return {
        id: stored.id,
        queue: stored.queue,
        data,
        attempt: stored.attempts,
        maxAttempts: stored.maxAttempts,
        streamId,
        ...(stored.jobId ? { jobId: stored.jobId } : {}),
        createdAt: stored.createdAt,
        runAt: stored.runAt,
        context: parseExecutionContext(stored.context),
        ...(stored.firstFailureReason ? { firstFailureReason: stored.firstFailureReason } : {}),
        ...(stored.lastFailureReason ? { lastFailureReason: stored.lastFailureReason } : {}),
      };
    });
  }

  public async runWorkerOnce<TData>(
    definition: QueueDefinition<TData>,
    handler: QueueWorkerHandler<TData>,
    options: RequiredWorkerOptions,
  ): Promise<number> {
    await this.ensureGroup(definition, options.group);
    await this.promoteDelayed(definition, options.concurrency);

    const claimed = await this.claimStale(definition, options);
    const entries = claimed.length > 0 ? claimed : await this.readNew(definition, options);
    if (entries.length === 0) return 0;

    await Promise.all(entries.map(entry => this.processEntry(definition, handler, options, entry)));
    return entries.length;
  }

  private async processEntry<TData>(
    definition: QueueDefinition<TData>,
    handler: QueueWorkerHandler<TData>,
    options: RequiredWorkerOptions,
    [streamId, fields]: RedisStreamEntry,
  ): Promise<void> {
    const stored = this.decodeEntry(definition, fields);
    const attempt = stored.attempts + 1;

    try {
      const job = this.createJob(definition, stored, streamId, attempt);
      const context = parseExecutionContext(stored.context);
      await handler(job, createInvocationContext(
        context,
        new AbortController().signal,
        `queue worker ${definition.name}`,
      ));
    } catch (err) {
      await this.handleFailure(definition, stored, streamId, attempt, options, err);
      return;
    }

    await this.acknowledge(definition, options, streamId);
  }

  private async acknowledge<TData>(
    definition: QueueDefinition<TData>,
    options: RequiredWorkerOptions,
    streamId: string,
  ): Promise<void> {
    await this.redis.xack(this.streamKey(definition), options.group, streamId);
    if (options.removeOnAck) {
      await this.redis.xdel(this.streamKey(definition), streamId);
    }
  }

  private async handleFailure<TData>(
    definition: QueueDefinition<TData>,
    stored: StoredQueueJob,
    streamId: string,
    attempt: number,
    options: RequiredWorkerOptions,
    err: unknown,
  ): Promise<void> {
    const reason = errorReason(err);
    const failed: StoredQueueJob = {
      ...stored,
      attempts: attempt,
      firstFailureReason: stored.firstFailureReason ?? reason,
      lastFailureReason: reason,
    };

    if (attempt < stored.maxAttempts) {
      const delay = backoffDelay(stored.backoff, attempt);
      failed.runAt = this.now() + delay;
      await this.redis.zadd(this.delayedKey(definition), failed.runAt, this.encodeJob(definition, failed));
    } else {
      await this.redis.xadd(this.deadLetterKey(definition), '*', 'job', this.encodeJob(definition, failed));
    }

    await this.acknowledge(definition, options, streamId);
  }

  private createJob<TData>(
    definition: QueueDefinition<TData>,
    stored: StoredQueueJob,
    streamId: string,
    attempt: number,
  ): QueueJob<TData> {
    return {
      id: stored.id,
      queue: stored.queue,
      data: parsePayload(definition, stored.data),
      attempt,
      maxAttempts: stored.maxAttempts,
      streamId,
      ...(stored.jobId ? { jobId: stored.jobId } : {}),
      createdAt: stored.createdAt,
      runAt: stored.runAt,
      context: parseExecutionContext(stored.context),
    };
  }

  private async promoteDelayed<TData>(definition: QueueDefinition<TData>, limit: number): Promise<number> {
    const members = await this.redis.zrangebyscore(
      this.delayedKey(definition),
      '-inf',
      this.now(),
      'LIMIT',
      0,
      limit,
    );
    let promoted = 0;

    for (const member of members) {
      const streamId = await this.redis.eval(
        PROMOTE_DELAYED_SCRIPT,
        2,
        this.delayedKey(definition),
        this.streamKey(definition),
        member,
      );
      if (streamId !== 0) promoted++;
    }

    return promoted;
  }

  private async claimStale<TData>(
    definition: QueueDefinition<TData>,
    options: RequiredWorkerOptions,
  ): Promise<RedisStreamEntry[]> {
    const pending = await this.redis.xpending(
      this.streamKey(definition),
      options.group,
      '-',
      '+',
      options.claimCount,
    ) as RedisPendingEntry[];
    const ids = pending
      .filter(([, , idle]) => idle >= options.claimIdle)
      .slice(0, options.concurrency)
      .map(([id]) => id);

    if (ids.length === 0) return [];
    return await this.redis.xclaim(
      this.streamKey(definition),
      options.group,
      options.consumer,
      options.claimIdle,
      ...ids,
    ) as RedisStreamEntry[];
  }

  private async readNew<TData>(
    definition: QueueDefinition<TData>,
    options: RequiredWorkerOptions,
  ): Promise<RedisStreamEntry[]> {
    const args: Array<string | number> = [
      'GROUP',
      options.group,
      options.consumer,
      'COUNT',
      options.concurrency,
    ];
    if (options.block > 0) {
      args.push('BLOCK', options.block);
    }
    args.push(
      'STREAMS',
      this.streamKey(definition),
      '>',
    );
    const result = await this.redis.xreadgroup(...args) as RedisStreamReadResult;
    return result?.[0]?.[1] ?? [];
  }

  private async ensureGroup<TData>(definition: QueueDefinition<TData>, group: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.streamKey(definition), group, '0', 'MKSTREAM');
    } catch (err) {
      if (!String((err as Error).message ?? err).includes('BUSYGROUP')) throw err;
    }
  }

  private decodeEntry<TData>(definition: QueueDefinition<TData>, fields: string[]): StoredQueueJob {
    const value = fieldsToObject(fields)['job'];
    if (!value) throw new QueueSerializationError(definition.name, new Error('missing job field'));
    try {
      return JSON.parse(value) as StoredQueueJob;
    } catch (err) {
      throw new QueueSerializationError(definition.name, err);
    }
  }

  private encodeJob<TData>(definition: QueueDefinition<TData>, job: StoredQueueJob): string {
    try {
      const encoded = JSON.stringify(job);
      if (encoded === undefined) throw new TypeError('JSON.stringify returned undefined');
      return encoded;
    } catch (err) {
      throw new QueueSerializationError(definition.name, err);
    }
  }

  private streamKey<TData>(definition: QueueDefinition<TData>): string {
    return `${this.prefix}queue:${definition.name}:stream`;
  }

  private delayedKey<TData>(definition: QueueDefinition<TData>): string {
    return `${this.prefix}queue:${definition.name}:delayed`;
  }

  private deadLetterKey<TData>(definition: QueueDefinition<TData>): string {
    return `${this.prefix}queue:${definition.name}:dlq`;
  }

  private dedupeKey<TData>(definition: QueueDefinition<TData>, jobId: string): string {
    return `${this.prefix}queue:${definition.name}:job:${jobId}`;
  }
}

export class RedisStreamQueueWorker<TData = unknown> {
  private readonly options: RequiredWorkerOptions;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly queue: RedisStreamQueue,
    private readonly definition: QueueDefinition<TData>,
    private readonly handler: QueueWorkerHandler<TData>,
    options: QueueWorkerOptions,
  ) {
    this.options = normalizeWorkerOptions(definition, options);
  }

  public runOnce(): Promise<number> {
    return this.queue.runWorkerOnce(this.definition, this.handler, this.options);
  }

  public start(): this {
    if (this.running) return this;
    this.running = true;
    this.loop = this.runLoop();
    return this;
  }

  public async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.runOnce();
        if (processed === 0) {
          await sleep(this.options.pollInterval);
        }
      } catch (err) {
        try {
          await this.options.onError?.(err);
        } catch {
          // Error observers must not stop a worker that is already recovering.
        }
        if (this.running) {
          await sleep(this.options.errorRetryInterval);
        }
      }
    }
  }
}

type RequiredWorkerOptions = {
  group: string;
  consumer: string;
  concurrency: number;
  block: number;
  pollInterval: number;
  errorRetryInterval: number;
  claimIdle: number;
  claimCount: number;
  removeOnAck: boolean;
  onError?: (err: unknown) => void | Promise<void>;
};

function normalizeWorkerOptions<TData>(
  definition: QueueDefinition<TData>,
  options: QueueWorkerOptions,
): RequiredWorkerOptions {
  const concurrency = assertPositiveInteger(options.concurrency ?? DEFAULT_CONCURRENCY, 'concurrency');
  return {
    group: options.group ?? `${definition.name}-workers`,
    consumer: options.consumer ?? `${process.pid}-${randomUUID()}`,
    concurrency,
    block: assertNonNegativeInteger(options.block ?? DEFAULT_READ_BLOCK, 'block'),
    pollInterval: assertNonNegativeInteger(options.pollInterval ?? DEFAULT_POLL_INTERVAL, 'pollInterval'),
    errorRetryInterval: assertNonNegativeInteger(
      options.errorRetryInterval ?? DEFAULT_ERROR_RETRY_INTERVAL,
      'errorRetryInterval',
    ),
    claimIdle: assertNonNegativeInteger(options.claimIdle ?? DEFAULT_CLAIM_IDLE, 'claimIdle'),
    claimCount: assertPositiveInteger(options.claimCount ?? concurrency, 'claimCount'),
    removeOnAck: options.removeOnAck ?? false,
    onError: options.onError,
  };
}

function normalizeBackoff(backoff: QueueBackoff | undefined): StoredQueueBackoff {
  if (backoff === undefined) return { type: 'fixed', delay: 0 };
  if (typeof backoff === 'number') {
    return { type: 'fixed', delay: assertNonNegativeInteger(backoff, 'backoff') };
  }
  if (backoff.type === 'fixed') {
    return { type: 'fixed', delay: assertNonNegativeInteger(backoff.delay, 'backoff.delay') };
  }
  return {
    type: 'exponential',
    baseMs: assertNonNegativeInteger(backoff.baseMs, 'backoff.baseMs'),
    ...(backoff.maxMs !== undefined ? { maxMs: assertNonNegativeInteger(backoff.maxMs, 'backoff.maxMs') } : {}),
  };
}

function backoffDelay(backoff: StoredQueueBackoff, attempt: number): number {
  if (backoff.type === 'fixed') return backoff.delay;
  const delay = backoff.baseMs * 2 ** Math.max(0, attempt - 1);
  return backoff.maxMs === undefined ? delay : Math.min(delay, backoff.maxMs);
}

function fieldsToObject(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || Math.trunc(value) !== value) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || Math.trunc(value) !== value) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
