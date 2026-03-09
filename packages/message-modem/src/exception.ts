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