import { describe, expect, it } from 'vitest';
import { HILE_RSC_REMOTE_CLIENT_IMPORT } from './rsc-client-imports';

describe('remote RSC client import boundary', () => {
  it('exposes one framework-neutral client entry without Host or transport APIs', () => {
    expect(HILE_RSC_REMOTE_CLIENT_IMPORT).toBe('@hile/rsc/client/navigation');
  });
});
