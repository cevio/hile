import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomUUID,
  sign,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import type { McpInvocationCredentialCodec, McpInvocationDescriptor, McpPrincipal } from './types.js';
import { assertTimerMs } from './limits.js';
import { normalizeMcpPrincipal } from './principal.js';

export interface McpHmacInvocationCredentialOptions {
  secret: string | Uint8Array;
  issuer?: string;
  ttlMs?: number;
  clock?: () => number;
}

export type McpEd25519KeyInput = string | Buffer | KeyObject;

interface McpEd25519InvocationCredentialBaseOptions {
  issuer?: string;
  clock?: () => number;
}

export interface McpEd25519InvocationCredentialSignerOptions extends McpEd25519InvocationCredentialBaseOptions {
  privateKey: McpEd25519KeyInput;
  /** Signed credential lifetime. Defaults to 30 seconds. */
  ttlMs?: number;
}

export type McpEd25519InvocationCredentialVerifierOptions = McpEd25519InvocationCredentialBaseOptions & {
  /** Rejects credentials whose signed lifetime exceeds this value. Defaults to 30 seconds. */
  maxTtlMs?: number;
  /** Permitted difference between Gateway and Provider clocks. Defaults to 5 seconds. */
  clockToleranceMs?: number;
} & (
  | { publicKey: McpEd25519KeyInput; publicKeys?: never }
  | { publicKey?: never; publicKeys: readonly McpEd25519KeyInput[] }
);

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

function ed25519PrivateKey(input: McpEd25519KeyInput) {
  const key = input instanceof KeyObject
    ? input
    : createPrivateKey(input);
  if (key.type !== 'private') throw new TypeError('MCP invocation credential signer requires a private key');
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('MCP invocation credential private key must be Ed25519');
  return key;
}

function ed25519PublicKey(input: McpEd25519KeyInput) {
  if (input instanceof KeyObject && input.type !== 'public') {
    throw new TypeError('MCP invocation credential verifier requires a public key');
  }
  if (!(input instanceof KeyObject)) {
    let containsPrivateKey = false;
    try { createPrivateKey(input); containsPrivateKey = true; } catch { /* expected for public key material */ }
    if (containsPrivateKey) throw new TypeError('MCP invocation credential verifier requires a public key');
  }
  const key = input instanceof KeyObject ? input : createPublicKey(input);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('MCP invocation credential public key must be Ed25519');
  return key;
}

function ed25519KeyId(key: KeyObject) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  return createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('base64url');
}

function readCredentialClock(clock: () => number) {
  const value = clock();
  if (!Number.isSafeInteger(value)) throw new TypeError('MCP invocation credential clock must return a safe integer');
  return value;
}

function invocationClaims(
  issuer: string,
  ttlMs: number,
  clock: () => number,
  descriptor: McpInvocationDescriptor,
  principal: McpPrincipal | undefined,
  keyId: string,
) {
  const issuedAt = readCredentialClock(clock);
  if (!Number.isSafeInteger(issuedAt + ttlMs)) throw new TypeError('MCP invocation credential clock exceeds the safe timestamp range');
  return {
    version: 2,
    algorithm: 'Ed25519',
    keyId,
    issuer,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    nonce: randomUUID(),
    descriptorHash: descriptorHash(descriptor),
    principal: normalizeMcpPrincipal(principal),
  };
}

function parseInvocationClaims(
  payload: string,
  issuer: string,
  clock: () => number,
  maxTtlMs: number,
  clockToleranceMs: number,
  descriptor: McpInvocationDescriptor,
  keyId: string,
) {
  let claims: any;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('Invalid MCP invocation credential'); }
  const now = readCredentialClock(clock);
  if (!Number.isSafeInteger(now + clockToleranceMs) || !Number.isSafeInteger(now - clockToleranceMs)) {
    throw new TypeError('MCP invocation credential clock exceeds the safe timestamp range');
  }
  if (claims?.version !== 2 || claims.algorithm !== 'Ed25519' || claims.keyId !== keyId || claims.issuer !== issuer
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
    || claims.issuedAt > now + clockToleranceMs || claims.expiresAt < now - clockToleranceMs
    || claims.expiresAt <= claims.issuedAt
    || claims.expiresAt - claims.issuedAt > maxTtlMs || typeof claims.nonce !== 'string'
    || claims.descriptorHash !== descriptorHash(descriptor)) {
    throw new Error('Invalid or expired MCP invocation credential');
  }
  let principal: McpPrincipal | undefined;
  try { principal = normalizeMcpPrincipal(claims.principal); } catch { throw new Error('Invalid or expired MCP invocation credential'); }
  return { nonce: claims.nonce as string, expiresAt: claims.expiresAt as number, principal, now };
}

export class McpEd25519InvocationCredentialSigner implements Pick<McpInvocationCredentialCodec, 'create'> {
  readonly #key: KeyObject;
  readonly keyId: string;
  readonly publicKey: string;
  readonly #issuer: string;
  readonly #ttlMs: number;
  readonly #clock: () => number;

