import { RedisIdempotency } from './idempotency';
import type {
  IdempotencyOptions,
  RedisLike,
} from './types';

export async function withIdempotency<T>(
  redis: RedisLike,
  key: string,
  fn: () => Promise<T>,
  options: IdempotencyOptions<T>,
): Promise<T> {
  return new RedisIdempotency(redis).run(key, fn, options);
}
