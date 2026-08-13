import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalizeRscDiscoveryAnnouncement,
  type RscDiscoveryAnnouncement,
} from '@hile/rsc-discovery';

export interface HmacRscDiscoveryCredential {
  secret: string | Uint8Array;
  /** Plugin identities this signing key is authorized to publish. */
  pluginIds: readonly string[];
}

export function createHmacRscDiscoveryAuthorizer(
  resolveCredential: (
    keyId: string,
    announcement: RscDiscoveryAnnouncement,
  ) => HmacRscDiscoveryCredential | undefined,
): (announcement: RscDiscoveryAnnouncement) => boolean {
  return (announcement) => {
    if (announcement.authentication.scheme !== 'hmac-sha256') return false;
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
    const { authentication, ...unsigned } = announcement;
    const expected = createHmac('sha256', credential.secret)
      .update(canonicalizeRscDiscoveryAnnouncement(unsigned))
      .digest();
    let actual: Buffer;
    try { actual = Buffer.from(authentication.signature, 'base64url'); } catch { return false; }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}