  constructor(options: McpEd25519InvocationCredentialSignerOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('MCP invocation credential signer options are required');
    if (options.issuer !== undefined && (typeof options.issuer !== 'string' || !options.issuer)) {
      throw new TypeError('MCP invocation credential issuer must be a non-empty string');
    }
    if (options.clock !== undefined && typeof options.clock !== 'function') throw new TypeError('MCP invocation credential clock must be a function');
    if (options.privateKey === undefined) throw new TypeError('MCP invocation credential signer private key is required');
    this.#key = ed25519PrivateKey(options.privateKey);
    this.keyId = ed25519KeyId(this.#key);
    this.publicKey = createPublicKey(this.#key).export({ format: 'pem', type: 'spki' }).toString();
    this.#issuer = options.issuer ?? '@hile/mcp';
    this.#ttlMs = options.ttlMs ?? 30_000;
    assertTimerMs(this.#ttlMs, 'MCP invocation credential ttlMs');
    this.#clock = options.clock ?? Date.now;
    Object.freeze(this);
  }

  create(descriptor: McpInvocationDescriptor, principal: McpPrincipal | undefined, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const payload = Buffer.from(JSON.stringify(invocationClaims(
      this.#issuer, this.#ttlMs, this.#clock, descriptor, principal, this.keyId,
    ))).toString('base64url');
    const signature = sign(null, Buffer.from(payload), this.#key).toString('base64url');
    return `${payload}.${signature}`;
  }
}

export class McpEd25519InvocationCredentialVerifier implements Pick<McpInvocationCredentialCodec, 'verify'> {
  readonly #keys: ReadonlyMap<string, KeyObject>;
  readonly #issuer: string;
  readonly #maxTtlMs: number;
  readonly #clockToleranceMs: number;
  readonly #clock: () => number;
  readonly #consumed = new Map<string, number>();
  #verifications = 0;

  constructor(options: McpEd25519InvocationCredentialVerifierOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('MCP invocation credential verifier options are required');
    if (options.issuer !== undefined && (typeof options.issuer !== 'string' || !options.issuer)) {
      throw new TypeError('MCP invocation credential issuer must be a non-empty string');
    }
    if (options.clock !== undefined && typeof options.clock !== 'function') throw new TypeError('MCP invocation credential clock must be a function');
    const hasPublicKey = options.publicKey !== undefined;
    const hasPublicKeys = options.publicKeys !== undefined;
    if (hasPublicKey === hasPublicKeys || (hasPublicKeys && !Array.isArray(options.publicKeys))) {
      throw new TypeError('MCP invocation credential verifier requires either publicKey or publicKeys');
    }
    const inputs = options.publicKeys ?? [options.publicKey!];
    if (!inputs.length || inputs.length > 16) throw new TypeError('MCP invocation credential verifier requires between 1 and 16 public keys');
    const keys = inputs.map(ed25519PublicKey);
    this.#keys = new Map(keys.map(key => [ed25519KeyId(key), key]));
    this.#issuer = options.issuer ?? '@hile/mcp';
    this.#maxTtlMs = options.maxTtlMs ?? 30_000;
    assertTimerMs(this.#maxTtlMs, 'MCP invocation credential maxTtlMs');
    this.#clockToleranceMs = options.clockToleranceMs ?? 5_000;
    assertTimerMs(this.#clockToleranceMs, 'MCP invocation credential clockToleranceMs', 0);
    this.#clock = options.clock ?? Date.now;
  }

  verify(credential: unknown, descriptor: McpInvocationDescriptor, signal?: AbortSignal): McpPrincipal | undefined {
    signal?.throwIfAborted();
    if (typeof credential !== 'string') throw new Error('Missing MCP invocation credential');
    const [payload, encodedSignature, extra] = credential.split('.');
    if (!payload || !encodedSignature || extra !== undefined) throw new Error('Invalid MCP invocation credential');
    let unverified: any;
    try { unverified = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('Invalid MCP invocation credential'); }
    const key = typeof unverified?.keyId === 'string' ? this.#keys.get(unverified.keyId) : undefined;
    if (!key) throw new Error('Invalid MCP invocation credential');
    let signature: Buffer;
    try { signature = Buffer.from(encodedSignature, 'base64url'); } catch { throw new Error('Invalid MCP invocation credential'); }
    if (!verifySignature(null, Buffer.from(payload), key, signature)) throw new Error('Invalid MCP invocation credential');
    const claims = parseInvocationClaims(
      payload, this.#issuer, this.#clock, this.#maxTtlMs, this.#clockToleranceMs, descriptor, unverified.keyId,
    );
    if (this.#consumed.has(claims.nonce)) throw new Error('Replayed MCP invocation credential');
    this.#consumed.set(claims.nonce, claims.expiresAt);
    if (++this.#verifications % 256 === 0) {
      for (const [nonce, expiresAt] of this.#consumed) {
        if (expiresAt < claims.now - this.#clockToleranceMs) this.#consumed.delete(nonce);
      }
    }
    return claims.principal;
  }
}

export function createMcpEd25519InvocationCredentialSigner(options: McpEd25519InvocationCredentialSignerOptions) {
  return new McpEd25519InvocationCredentialSigner(options);
}

export function createMcpEd25519InvocationCredentialVerifier(options: McpEd25519InvocationCredentialVerifierOptions) {
  return new McpEd25519InvocationCredentialVerifier(options);
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
