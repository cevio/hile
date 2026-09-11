import { Exception } from '@hile/message-modem';

export type HttpOverMicroErrorCode =
  | 'INVALID_DEFINITION'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE';

/**
 * A protocol-boundary failure. `status` survives the Micro transport so an
 * HTTP gateway can distinguish invalid client input from an invalid upstream.
 */
export class HttpOverMicroError extends Exception {
  override readonly name = 'HttpOverMicroError';
  readonly cause?: unknown;

  constructor(
    readonly code: HttpOverMicroErrorCode,
    status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(status, message);
    this.cause = options?.cause;
  }
}
