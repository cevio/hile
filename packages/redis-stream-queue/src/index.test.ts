import { describe, expect, it, vi } from 'vitest';
import { getContext, runWithContext } from '@hile/context';
import {
  QueueSchemaError,
  RedisStreamQueue,
  defineQueue,
  type RedisStreamQueueLike,
} from './index';

type StreamEntry = {
  id: string;
  fields: string[];
};

type GroupState = {
  delivered: Set<string>;
  pending: Map<string, {
    consumer: string;
    deliveredAt: number;
    deliveries: number;
  }>;
};

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MemoryRedis implements RedisStreamQueueLike {
  public now = 0;
  private sequence = 0;
  private readonly streams = new Map<string, StreamEntry[]>();
  private readonly groups = new Map<string, GroupState>();
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly values = new Map<string, string>();
  public xreadgroupCalls: Array<Array<string | number>> = [];
  public failNextXadd = false;

  public async xgroup(command: string, key: string, group: string, _id: string, mkstream?: string) {
    if (command !== 'CREATE') throw new Error(`unsupported xgroup command: ${command}`);
    if (mkstream === 'MKSTREAM' && !this.streams.has(key)) this.streams.set(key, []);
    const groupKey = this.groupKey(key, group);
    if (this.groups.has(groupKey)) throw new Error('BUSYGROUP Consumer Group name already exists');
    this.groups.set(groupKey, {
      delivered: new Set(),
      pending: new Map(),
    });
    return 'OK';
  }

  public async xadd(key: string, id: string, ...fieldValues: string[]) {
    if (this.failNextXadd) {
      this.failNextXadd = false;
      throw new Error('xadd failed');
    }
    const entries = this.streams.get(key) ?? [];
    const streamId = id === '*' ? `${++this.sequence}-0` : id;
    entries.push({ id: streamId, fields: fieldValues });
    this.streams.set(key, entries);
    return streamId;
  }

  public async xreadgroup(...args: Array<string | number>) {
    this.xreadgroupCalls.push(args);
    const groupIndex = args.indexOf('GROUP');
    const countIndex = args.indexOf('COUNT');
    const streamsIndex = args.indexOf('STREAMS');
    if (groupIndex < 0 || streamsIndex < 0) throw new Error('invalid xreadgroup arguments');

    const group = String(args[groupIndex + 1]);
    const consumer = String(args[groupIndex + 2]);
    const count = countIndex >= 0 ? Number(args[countIndex + 1]) : 1;
    const key = String(args[streamsIndex + 1]);
    const id = String(args[streamsIndex + 2]);
    if (id !== '>') throw new Error('MemoryRedis only supports XREADGROUP id >');

    const groupState = this.requireGroup(key, group);
    const selected: StreamEntry[] = [];
    for (const entry of this.streams.get(key) ?? []) {
      if (selected.length >= count) break;
      if (groupState.delivered.has(entry.id)) continue;
      groupState.delivered.add(entry.id);
      groupState.pending.set(entry.id, {
        consumer,
        deliveredAt: this.now,
        deliveries: 1,
      });
      selected.push(entry);
    }

    if (selected.length === 0) return null;
    return [[key, selected.map(entry => [entry.id, entry.fields] as [string, string[]])]];
  }

  public async xpending(key: string, group: string, _start: string, _end: string, count: number) {
    const state = this.requireGroup(key, group);
    return [...state.pending.entries()]
      .slice(0, count)
      .map(([id, pending]) => [
        id,
        pending.consumer,
        Math.max(0, this.now - pending.deliveredAt),
        pending.deliveries,
      ] as [string, string, number, number]);
  }

  public async xclaim(key: string, group: string, consumer: string, minIdle: number, ...ids: string[]) {
    const state = this.requireGroup(key, group);
    const claimed: Array<[string, string[]]> = [];
    for (const id of ids) {
      const pending = state.pending.get(id);
      if (!pending || this.now - pending.deliveredAt < minIdle) continue;
      pending.consumer = consumer;
      pending.deliveredAt = this.now;
      pending.deliveries++;
      const entry = (this.streams.get(key) ?? []).find(item => item.id === id);
      if (entry) claimed.push([entry.id, entry.fields]);
    }
    return claimed;
  }

  public async xack(key: string, group: string, ...ids: string[]) {
    const state = this.requireGroup(key, group);
    let count = 0;
    for (const id of ids) {
      if (state.pending.delete(id)) count++;
    }
    return count;
  }

  public async xrange(key: string, _start: string, _end: string, countCommand?: string, count?: number) {
    const entries = this.streams.get(key) ?? [];
    const limited = countCommand === 'COUNT' && count !== undefined ? entries.slice(0, count) : entries;
    return limited.map(entry => [entry.id, entry.fields] as [string, string[]]);
  }

  public async zadd(key: string, score: number, member: string) {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    const isNew = !zset.has(member);
    zset.set(member, score);
    this.zsets.set(key, zset);
    return isNew ? 1 : 0;
  }

  public async zrangebyscore(key: string, min: string | number, max: string | number, ...args: Array<string | number>) {
    const minScore = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
    const maxScore = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
    const limitIndex = args.indexOf('LIMIT');
    const offset = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 0;
    const count = limitIndex >= 0 ? Number(args[limitIndex + 2]) : Number.POSITIVE_INFINITY;
    return [...(this.zsets.get(key) ?? new Map<string, number>()).entries()]
      .filter(([, score]) => score >= minScore && score <= maxScore)
      .sort((a, b) => a[1] - b[1])
      .slice(offset, offset + count)
      .map(([member]) => member);
  }

  public async zrem(key: string, ...members: string[]) {
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    let count = 0;
    for (const member of members) {
      if (zset.delete(member)) count++;
    }
    return count;
  }

  public async set(key: string, value: string, mode?: string) {
    if (mode === 'NX' && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK' as const;
  }

  public async get(key: string) {
    return this.values.get(key) ?? null;
  }

  public async del(...keys: string[]) {
    let count = 0;
    for (const key of keys) {
      if (this.values.delete(key)) count++;
    }
    return count;
  }

  public streamLength(key: string) {
    return this.streams.get(key)?.length ?? 0;
  }

  public hasValue(key: string) {
    return this.values.has(key);
  }

  private requireGroup(key: string, group: string) {
    const groupState = this.groups.get(this.groupKey(key, group));
    if (!groupState) throw new Error(`missing group ${group} for ${key}`);
    return groupState;
  }

  private groupKey(key: string, group: string) {
    return `${key}\n${group}`;
  }
}

type EmailPayload = {
  template: 'welcome' | 'receipt';
  userId: string;
};

const EmailSchema = {
  parse(value: unknown): EmailPayload {
    if (
      typeof value === 'object' &&
      value !== null &&
      ((value as EmailPayload).template === 'welcome' || (value as EmailPayload).template === 'receipt') &&
      typeof (value as EmailPayload).userId === 'string'
    ) {
      return value as EmailPayload;
    }
    throw new Error('invalid email payload');
  },
};

describe('@hile/redis-stream-queue', () => {
  it('adds and processes a typed job through a Redis consumer group', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    const handled: Array<{ data: EmailPayload; attempt: number; jobId?: string }> = [];

    const added = await queue.add(emailQueue, {
      template: 'welcome',
      userId: 'user-1',
    }, {
      jobId: 'welcome:user-1',
      maxAttempts: 3,
    });

    expect(added).toMatchObject({
      accepted: true,
      duplicate: false,
      jobId: 'welcome:user-1',
      runAt: 0,
    });

    const worker = queue.worker(emailQueue, async (job) => {
      handled.push({
        data: job.data,
        attempt: job.attempt,
        jobId: job.jobId,
      });
    }, {
      group: 'email-workers',
      consumer: 'worker-1',
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(handled).toEqual([{
      data: { template: 'welcome', userId: 'user-1' },
      attempt: 1,
      jobId: 'welcome:user-1',
    }]);
  });

  it('deduplicates enqueues with the same jobId', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    const handled = vi.fn();

    await expect(queue.add(emailQueue, { template: 'welcome', userId: 'user-1' }, { jobId: 'welcome:user-1' }))
      .resolves.toMatchObject({ accepted: true, duplicate: false });
    await expect(queue.add(emailQueue, { template: 'receipt', userId: 'user-1' }, { jobId: 'welcome:user-1' }))
      .resolves.toMatchObject({ accepted: false, duplicate: true, jobId: 'welcome:user-1' });

    const worker = queue.worker(emailQueue, handled, { group: 'workers', consumer: 'worker-1' });
    await worker.runOnce();
    await worker.runOnce();

    expect(handled).toHaveBeenCalledOnce();
  });

  it('keeps delayed jobs invisible until their runAt time', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    const handled = vi.fn();

    await queue.add(emailQueue, { template: 'welcome', userId: 'user-1' }, {
      delay: 500,
    });

    const worker = queue.worker(emailQueue, handled, { group: 'workers', consumer: 'worker-1' });

    redis.now = 499;
    await expect(worker.runOnce()).resolves.toBe(0);
    expect(handled).not.toHaveBeenCalled();

    redis.now = 500;
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(handled).toHaveBeenCalledOnce();
  });

  it('does not pass BLOCK 0 to XREADGROUP for non-blocking runOnce calls', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    const worker = queue.worker(emailQueue, async () => {}, { group: 'workers', consumer: 'worker-1' });

    await expect(worker.runOnce()).resolves.toBe(0);

    expect(redis.xreadgroupCalls[0]).not.toContain('BLOCK');
  });

  it('retries failed jobs with backoff and moves exhausted jobs to the dead-letter stream', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    const handler = vi.fn(async () => {
      throw new Error('smtp unavailable');
    });

    await queue.add(emailQueue, { template: 'welcome', userId: 'user-1' }, {
      jobId: 'welcome:user-1',
      maxAttempts: 2,
      backoff: { type: 'fixed', delay: 1_000 },
    });

    const worker = queue.worker(emailQueue, handler, { group: 'workers', consumer: 'worker-1' });

    await expect(worker.runOnce()).resolves.toBe(1);
    await expect(queue.readDeadLetters(emailQueue)).resolves.toEqual([]);

    redis.now = 999;
    await expect(worker.runOnce()).resolves.toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);

    redis.now = 1_000;
    await expect(worker.runOnce()).resolves.toBe(1);

    const deadLetters = await queue.readDeadLetters(emailQueue);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      data: { template: 'welcome', userId: 'user-1' },
      attempt: 2,
      maxAttempts: 2,
      jobId: 'welcome:user-1',
      firstFailureReason: 'smtp unavailable',
      lastFailureReason: 'smtp unavailable',
    });
  });

  it('uses exponential retry backoff with an optional max delay', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    const handler = vi.fn(async () => {
      throw new Error('temporary failure');
    });

    await queue.add(emailQueue, { template: 'welcome', userId: 'user-1' }, {
      maxAttempts: 3,
      backoff: { type: 'exponential', baseMs: 100, maxMs: 150 },
    });

    const worker = queue.worker(emailQueue, handler, { group: 'workers', consumer: 'worker-1' });

    await expect(worker.runOnce()).resolves.toBe(1);
    redis.now = 99;
    await expect(worker.runOnce()).resolves.toBe(0);

    redis.now = 100;
    await expect(worker.runOnce()).resolves.toBe(1);
    redis.now = 249;
    await expect(worker.runOnce()).resolves.toBe(0);

    redis.now = 250;
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(handler).toHaveBeenCalledTimes(3);
    await expect(queue.readDeadLetters(emailQueue)).resolves.toHaveLength(1);
  });

  it('recovers stale pending jobs claimed by another consumer', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    const handled = vi.fn();
    const streamKey = 'test:queue:email:stream';

    await queue.add(emailQueue, { template: 'welcome', userId: 'user-1' });
    await redis.xgroup('CREATE', streamKey, 'workers', '0', 'MKSTREAM');
    await redis.xreadgroup('GROUP', 'workers', 'dead-worker', 'COUNT', 1, 'STREAMS', streamKey, '>');

    redis.now = 10_000;
    const worker = queue.worker(emailQueue, handled, {
      group: 'workers',
      consumer: 'worker-2',
      claimIdle: 5_000,
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(handled).toHaveBeenCalledOnce();
  });

  it('does not run more jobs than the configured worker concurrency', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    const release = createDeferred<void>();
    const started: string[] = [];

    await queue.add(emailQueue, { template: 'welcome', userId: 'user-1' });
    await queue.add(emailQueue, { template: 'welcome', userId: 'user-2' });
    await queue.add(emailQueue, { template: 'welcome', userId: 'user-3' });

    const worker = queue.worker(emailQueue, async (job) => {
      started.push(job.data.userId);
      await release.promise;
    }, {
      group: 'workers',
      consumer: 'worker-1',
      concurrency: 2,
    });

    const run = worker.runOnce();
    await vi.waitFor(() => expect(started).toHaveLength(2));
    expect(started).toEqual(['user-1', 'user-2']);

    release.resolve();
    await run;

    await worker.runOnce();
    expect(started).toEqual(['user-1', 'user-2', 'user-3']);
  });

  it('stores context when enqueueing and restores it while handling the job', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    type AppContext = { shopId: string; channel: 'web' | 'wechat' };
    const observed: Array<Partial<AppContext>> = [];

    await runWithContext<AppContext>({ shopId: 'shop-1', channel: 'wechat' }, async () => {
      await queue.add(emailQueue, { template: 'welcome', userId: 'user-1' });
    });

    const worker = queue.worker(emailQueue, async () => {
      observed.push(getContext<AppContext>());
    }, {
      group: 'workers',
      consumer: 'worker-1',
    });

    await worker.runOnce();
    expect(observed).toEqual([{ shopId: 'shop-1', channel: 'wechat' }]);
  });

  it('validates payloads before enqueueing', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);

    await expect(queue.add(emailQueue, { template: 'unknown', userId: 'user-1' } as never))
      .rejects.toBeInstanceOf(QueueSchemaError);
    expect(redis.streamLength('test:queue:email:stream')).toBe(0);
  });

  it('does not reserve a jobId when serialization fails', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const brokenQueue = defineQueue<{ value: unknown }>('broken');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    await expect(queue.add(brokenQueue, { value: circular }, { jobId: 'bad-json' }))
      .rejects.toThrow(/JSON-serializable/);

    expect(redis.hasValue('test:queue:broken:job:bad-json')).toBe(false);
  });

  it('releases a reserved jobId when enqueueing fails after dedupe', async () => {
    const redis = new MemoryRedis();
    const queue = new RedisStreamQueue(redis, { prefix: 'test:', now: () => redis.now });
    const emailQueue = defineQueue('email', EmailSchema);
    redis.failNextXadd = true;

    await expect(queue.add(emailQueue, { template: 'welcome', userId: 'user-1' }, { jobId: 'welcome:user-1' }))
      .rejects.toThrow('xadd failed');

    expect(redis.hasValue('test:queue:email:job:welcome:user-1')).toBe(false);
  });
});
