import type { McpPrincipal } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeMcpPrincipal(value: unknown): McpPrincipal | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.subject !== 'string' || value.subject.length === 0
    || (value.clientId !== undefined && typeof value.clientId !== 'string')
    || (value.tenantId !== undefined && typeof value.tenantId !== 'string')
    || !Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== 'string')
    || (value.claims !== undefined && !isRecord(value.claims))) {
    throw new TypeError('Invalid MCP principal');
  }
  return Object.freeze({
    ...value,
    scopes: Object.freeze([...value.scopes]),
    claims: value.claims ? Object.freeze({ ...value.claims }) : undefined,
  }) as unknown as McpPrincipal;
}
