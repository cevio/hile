export class IdempotencyError extends Error {
  constructor(message: string, public readonly key: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IdempotencyConflictError extends IdempotencyError {
  constructor(key: string) {
    super(`Idempotency key is already in flight: ${key}`, key);
  }
}

export class IdempotencyTimeoutError extends IdempotencyError {
  constructor(key: string) {
    super(`Timed out waiting for idempotency result: ${key}`, key);
  }
}

export class IdempotencyPayloadMismatchError extends IdempotencyError {
  constructor(key: string) {
    super(`Idempotency key was reused with a different payload: ${key}`, key);
  }
}

export class IdempotencyOwnershipLostError extends IdempotencyError {
  constructor(key: string) {
    super(`Idempotency owner lost the in-flight key before commit: ${key}`, key);
  }
}

export class IdempotencyRetryableError extends IdempotencyError {
  constructor(key: string) {
    super(`Idempotency in-flight key disappeared before a result was available: ${key}`, key);
  }
}
