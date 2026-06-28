export class MissingContextError extends Error {
  public readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Missing required context keys: ${keys.join(', ')}`);
    this.name = 'MissingContextError';
    this.keys = [...keys];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
