import { describe, expect, it } from 'vitest';
import { hasMcpScopes, MCP_SCOPE_ALL } from './scopes.js';

describe('MCP scope grants', () => {
  it('requires every declared scope for an ordinary principal', () => {
    expect(hasMcpScopes(['orders:read', 'orders:write'], ['orders:read'])).toBe(true);
    expect(hasMcpScopes(['orders:read'], ['orders:read', 'orders:write'])).toBe(false);
  });

  it('grants all discovered scopes only through the explicit wildcard', () => {
    expect(hasMcpScopes([MCP_SCOPE_ALL], ['future-provider:admin'])).toBe(true);
    expect(hasMcpScopes([], ['future-provider:admin'])).toBe(false);
    expect(hasMcpScopes(undefined, [])).toBe(true);
  });
});
