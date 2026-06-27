export class LockError extends Error {
  constructor(message: string, public readonly key: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class LockConflictError extends LockError {
  constructor(key: string) {
    super(`Redis lock is already held: ${key}`, key);
  }
}

export class LockTimeoutError extends LockError {
  constructor(key: string) {
    super(`Timed out waiting for Redis lock: ${key}`, key);
  }
}

export class LockOwnershipLostError extends LockError {
  constructor(key: string) {
    super(`Redis lock ownership was lost: ${key}`, key);
  }
}

export class LockRenewalError extends LockError {
  constructor(key: string) {
    super(`Redis lock renewal failed because ownership was lost: ${key}`, key);
  }
}
