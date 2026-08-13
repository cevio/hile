import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteServerReference } from '@hile/rsc/client';
import { encodeRscServerFunctionValue } from '@hile/rsc/server-functions';
import './client';

afterEach(() => vi.unstubAllGlobals());

describe('Next RSC Server Reference factory', () => {
  it('installs the Next Turbopack reference implementation for remote client modules', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      value: await encodeRscServerFunctionValue({ ok: true }),
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const reference = createRemoteServerReference(
      'com.example.plugin/build-1/src/actions#save',
      'save',
    );

    await expect(reference({ value: 1 })).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
