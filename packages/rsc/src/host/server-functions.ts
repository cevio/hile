import type { IncomingMessage } from 'node:http';
import type { RscServerFunctionWireValue } from '../server-functions/codec';
import type { RscPluginLocator } from '../transport';
import type { RscActionRequestContext } from './actions';

export interface RscHostServerFunctionRequest {
  pluginId: string;
  buildId: string;
  referenceId: string;
  args: RscServerFunctionWireValue;
}

export type RscServerFunctionAuthorizer = (
  request: RscHostServerFunctionRequest,
  context: RscActionRequestContext,
) => boolean | Promise<boolean>;

export type RscServerFunctionGatewayErrorCode =
  | 'ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST'
  | 'ERR_RSC_SERVER_FUNCTION_FORBIDDEN';

export class RscServerFunctionGatewayError extends Error {
  constructor(public readonly code: RscServerFunctionGatewayErrorCode, message: string) {
    super(message);
    this.name = 'RscServerFunctionGatewayError';
  }
}

function parseRequest(value: unknown): RscHostServerFunctionRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RscServerFunctionGatewayError('ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST', 'RSC Server Function request must be an object');
  }
  const { referenceId, args } = value as { referenceId?: unknown; args?: unknown };
  if (typeof referenceId !== 'string' || !referenceId) {
    throw new RscServerFunctionGatewayError('ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST', 'RSC Server Function referenceId must not be empty');
  }
  const match = /^([^/]+)\/([^/]+)\/(.+)#([^#]+)$/.exec(referenceId);
  if (!match) {
    throw new RscServerFunctionGatewayError('ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST', 'RSC Server Function referenceId is malformed');
  }
  if (args === undefined) {
    throw new RscServerFunctionGatewayError('ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST', 'RSC Server Function args are required');
  }
  return { pluginId: match[1]!, buildId: match[2]!, referenceId, args: args as RscServerFunctionWireValue };
}

export class RscServerFunctionGateway {
  constructor(private readonly options: {
    locator: RscPluginLocator;
    authorize: RscServerFunctionAuthorizer;
  }) {}

  public async invoke(value: unknown, context: RscActionRequestContext): Promise<RscServerFunctionWireValue> {
    const request = parseRequest(value);
    if (!await this.options.authorize(request, context)) {
      throw new RscServerFunctionGatewayError('ERR_RSC_SERVER_FUNCTION_FORBIDDEN', 'RSC Server Function request was denied');
    }
    const lease = await this.options.locator.resolve(
      { pluginId: request.pluginId, buildId: request.buildId }, { signal: context.signal },
    );
    try {
      return await lease.client.serverFunction({
        buildId: request.buildId,
        referenceId: request.referenceId,
        args: request.args,
      }, { signal: context.signal });
    } finally {
      await lease.release();
    }
  }
}

export interface RscServerFunctionHttpContext {
  method: string;
  path: string;
  status: number;
  type?: string;
  body?: unknown;
  req?: IncomingMessage;
  signal?: AbortSignal;
  requestContext?: RscActionRequestContext;
  set(name: string, value: string): void;
}

export interface RscServerFunctionMiddlewareOptions {
  gateway: Pick<RscServerFunctionGateway, 'invoke'>;
  mountPath?: string;
  bodyLimit?: number;
  readJson?: (context: RscServerFunctionHttpContext, limit: number) => Promise<unknown>;
}

function normalizeMountPath(value: string): string {
  if (!value.startsWith('/')) throw new TypeError('RSC Server Function mount path must be absolute');
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC Server Function mount path must not be root');
  return normalized;
}

async function readJsonBody(context: RscServerFunctionHttpContext, limit: number): Promise<unknown> {
  if (!context.req) throw new RscServerFunctionGatewayError('ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST', 'HTTP request body is unavailable');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of context.req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) throw new RscServerFunctionGatewayError('ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST', 'RSC Server Function body is too large');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RscServerFunctionGatewayError('ERR_RSC_SERVER_FUNCTION_INVALID_REQUEST', 'RSC Server Function body must be valid JSON');
  }
}

export function createRscServerFunctionMiddleware(options: RscServerFunctionMiddlewareOptions) {
  const mount = normalizeMountPath(options.mountPath ?? '/_hile/rsc/server-functions');
  const limit = options.bodyLimit ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('RSC Server Function body limit must be positive');
  const readJson = options.readJson ?? readJsonBody;
  return async (context: RscServerFunctionHttpContext, next: () => Promise<unknown>) => {
    if (context.path !== mount) return next();
    if (context.method.toUpperCase() !== 'POST') {
      context.status = 405;
      context.set('Allow', 'POST');
      return;
    }
    try {
      const value = await options.gateway.invoke(await readJson(context, limit), {
        ...context.requestContext,
        signal: context.signal ?? context.requestContext?.signal,
      });
      context.status = 200;
      context.type = 'application/json; charset=utf-8';
      context.body = { value };
    } catch (error) {
      if (error instanceof RscServerFunctionGatewayError) {
        context.status = error.code === 'ERR_RSC_SERVER_FUNCTION_FORBIDDEN' ? 403 : 400;
        context.type = 'application/json; charset=utf-8';
        context.body = { code: error.code, message: error.message };
        return;
      }
      context.status = 500;
      context.type = 'application/json; charset=utf-8';
      context.body = {
        code: 'ERR_RSC_SERVER_FUNCTION_FAILED',
        message: 'RSC Server Function execution failed',
      };
    }
  };
}
