'use client';

import {
  decodeRscServerFunctionValue,
  encodeRscServerFunctionValue,
  type RscServerFunctionWireValue,
} from '../server-functions/codec';

export interface RscServerFunctionClientOptions {
  mountPath?: string;
  headers?: Readonly<Record<string, string>>;
}

export type RscServerReferenceFactory = (
  referenceId: string,
  callServer: (referenceId: string, args: unknown[]) => Promise<unknown>,
  exportName: string,
) => (...args: unknown[]) => Promise<unknown>;

interface ResolvedClientOptions {
  mountPath: string;
  headers: Readonly<Record<string, string>>;
}

declare global {
  var __HILE_RSC_CREATE_SERVER_REFERENCE__: ((
    referenceId: string,
    exportName: string,
  ) => (...args: unknown[]) => Promise<unknown>) | undefined;
}

let options: ResolvedClientOptions = {
  mountPath: '/_hile/rsc/server-functions',
  headers: {},
};
let referenceFactory: RscServerReferenceFactory | undefined;

function normalizeMountPath(value: string): string {
  if (!value.startsWith('/')) throw new TypeError('RSC Server Function mount path must be absolute');
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC Server Function mount path must not be root');
  return normalized;
}

export function configureRscServerFunctionClient(
  next: RscServerFunctionClientOptions,
): void {
  options = {
    mountPath: normalizeMountPath(next.mountPath ?? '/_hile/rsc/server-functions'),
    headers: Object.freeze({ ...(next.headers ?? {}) }),
  };
}

export class RscServerFunctionClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RscServerFunctionClientError';
  }
}

export async function invokeRemoteServerFunction(
  referenceId: string,
  args: unknown[],
): Promise<unknown> {
  const response = await fetch(options.mountPath, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify({
      referenceId,
      args: await encodeRscServerFunctionValue(args),
    }),
  });
  let payload: Record<string, unknown>;
  try {
    const value = await response.json();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    payload = value as Record<string, unknown>;
  } catch {
    throw new RscServerFunctionClientError(
      response.status,
      'ERR_RSC_SERVER_FUNCTION_INVALID_RESPONSE',
      'RSC Server Function response must be a JSON object',
    );
  }
  if (!response.ok) {
    throw new RscServerFunctionClientError(
      response.status,
      typeof payload.code === 'string' ? payload.code : 'ERR_RSC_SERVER_FUNCTION_FAILED',
      typeof payload.message === 'string' ? payload.message : `RSC Server Function failed: ${response.status}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'value')) {
    throw new RscServerFunctionClientError(
      response.status,
      'ERR_RSC_SERVER_FUNCTION_INVALID_RESPONSE',
      'RSC Server Function response is missing value',
    );
  }
  return decodeRscServerFunctionValue(payload.value as RscServerFunctionWireValue);
}

export function createRemoteServerReference(
  referenceId: string,
  exportName: string,
): (...args: unknown[]) => Promise<unknown> {
  if (typeof referenceId !== 'string' || !referenceId) {
    throw new TypeError('RSC Server Function reference id must not be empty');
  }
  if (typeof exportName !== 'string' || !exportName) {
    throw new TypeError('RSC Server Function export name must not be empty');
  }
  if (!referenceFactory) {
    throw new Error('Hile RSC Host did not install a framework Server Reference factory');
  }
  return referenceFactory(referenceId, invokeRemoteServerFunction, exportName);
}

export function installRscServerReferenceRuntime(factory: RscServerReferenceFactory): void {
  referenceFactory = factory;
  globalThis.__HILE_RSC_CREATE_SERVER_REFERENCE__ = createRemoteServerReference;
}
