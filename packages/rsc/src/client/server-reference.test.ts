import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureRscServerFunctionClient,
  createRemoteServerReference,
  installRscServerReferenceRuntime,
  RscServerFunctionClientError,
} from './server-reference';
import { encodeRscServerFunctionValue } from '../server-functions/codec';

const referenceFactory = (
  id: string,
  callServer: (referenceId: string, args: unknown[]) => Promise<unknown>,
) => {
  const reference = (...args: unknown[]) => callServer(id, args);
  Object.defineProperty(reference, '$$FORM_ACTION', { value: () => ({ method: 'POST' }) });
  return reference;
};

afterEach(() => {
  vi.unstubAllGlobals();
  configureRscServerFunctionClient({ mountPath: '/_hile/rsc/server-functions' });
});

describe('RSC browser Server Function references', () => {
  it('creates a real React server reference and round-trips encoded arguments and results', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.referenceId).toBe('com.example.plugin/build-1/src/actions#save');
      expect(init.credentials).toBe('same-origin');
      expect(init.method).toBe('POST');
      return new Response(JSON.stringify({
        value: await encodeRscServerFunctionValue({ saved: true, args: request.args }),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    installRscServerReferenceRuntime(referenceFactory);

    const reference = createRemoteServerReference(
      'com.example.plugin/build-1/src/actions#save',
      'save',
    ) as ((formData: FormData) => Promise<unknown>) & { $$FORM_ACTION?: unknown };
    const formData = new FormData();
    formData.append('name', 'Hile');

    await expect(reference(formData)).resolves.toMatchObject({ saved: true });
    expect(reference.$$FORM_ACTION).toBeTypeOf('function');
    expect(fetch).toHaveBeenCalledWith('/_hile/rsc/server-functions', expect.objectContaining({
      headers: { 'content-type': 'application/json' },
    }));
  });

  it('supports a configured same-origin mount and request headers', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      value: await encodeRscServerFunctionValue('ok'),
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    configureRscServerFunctionClient({
      mountPath: '/internal/functions/',
      headers: { 'x-csrf-token': 'fixture' },
    });
    installRscServerReferenceRuntime(referenceFactory);

    await createRemoteServerReference(
      'com.example.plugin/build-1/src/actions#save',
      'save',
    )();

    expect(fetch).toHaveBeenCalledWith('/internal/functions', expect.objectContaining({
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'fixture' },
    }));
  });

  it('surfaces typed HTTP and malformed-response failures', async () => {
    installRscServerReferenceRuntime(referenceFactory);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'ERR_RSC_SERVER_FUNCTION_FORBIDDEN', message: 'denied',
    }), { status: 403 })));
    await expect(createRemoteServerReference(
      'com.example.plugin/build-1/src/actions#save', 'save',
    )()).rejects.toBeInstanceOf(RscServerFunctionClientError);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(createRemoteServerReference(
      'com.example.plugin/build-1/src/actions#save', 'save',
    )()).rejects.toThrow('value');
  });
});
