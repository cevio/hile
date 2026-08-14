export type HileMcpErrorCode =
  | 'INVALID_DEFINITION'
  | 'DUPLICATE_CAPABILITY'
  | 'PROVIDER_ATTACH_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CATALOG_CONFLICT'
  | 'GATEWAY_CLOSED';

export class HileMcpError extends Error {
  constructor(
    readonly code: HileMcpErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HileMcpError';
  }
}
