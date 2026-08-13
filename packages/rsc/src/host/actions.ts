import type { IncomingMessage } from 'node:http';
import type { RscPluginLocator } from '../transport';

export interface RscHostActionRequest {
  pluginId: string;
  buildId: string;
  actionId: string;
  input: Record<string, unknown>;
}

export interface RscActionRequestContext {
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string | string[] | undefined>>;
}

export type RscActionAuthorizer = (
  request: RscHostActionRequest,
  context: RscActionRequestContext,
) => boolean | Promise<boolean>;

export interface SameOriginCsrfAuthorizerOptions {
  expectedOrigin: string | (
    (context: RscActionRequestContext, request: RscHostActionRequest) => string | undefined | Promise<string | undefined>
  );
  readToken: (
    context: RscActionRequestContext,
    request: RscHostActionRequest,
  ) => string | undefined | Promise<string | undefined>;
  verifyToken: (
    token: string,
    request: RscHostActionRequest,
    context: RscActionRequestContext,
  ) => boolean | Promise<boolean>;
}

function header(
  headers: RscActionRequestContext['headers'],
  name: string,
): string | undefined {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function normalizedOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function createSameOriginCsrfAuthorizer(
  options: SameOriginCsrfAuthorizerOptions,
): RscActionAuthorizer {
  return async (request, context) => {
    const configuredOrigin = typeof options.expectedOrigin === 'function'
      ? await options.expectedOrigin(context, request)
      : options.expectedOrigin;
    const expectedOrigin = normalizedOrigin(configuredOrigin);
    const requestOrigin = normalizedOrigin(header(context.headers, 'origin'));
    if (!expectedOrigin || !requestOrigin || expectedOrigin !== requestOrigin) return false;
    const token = await options.readToken(context, request);
    if (!token) return false;
    return options.verifyToken(token, request, context);
  };
}

export type RscActionGatewayErrorCode =
  | 'ERR_RSC_ACTION_INVALID_REQUEST'
  | 'ERR_RSC_ACTION_FORBIDDEN';

export class RscActionGatewayError extends Error {
  constructor(
    public readonly code: RscActionGatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RscActionGatewayError';
  }
}

function parseRequest(value: unknown): RscHostActionRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RscActionGatewayError('ERR_RSC_ACTION_INVALID_REQUEST', 'RSC action request must be an object');
  }
  const request = value as Partial<RscHostActionRequest>;
  for (const field of ['pluginId', 'buildId', 'actionId'] as const) {
    if (typeof request[field] !== 'string' || request[field].length === 0) {
      throw new RscActionGatewayError(
        'ERR_RSC_ACTION_INVALID_REQUEST',
        `RSC action ${field} must not be empty`,
      );
    }
  }
  if (request.input === null || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw new RscActionGatewayError('ERR_RSC_ACTION_INVALID_REQUEST', 'RSC action input must be an object');
  }
  return request as RscHostActionRequest;
}

export class RscActionGateway {
  private readonly locator: RscPluginLocator;
  private readonly authorize: RscActionAuthorizer;

  constructor(options: { locator: RscPluginLocator; authorize: RscActionAuthorizer }) {
    this.locator = options.locator;
    this.authorize = options.authorize;
  }

  public async invoke(value: unknown, context: RscActionRequestContext): Promise<unknown> {
    const request = parseRequest(value);
    if (!await this.authorize(request, context)) {
      throw new RscActionGatewayError('ERR_RSC_ACTION_FORBIDDEN', 'RSC action request was denied');
    }
    const lease = await this.locator.resolve(
      { pluginId: request.pluginId, buildId: request.buildId },
      { signal: context.signal },
    );
    try {
      return await lease.client.action({
        buildId: request.buildId,
        actionId: request.actionId,
        input: request.input,
      }, { signal: context.signal });
    } finally {
      await lease.release();
    }
  }
}

export interface RscActionHttpContext {
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

export interface RscActionHttpGateway {
  invoke(request: unknown, context: RscActionRequestContext): Promise<unknown>;
}

export interface RscActionMiddlewareOptions {
  gateway: RscActionHttpGateway;
  mountPath?: string;
  bodyLimit?: number;
  readJson?: (context: RscActionHttpContext, limit: number) => Promise<unknown>;
}

function normalizeMountPath(value: string): string {
  if (!value.startsWith('/')) throw new TypeError('RSC action mount path must be absolute');
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) throw new TypeError('RSC action mount path must not be the root path');
  return normalized;
}

async function readJsonBody(context: RscActionHttpContext, limit: number): Promise<unknown> {
  if (!context.req) throw new RscActionGatewayError('ERR_RSC_ACTION_INVALID_REQUEST', 'HTTP request body is unavailable');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of context.req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) {
      throw new RscActionGatewayError('ERR_RSC_ACTION_INVALID_REQUEST', 'RSC action body is too large');
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RscActionGatewayError('ERR_RSC_ACTION_INVALID_REQUEST', 'RSC action body must be valid JSON');
  }
}

export function createRscActionMiddleware(options: RscActionMiddlewareOptions) {
  const mount = normalizeMountPath(options.mountPath ?? '/_hile/rsc/actions');
  const prefix = `${mount}/`;
  const limit = options.bodyLimit ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('RSC action body limit must be positive');
  const readJson = options.readJson ?? readJsonBody;

  return async (context: RscActionHttpContext, next: () => Promise<unknown>) => {
    if (!context.path.startsWith(prefix)) return next();
    const segments = context.path.slice(prefix.length).split('/');
    if (segments.length !== 3 || segments.some((segment) => !segment)) {
      context.status = 404;
      return;
    }
    if (context.method.toUpperCase() !== 'POST') {
      context.status = 405;
      context.set('Allow', 'POST');
      return;
    }
    let pluginId: string;
    let buildId: string;
    let actionId: string;
    try {
      [pluginId, buildId, actionId] = segments.map(decodeURIComponent);
    } catch {
      context.status = 400;
      return;
    }
    try {
      const body = await readJson(context, limit);
      const input = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { input?: unknown }).input
        : undefined;
      context.body = await options.gateway.invoke(
        { pluginId, buildId, actionId, input },
        { ...context.requestContext, signal: context.signal ?? context.requestContext?.signal },
      );
      context.status = 200;
      context.type = 'application/json; charset=utf-8';
    } catch (error) {
      if (error instanceof RscActionGatewayError) {
        context.status = error.code === 'ERR_RSC_ACTION_FORBIDDEN' ? 403 : 400;
        context.body = { code: error.code, message: error.message };
        return;
      }
      throw error;
    }
  };
}
