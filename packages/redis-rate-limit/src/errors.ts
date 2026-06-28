import type { RateLimitResult } from './types';

export class RateLimitExceededError extends Error {
  constructor(public readonly result: RateLimitResult) {
    super(`Rate limit exceeded for key: ${result.key}`);
    this.name = new.target.name;
  }
}
