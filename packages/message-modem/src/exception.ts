export class Exception extends Error {
  constructor(public readonly status: number | string, msg: string) {
    super(msg);
  }
}

export class TimeoutException extends Exception {
  static readonly code = 'ETIMEDOUT';
  constructor(msg: string = 'Timeout') {
    super(TimeoutException.code, msg);
  }
}

export class AbortException extends Exception {
  static readonly code = 'ECONNABORTED';
  constructor(msg: string = 'Abort') {
    super(AbortException.code, msg);
  }
}

/** A failure raised by the caller-owned request input source, not by the peer. */
export class MessageInputError extends Error {
  public readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Request input stream failed');
    this.name = 'MessageInputError';
    this.cause = cause;
  }
}
