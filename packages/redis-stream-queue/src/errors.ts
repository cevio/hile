export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class QueueSchemaError extends QueueError {
  public readonly queue: string;
  public readonly cause: unknown;

  constructor(queue: string, cause: unknown) {
    super(`Invalid payload for queue "${queue}"`);
    this.queue = queue;
    this.cause = cause;
  }
}

export class QueueSerializationError extends QueueError {
  public readonly queue: string;
  public readonly cause: unknown;

  constructor(queue: string, cause: unknown) {
    super(`Queue job for "${queue}" must be JSON-serializable`);
    this.queue = queue;
    this.cause = cause;
  }
}
