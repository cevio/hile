export class InvalidExecutionContextError extends TypeError {
  public readonly path: string;

  constructor(path: string, reason: string) {
    super(`Invalid execution context at ${path}: ${reason}`);
    this.name = 'InvalidExecutionContextError';
    this.path = path;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnsupportedExecutionContextVersionError extends Error {
  public readonly version: unknown;

  constructor(version: unknown) {
    super(`Unsupported execution context version: ${String(version)}`);
    this.name = 'UnsupportedExecutionContextVersionError';
    this.version = version;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MissingExecutionContextValueError extends Error {
  public readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Missing required execution context values: ${keys.join(', ')}`);
    this.name = 'MissingExecutionContextValueError';
    this.keys = Object.freeze([...keys]);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MissingExecutionContextError extends Error {
  constructor(boundary?: string) {
    super(boundary
      ? `Missing execution context at ${boundary}`
      : 'Missing execution context');
    this.name = 'MissingExecutionContextError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
