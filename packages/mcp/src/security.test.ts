import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createExecutionContext } from '@hile/context';
import {
  createMcpEd25519InvocationCredentialSigner,
  createMcpEd25519InvocationCredentialVerifier,
  createMcpHmacInvocationCredentialCodec,
} from './security.js';

describe('MCP invocation credentials', () => {
  const descriptor = {
    executionContext: createExecutionContext({ requestId: 'mcp-security-test' }),
    providerId: 'orders', instanceId: 'a', fingerprint: 'f'.repeat(64),
    kind: 'tool' as const, name: 'lookup', input: { id: '42' },
  };

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
    expect(() => codec.verify(credential, {
      ...descriptor,
      executionContext: createExecutionContext({ requestId: 'substituted' }),
    })).toThrow(/invalid/i);
  });

  it('rejects malformed principals before signing', () => {
    const codec = createMcpHmacInvocationCredentialCodec({ secret: 'x'.repeat(32) });
    expect(() => codec.create(descriptor, { subject: 'user', scopes: [], claims: 'invalid' } as any)).toThrow(/principal/i);
  });

  it('lets one gateway authority sign for every provider without sharing its private key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signer = createMcpEd25519InvocationCredentialSigner({
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      issuer: 'company-mcp-gateway',
    });
    const verifier = createMcpEd25519InvocationCredentialVerifier({
      publicKey: publicKey.export({ format: 'pem', type: 'spki' }),
      issuer: 'company-mcp-gateway',
    });
    const principal = { subject: 'config-agent', scopes: ['*'] };
    const credential = signer.create(descriptor, principal);

    expect(signer.publicKey).toMatch(/BEGIN PUBLIC KEY/);
    expect(signer.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(signer)).not.toContain('key');
    expect(Object.isFrozen(signer)).toBe(true);
    expect(() => { (signer as any).keyId = 'mutated'; }).toThrow();
    expect(Object.keys(verifier)).toEqual([]);
    expect(verifier.verify(credential, descriptor)).toEqual(principal);
    expect(() => verifier.verify(credential, descriptor)).toThrow(/replayed/i);
    expect('verify' in signer).toBe(false);
    expect('create' in verifier).toBe(false);
  });

  it('binds Ed25519 credentials to the exact descriptor and issuer', () => {
    const keys = generateKeyPairSync('ed25519');
    const signer = createMcpEd25519InvocationCredentialSigner({
      privateKey: keys.privateKey,
      issuer: 'gateway-a',
    });
    const credential = signer.create(descriptor, undefined);

    expect(() => createMcpEd25519InvocationCredentialVerifier({
      publicKey: keys.publicKey,
      issuer: 'gateway-a',
    }).verify(credential, { ...descriptor, providerId: 'payments' })).toThrow(/invalid/i);
    expect(() => createMcpEd25519InvocationCredentialVerifier({
      publicKey: keys.publicKey,
      issuer: 'gateway-b',
    }).verify(credential, descriptor)).toThrow(/invalid/i);
  });

  it('rejects credentials from an untrusted gateway authority', () => {
    const trusted = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const signer = createMcpEd25519InvocationCredentialSigner({
      privateKey: attacker.privateKey,
      issuer: 'company-mcp-gateway',
    });
    const verifier = createMcpEd25519InvocationCredentialVerifier({
      publicKey: trusted.publicKey,
      issuer: 'company-mcp-gateway',
    });

    expect(() => verifier.verify(signer.create(descriptor, undefined), descriptor)).toThrow(/invalid/i);
  });

  it('accepts overlapping public keys during zero-downtime authority rotation', () => {
    const previous = generateKeyPairSync('ed25519');
    const next = generateKeyPairSync('ed25519');
    const verifier = createMcpEd25519InvocationCredentialVerifier({
      publicKeys: [previous.publicKey, next.publicKey],
      issuer: 'company-mcp-gateway',
    });
    const previousCredential = createMcpEd25519InvocationCredentialSigner({
      privateKey: previous.privateKey,
      issuer: 'company-mcp-gateway',
    }).create(descriptor, undefined);
    const nextCredential = createMcpEd25519InvocationCredentialSigner({
      privateKey: next.privateKey,
      issuer: 'company-mcp-gateway',
    }).create({ ...descriptor, instanceId: 'b' }, undefined);

    expect(verifier.verify(previousCredential, descriptor)).toBeUndefined();
    expect(verifier.verify(nextCredential, { ...descriptor, instanceId: 'b' })).toBeUndefined();
  });

  it('bounds credential lifetime while tolerating small cross-service clock skew', () => {
    const keys = generateKeyPairSync('ed25519');
    const signer = createMcpEd25519InvocationCredentialSigner({
      privateKey: keys.privateKey,
      ttlMs: 1_000,
      clock: () => 10_000,
    });
    const credential = signer.create(descriptor, undefined);

    expect(createMcpEd25519InvocationCredentialVerifier({
      publicKey: keys.publicKey,
      maxTtlMs: 1_000,
      clockToleranceMs: 100,
      clock: () => 11_050,
    }).verify(credential, descriptor)).toBeUndefined();
    expect(() => createMcpEd25519InvocationCredentialVerifier({
      publicKey: keys.publicKey,
      maxTtlMs: 1_000,
      clockToleranceMs: 100,
      clock: () => 11_101,
    }).verify(credential, descriptor)).toThrow(/expired/i);
    expect(() => createMcpEd25519InvocationCredentialVerifier({
      publicKey: keys.publicKey,
      maxTtlMs: 999,
      clock: () => 10_500,
    }).verify(credential, descriptor)).toThrow(/expired/i);
  });

  it('validates Ed25519 authority construction options', () => {
    const keys = generateKeyPairSync('ed25519');
    expect(() => createMcpEd25519InvocationCredentialSigner(undefined as any)).toThrow(/options/i);
    expect(() => createMcpEd25519InvocationCredentialSigner({} as any)).toThrow(/private key/i);
    expect(() => createMcpEd25519InvocationCredentialVerifier(undefined as any)).toThrow(/options/i);
    expect(() => createMcpEd25519InvocationCredentialVerifier({ publicKeys: [] })).toThrow(/public keys/i);
    expect(() => createMcpEd25519InvocationCredentialVerifier({
      publicKey: keys.publicKey,
      clockToleranceMs: -1,
    })).toThrow(/clockToleranceMs/i);
  });

  it('rejects unsafe clock values instead of signing or accepting ambiguous timestamps', () => {
    const keys = generateKeyPairSync('ed25519');
    const signer = createMcpEd25519InvocationCredentialSigner({
      privateKey: keys.privateKey,
      clock: () => Number.NaN,
    });
    expect(() => signer.create(descriptor, undefined)).toThrow(/clock/i);

    const credential = createMcpEd25519InvocationCredentialSigner({
      privateKey: keys.privateKey,
      clock: () => 10_000,
    }).create(descriptor, undefined);
    expect(() => createMcpEd25519InvocationCredentialVerifier({
      publicKey: keys.publicKey,
      clock: () => Number.POSITIVE_INFINITY,
    }).verify(credential, descriptor)).toThrow(/clock/i);
    expect(() => createMcpEd25519InvocationCredentialVerifier({
      publicKey: keys.publicKey,
      clock: () => Number.MAX_SAFE_INTEGER,
    }).verify(credential, descriptor)).toThrow(/clock/i);
  });

  it('rejects non-Ed25519 authority keys', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => createMcpEd25519InvocationCredentialSigner({ privateKey })).toThrow(/Ed25519/i);
    expect(() => createMcpEd25519InvocationCredentialVerifier({ publicKey })).toThrow(/Ed25519/i);
  });

  it('refuses to place the Gateway private key in a Provider verifier', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() => createMcpEd25519InvocationCredentialVerifier({ publicKey: privateKey })).toThrow(/public key/i);
    expect(() => createMcpEd25519InvocationCredentialVerifier({
      publicKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    })).toThrow(/public key/i);
  });
});
