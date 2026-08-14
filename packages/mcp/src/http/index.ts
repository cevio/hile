import {
  createMcpHandler,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  originValidationResponse,
  requireBearerAuth,
  type AuthMetadataOptions,
  type AuthInfo,
  type OAuthTokenVerifier,
  type PerRequestResponseMode,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpGateway } from '../gateway/index.js';
import { mcpServerFactory, subscribeMcpGatewayChanges } from '../gateway/gateway.js';
import { assertTimerMs } from '../limits.js';

export interface McpHttpEndpointOptions {
  path: `/${string}`;
  security: {
    allowedHostnames: readonly string[];
    allowedOriginHostnames: readonly string[];
    authentication:
      | { mode: 'public' }
      | { mode: 'required'; authenticate(request: Request): AuthInfo | Response | Promise<AuthInfo | Response> }
      | {
        mode: 'oauth';
        verifier: OAuthTokenVerifier;
        requiredScopes?: readonly string[];
        metadata: AuthMetadataOptions;
      };
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
  if (!security.authentication || !['public', 'required', 'oauth'].includes(security.authentication.mode)
    || (security.authentication.mode === 'required' && typeof security.authentication.authenticate !== 'function')) {
    throw new TypeError('MCP HTTP authentication mode must be explicit');
  }
  if (security.authentication.mode === 'oauth') {
    if (typeof security.authentication.verifier?.verifyAccessToken !== 'function' || !security.authentication.metadata) {
      throw new TypeError('MCP OAuth verifier and metadata must be provided');
    }
    if (security.authentication.metadata.resourceServerUrl.pathname !== options.path) {
      throw new TypeError('MCP OAuth resourceServerUrl path must match the endpoint path');
    }
    if (security.authentication.requiredScopes !== undefined
      && (!Array.isArray(security.authentication.requiredScopes)
        || security.authentication.requiredScopes.some(scope => typeof scope !== 'string' || !scope))) {
      throw new TypeError('MCP OAuth requiredScopes must contain non-empty strings');
    }
  }
  if (options.legacy !== undefined && !['stateless', 'reject'].includes(options.legacy)) throw new TypeError('Invalid MCP legacy mode');
  if (options.onError !== undefined && typeof options.onError !== 'function') throw new TypeError('MCP HTTP onError must be a function');
  if (options.keepAliveMs !== undefined) assertTimerMs(options.keepAliveMs, 'MCP keepAliveMs');
  if (options.maxSubscriptions !== undefined && (!Number.isSafeInteger(options.maxSubscriptions) || options.maxSubscriptions <= 0)) {
    throw new TypeError('MCP maxSubscriptions must be a positive integer');
  }
  const allowedHostnames = [...security.allowedHostnames];
  const allowedOriginHostnames = [...security.allowedOriginHostnames];
  const authenticationMode = security.authentication.mode;
  const authenticateRequired = security.authentication.mode === 'required'
    ? security.authentication.authenticate
    : undefined;
  const oauth = security.authentication.mode === 'oauth' ? security.authentication : undefined;
  const oauthMetadata: AuthMetadataOptions | undefined = oauth ? Object.freeze({
    ...oauth.metadata,
    resourceServerUrl: new URL(oauth.metadata.resourceServerUrl),
    serviceDocumentationUrl: oauth.metadata.serviceDocumentationUrl ? new URL(oauth.metadata.serviceDocumentationUrl) : undefined,
    oauthMetadata: structuredClone(oauth.metadata.oauthMetadata),
    scopesSupported: oauth.metadata.scopesSupported ? [...oauth.metadata.scopesSupported] : undefined,
  }) : undefined;
  if (oauthMetadata) buildOAuthProtectedResourceMetadata(oauthMetadata);
  const oauthResourcePath = oauthMetadata ? new URL(getOAuthProtectedResourceMetadataUrl(oauthMetadata.resourceServerUrl)).pathname : undefined;
  const authenticateOAuth = oauth ? requireBearerAuth({
    verifier: oauth.verifier,
    requiredScopes: oauth.requiredScopes ? [...oauth.requiredScopes] : undefined,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oauthMetadata!.resourceServerUrl),
  }) : undefined;
  const handler = createMcpHandler(mcpServerFactory(gateway), {
    legacy: options.legacy,
    responseMode: options.responseMode,
    keepAliveMs: options.keepAliveMs,
    maxSubscriptions: options.maxSubscriptions,
    onerror: options.onError,
  });
  const unsubscribe = subscribeMcpGatewayChanges(gateway, change => {
    if (change.tools) handler.notify.toolsChanged();
    if (change.resources) handler.notify.resourcesChanged();
    if (change.prompts) handler.notify.promptsChanged();
    for (const uri of change.resourceUpdates) handler.notify.resourceUpdated(uri);
  });
  const secured = {
    async fetch(request: Request) {
      const rejection = hostHeaderValidationResponse(request, allowedHostnames)
        ?? originValidationResponse(request, allowedOriginHostnames);
      if (rejection) return rejection;
      const metadata = oauthMetadata ? oauthMetadataResponse(request, oauthMetadata) : undefined;
      if (metadata) return metadata;
      const authenticated = authenticationMode === 'required' ? await authenticateRequired!(request)
        : authenticationMode === 'oauth' ? await authenticateOAuth!(request) : undefined;
      if (authenticated instanceof Response) return authenticated;
      return handler.fetch(request, { authInfo: authenticated });
    },
  };
  const nodeHandler = toNodeHandler(secured, { onerror: options.onError });
  let unsubscribePending = true;
  let handlerClosePending = true;
  let closing: Promise<void> | undefined;
  const close = async () => {
    const errors: unknown[] = [];
    if (unsubscribePending) {
      try { unsubscribe(); unsubscribePending = false; } catch (error) { errors.push(error); }
    }
    if (handlerClosePending) {
      try { await handler.close(); handlerClosePending = false; } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to close MCP HTTP endpoint');
  };
  return {
    async middleware(context, next) {
      if (context.path !== options.path && context.path !== oauthResourcePath
        && !(oauth && context.path === '/.well-known/oauth-authorization-server')) return next();
      context.respond = false;
      await nodeHandler(context.req, context.res);
    },
    close() {
      if (!closing) closing = close().finally(() => { closing = undefined; });
      return closing;
    },
  };
}
