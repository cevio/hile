/** Explicitly grants a principal every current and future discovered MCP capability scope. */
export const MCP_SCOPE_ALL = '*';

export function hasMcpScopes(granted: readonly string[] | undefined, required: readonly string[] | undefined) {
  if (!required?.length) return true;
  const scopes = new Set(granted ?? []);
  return scopes.has(MCP_SCOPE_ALL) || required.every(scope => scopes.has(scope));
}
