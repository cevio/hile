import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
  type PerRequestResponseMode,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpGateway } from '../gateway/index.js';
import { mcpServerFactory } from '../gateway/gateway.js';
import { assertTimerMs } from '../limits.js';

export interface McpHttpEndpointOptions {
  path: `/${string}`;
  security: {
    allowedHostnames: readonly string[];
    allowedOriginHostnames: readonly string[];
    authentication:
      | { mode: 'public' }
      | { mode: 'required'; authenticate(request: Request): AuthInfo | Response | Promise<AuthInfo | Response> };
  };
  legacy?: 'stateless' | 'reject';
  responseMode?: PerRequestResponseMode;
  keepAliveMs?: number;
  maxSubscriptions?: number;
  onError?: (error: Error) => void;
}

export interface McpHttpEndpoint {
  middleware(context: any, next: () => Promise<unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export function createMcpHttpEndpoint(gateway: McpGateway, options: McpHttpEndpointOptions): McpHttpEndpoint {
  if (!options || typeof options.path !== 'string' || !/^\/(?:[^/?#]+(?:\/[^/?#]+)*)?$/.test(options.path)) {
    throw new TypeError('MCP endpoint path must be an absolute path without query, fragment, or empty segments');
  }
  const security = options.security;
  const validAllowlist = (value: unknown): value is readonly string[] => Array.isArray(value)
    && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0);
  if (!security || !validAllowlist(security.allowedHostnames) || !validAllowlist(security.allowedOriginHostnames)) {
    throw new TypeError('MCP HTTP allowedHostnames and allowedOriginHostnames must be explicit and non-empty');
  }
  if (!security.authentication || !['public', 'required'].includes(security.authentication.mode)
    || (security.authentication.mode === 'required' && typeof security.authentication.authenticate !== 'function')) {
    throw new TypeError('MCP HTTP authentication mode must be explicit');
  }
  if (options.legacy !== undefined && !['stateless', 'reject'].includes(options.legacy)) throw new TypeError('Invalid MCP legacy mode');
  if (options.onError !== undefined && typeof options.onError !== 'function') throw new TypeError('MCP HTTP onError must be a function');
  if (options.keepAliveMs !== undefined) assertTimerMs(options.keepAliveMs, 'MCP keepAliveMs');
  if (options.maxSubscriptions !== undefined && (!Number.isSafeInteger(options.maxSubscriptions) || options.maxSubscriptions <= 0)) {
    throw new TypeError('MCP maxSubscriptions must be a positive integer');
  }
  const allowedHostnames = [...security.allowedHostnames];
  const allowedOriginHostnames = [...security.allowedOriginHostnames];
  const authentication = security.authentication;
  const handler = createMcpHandler(mcpServerFactory(gateway), {
    legacy: options.legacy,
    responseMode: options.responseMode,
    keepAliveMs: options.keepAliveMs,
    maxSubscriptions: options.maxSubscriptions,
    onerror: options.onError,
  });
  const secured = {
    async fetch(request: Request) {
      const rejection = hostHeaderValidationResponse(request, allowedHostnames)
        ?? originValidationResponse(request, allowedOriginHostnames);
      if (rejection) return rejection;
      const authenticated = authentication.mode === 'required' ? await authentication.authenticate(request) : undefined;
      if (authenticated instanceof Response) return authenticated;
      return handler.fetch(request, { authInfo: authenticated });
    },
  };
  const nodeHandler = toNodeHandler(secured, { onerror: options.onError });
  return {
    async middleware(context, next) {
      if (context.path !== options.path) return next();
      context.respond = false;
      await nodeHandler(context.req, context.res);
    },
    close: handler.close,
  };
}
