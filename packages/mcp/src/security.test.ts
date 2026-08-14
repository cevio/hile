import { describe, expect, it } from 'vitest';
import { createMcpHmacInvocationCredentialCodec } from './security.js';

describe('MCP invocation credentials', () => {
  const descriptor = { providerId: 'orders', instanceId: 'a', fingerprint: 'f'.repeat(64), kind: 'tool' as const, name: 'lookup', input: { id: '42' } };

  it('binds a signed principal to one exact invocation and rejects replay', () => {
    const codec = createMcpHmacInvocationCredentialCodec({ secret: 'x'.repeat(32) });
    const principal = { subject: 'client', scopes: ['orders:read'] };
    const credential = codec.create(descriptor, principal);
    expect(codec.verify(credential, descriptor)).toEqual(principal);
    expect(() => codec.verify(credential, descriptor)).toThrow(/replayed/i);
  });

  it('rejects tampering and descriptor substitution', () => {
    const codec = createMcpHmacInvocationCredentialCodec({ secret: 'x'.repeat(32) });
    const credential = codec.create(descriptor, undefined) as string;
    expect(() => codec.verify(`${credential}x`, descriptor)).toThrow(/invalid/i);
    expect(() => codec.verify(credential, { ...descriptor, name: 'delete' })).toThrow(/invalid/i);
  });

  it('rejects malformed principals before signing', () => {
    const codec = createMcpHmacInvocationCredentialCodec({ secret: 'x'.repeat(32) });
    expect(() => codec.create(descriptor, { subject: 'user', scopes: [], claims: 'invalid' } as any)).toThrow(/principal/i);
  });
});
