import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalizeRscDiscoveryAnnouncement,
  isTrustedInternalRscDiscoveryAuthentication,
  type RscDiscoveryAnnouncement,
} from '@hile/rsc-discovery';

export interface HmacRscDiscoveryCredential {
  secret: string | Uint8Array;
  /** Plugin identities this signing key is authorized to publish. */
  pluginIds: readonly string[];
  /** Reject legacy announcements that do not carry a generation-bound signature. */
  requireGeneration?: boolean;
}

export function createHmacRscDiscoveryAuthorizer(
  resolveCredential: (
    keyId: string,
    announcement: RscDiscoveryAnnouncement,
  ) => HmacRscDiscoveryCredential | undefined,
): (announcement: RscDiscoveryAnnouncement) => boolean {
  return (announcement) => {
    if (isTrustedInternalRscDiscoveryAuthentication(announcement.authentication)
      || announcement.authentication.scheme !== 'hmac-sha256') return false;
    const credential = resolveCredential(
      announcement.authentication.keyId,
      structuredClone(announcement),
    );
    if (
      credential === undefined
      || !Array.isArray(credential.pluginIds)
      || credential.pluginIds.length === 0
      || !credential.pluginIds.includes(announcement.pluginId)
      || (typeof credential.secret === 'string' && credential.secret.length === 0)
      || (credential.secret instanceof Uint8Array && credential.secret.byteLength === 0)
    ) return false;
    if (credential.requireGeneration
      && (announcement.generation === undefined
        || announcement.authentication.generationSignature === undefined)) return false;
    const { authentication, ...unsigned } = announcement;
    const { generation: _generation, ...legacyUnsigned } = unsigned;
    const verify = (signature: string | undefined, payload: typeof unsigned): boolean => {
      if (!signature) return false;
      const expected = createHmac('sha256', credential.secret)
        .update(canonicalizeRscDiscoveryAnnouncement(payload))
        .digest();
      let actual: Buffer;
      try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    };
    if (!verify(authentication.signature, legacyUnsigned)) return false;
    return unsigned.generation === undefined
      || verify(authentication.generationSignature, unsigned);
  };
}

/**
 * Accepts unsigned discovery only when every service that can reach the internal
 * Hile Micro network is inside the deployment trust boundary.
 */
export function createTrustedInternalRscDiscoveryAuthorizer(): (
  announcement: RscDiscoveryAnnouncement,
) => boolean {
  return (announcement) =>
    isTrustedInternalRscDiscoveryAuthentication(announcement.authentication);
}
