import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { McpInvocationCredentialCodec, McpInvocationDescriptor, McpPrincipal } from './types.js';
import { assertTimerMs } from './limits.js';
import { normalizeMcpPrincipal } from './principal.js';

export interface McpHmacInvocationCredentialOptions {
  secret: string | Uint8Array;
  issuer?: string;
  ttlMs?: number;
  clock?: () => number;
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  throw new TypeError('MCP invocation credentials only support JSON values');
}

function descriptorHash(descriptor: McpInvocationDescriptor) {
  return createHash('sha256').update(canonical(descriptor)).digest('base64url');
}

export class McpHmacInvocationCredentialCodec implements McpInvocationCredentialCodec {
  private readonly key: Buffer;
  private readonly issuer: string;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly consumed = new Map<string, number>();
  private verifications = 0;

  constructor(options: McpHmacInvocationCredentialOptions) {
    this.key = Buffer.from(options.secret);
    if (this.key.byteLength < 32) throw new TypeError('MCP invocation credential secret must contain at least 32 bytes');
    this.issuer = options.issuer ?? '@hile/mcp';
    if (!this.issuer) throw new TypeError('MCP invocation credential issuer must not be empty');
    this.ttlMs = options.ttlMs ?? 30_000;
    assertTimerMs(this.ttlMs, 'MCP invocation credential ttlMs');
    this.clock = options.clock ?? Date.now;
  }

  create(descriptor: McpInvocationDescriptor, principal: McpPrincipal | undefined, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const normalizedPrincipal = normalizeMcpPrincipal(principal);
    const issuedAt = this.clock();
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      issuer: this.issuer,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      nonce: randomUUID(),
      descriptorHash: descriptorHash(descriptor),
      principal: normalizedPrincipal,
    })).toString('base64url');
    const signature = createHmac('sha256', this.key).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  verify(credential: unknown, descriptor: McpInvocationDescriptor, signal?: AbortSignal): McpPrincipal | undefined {
    signal?.throwIfAborted();
    if (typeof credential !== 'string') throw new Error('Missing MCP invocation credential');
    const [payload, encodedSignature, extra] = credential.split('.');
    if (!payload || !encodedSignature || extra !== undefined) throw new Error('Invalid MCP invocation credential');
    const signature = Buffer.from(encodedSignature, 'base64url');
    const expected = createHmac('sha256', this.key).update(payload).digest();
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) throw new Error('Invalid MCP invocation credential');
    let claims: any;
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('Invalid MCP invocation credential'); }
    const now = this.clock();
    if (claims?.version !== 1 || claims.issuer !== this.issuer || !Number.isSafeInteger(claims.issuedAt)
      || !Number.isSafeInteger(claims.expiresAt) || claims.issuedAt > now || claims.expiresAt < now
      || typeof claims.nonce !== 'string' || claims.descriptorHash !== descriptorHash(descriptor)) {
      throw new Error('Invalid or expired MCP invocation credential');
    }
    let verifiedPrincipal: McpPrincipal | undefined;
    try { verifiedPrincipal = normalizeMcpPrincipal(claims.principal); } catch { throw new Error('Invalid or expired MCP invocation credential'); }
    if (this.consumed.has(claims.nonce)) throw new Error('Replayed MCP invocation credential');
    this.consumed.set(claims.nonce, claims.expiresAt);
    if (++this.verifications % 256 === 0) {
      for (const [nonce, expiresAt] of this.consumed) if (expiresAt < now) this.consumed.delete(nonce);
    }
    return verifiedPrincipal;
  }
}

export function createMcpHmacInvocationCredentialCodec(options: McpHmacInvocationCredentialOptions) {
  return new McpHmacInvocationCredentialCodec(options);
}

/** Selects an isolated credential codec by provider ID; use distinct keys per trust domain. */
export class McpInvocationCredentialKeyring implements McpInvocationCredentialCodec {
  private readonly providers: Readonly<Record<string, McpInvocationCredentialCodec>>;

  constructor(providers: Readonly<Record<string, McpInvocationCredentialCodec>>) {
    this.providers = Object.freeze(Object.assign(Object.create(null), providers));
  }

  private codec(descriptor: McpInvocationDescriptor) {
    const codec = this.providers[descriptor.providerId];
    if (!codec) throw new Error(`No MCP invocation credential configured for provider "${descriptor.providerId}"`);
    return codec;
  }

  create(descriptor: McpInvocationDescriptor, principal: McpPrincipal | undefined, signal?: AbortSignal) {
    return this.codec(descriptor).create(descriptor, principal, signal);
  }

  verify(credential: unknown, descriptor: McpInvocationDescriptor, signal?: AbortSignal) {
    return this.codec(descriptor).verify(credential, descriptor, signal);
  }
}

export function createMcpInvocationCredentialKeyring(providers: Readonly<Record<string, McpInvocationCredentialCodec>>) {
  return new McpInvocationCredentialKeyring(providers);
}
