import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { McpGateway } from '../gateway/index.js';
import { mcpServerFactory } from '../gateway/gateway.js';

export interface McpStdioOptions extends Omit<ServeStdioOptions, 'onerror'> {
  onError?: (error: Error) => void;
  /** Process-level identity for trusted stdio launches. Required to expose scoped capabilities. */
  authInfo?: AuthInfo;
}

export function serveMcpStdio(gateway: McpGateway, options: McpStdioOptions = {}): StdioServerHandle {
  const { authInfo, onError, ...transportOptions } = options;
  const factory = mcpServerFactory(gateway);
  return serveStdio(context => factory({ ...context, authInfo: authInfo ?? context.authInfo }), {
    ...transportOptions,
    onerror: onError ?? (error => console.error(error)),
  });
}
