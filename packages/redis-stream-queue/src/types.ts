import type { ExecutionContext, InvocationContext } from '@hile/context';

export type QueueSafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown };

export type QueueSchema<T> =
  | { parse(value: unknown): T }
  | { safeParse(value: unknown): QueueSafeParseResult<T> };

export type InferQueueSchema<TSchema> =
  TSchema extends { parse(value: unknown): infer T } ? T
  : TSchema extends { safeParse(value: unknown): QueueSafeParseResult<infer T> } ? T
  : never;

export type QueueDefinition<TData = unknown, TName extends string = string> = {
  readonly name: TName;
  readonly schema?: QueueSchema<TData>;
};

export type QueueBackoff =
  | number
  | {
    type: 'fixed';
    delay: number;
  }
  | {
    type: 'exponential';
    baseMs: number;
    maxMs?: number;
  };

export type QueueAddOptions = {
  context: ExecutionContext;
  jobId?: string;
  delay?: number;
  maxAttempts?: number;
  backoff?: QueueBackoff;
};

export type QueueAddResult = {
  accepted: boolean;
  duplicate: boolean;
  id: string;
  jobId?: string;
  streamId?: string;
  runAt: number;
};

export type QueueJob<TData = unknown> = {
  id: string;
  queue: string;
  data: TData;
  attempt: number;
  maxAttempts: number;
  streamId: string;
  jobId?: string;
  createdAt: number;
  runAt: number;
  context: ExecutionContext;
};

export type QueueDeadLetter<TData = unknown> = Omit<QueueJob<TData>, 'streamId'> & {
  streamId: string;
  firstFailureReason?: string;
  lastFailureReason?: string;
};

export type QueueWorkerHandler<TData = unknown> = (
  job: QueueJob<TData>,
  invocation: InvocationContext,
) => void | Promise<void>;

export type QueueWorkerOptions = {
  group?: string;
  consumer?: string;
  concurrency?: number;
  block?: number;
  pollInterval?: number;
  errorRetryInterval?: number;
  claimIdle?: number;
  claimCount?: number;
  removeOnAck?: boolean;
  onError?: (err: unknown) => void | Promise<void>;
};

export type RedisStreamEntry = [id: string, fields: string[]];
export type RedisStreamReadResult = Array<[stream: string, entries: RedisStreamEntry[]]> | null;
export type RedisPendingEntry = [id: string, consumer: string, idle: number, deliveries: number];

export interface RedisStreamQueueLike {
  xgroup(...args: any[]): Promise<any>;
  xadd(...args: any[]): Promise<any>;
  xreadgroup(...args: any[]): Promise<any>;
  xpending(...args: any[]): Promise<any>;
  xclaim(...args: any[]): Promise<any>;
  xack(...args: any[]): Promise<any>;
  xdel(...args: any[]): Promise<any>;
  xrange(...args: any[]): Promise<any>;
  zadd(...args: any[]): Promise<any>;
  zrangebyscore(...args: any[]): Promise<any>;
  zrem(...args: any[]): Promise<any>;
  eval(...args: any[]): Promise<any>;
  set(...args: any[]): Promise<any>;
  get(...args: any[]): Promise<any>;
  del(...args: any[]): Promise<any>;
}

export type RedisStreamQueueOptions = {
  prefix?: string;
  now?: () => number;
};

export type ReadDeadLettersOptions = {
  count?: number;
};

export type StoredQueueBackoff =
  | { type: 'fixed'; delay: number }
  | { type: 'exponential'; baseMs: number; maxMs?: number };

export type StoredQueueJob = {
  v: 1;
  id: string;
  queue: string;
  data: unknown;
  createdAt: number;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  backoff: StoredQueueBackoff;
  jobId?: string;
  context: ExecutionContext;
  firstFailureReason?: string;
  lastFailureReason?: string;
};
