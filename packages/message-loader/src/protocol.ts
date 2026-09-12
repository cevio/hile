export function validateProtocol(protocol: unknown): void {
  if (protocol !== undefined && (
    typeof protocol !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(protocol)
  )) {
    throw new TypeError('Invalid message protocol');
  }
}
