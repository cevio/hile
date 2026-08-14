import { createHash } from 'node:crypto';
import { UriTemplate, fromJsonSchema } from '@modelcontextprotocol/server';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { HileMcpError } from '../errors.js';
import { MAX_TIMER_MS } from '../limits.js';
import { compareText } from '../ordering.js';
import type { McpProviderDefinition } from '../types.js';
import { MCP_PROVIDER_TOPIC_PREFIX, type McpManifestCapability, type McpProviderManifest } from './types.js';

function jsonSchema(schema: StandardSchemaV1 | undefined, direction: 'input' | 'output') {
  if (!schema) return undefined;
  const converter = (schema['~standard'] as any).jsonSchema?.[direction];
  if (typeof converter !== 'function') {
    throw new TypeError('MCP schemas must implement Standard JSON Schema conversion');
  }
  return converter({ target: 'draft-2020-12' }) as Record<string, unknown>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const MCP_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const compareCapability = (a: { name: string }, b: { name: string }) => compareText(a.name, b.name);

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validCommonCapability(value: unknown) {
  if (!isRecord(value) || typeof value.name !== 'string' || !MCP_NAME.test(value.name)) return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  if (value.mimeType !== undefined && typeof value.mimeType !== 'string') return false;
  if (value.annotations !== undefined && !isRecord(value.annotations)) return false;
  if (value.scopes !== undefined && (!Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== 'string' || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)))) return false;
  return true;
}

function validToolAnnotations(value: unknown) {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.title !== undefined && typeof value.title !== 'string') return false;
  return ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
    .every(key => value[key] === undefined || typeof value[key] === 'boolean');
}

function validCapabilities(value: unknown): value is McpProviderManifest['capabilities'] {
  if (!isRecord(value) || !Array.isArray(value.tools) || !Array.isArray(value.resources) || !Array.isArray(value.prompts)) return false;
  const unique = (items: unknown[]) => new Set(items.map(item => (item as any)?.name)).size === items.length;
  if (![value.tools, value.resources, value.prompts].every(unique)) return false;
  if (!value.tools.every(tool => {
    if (!validCommonCapability(tool) || !validToolAnnotations(tool.annotations) || !isRecord(tool.inputSchema)) return false;
    if (tool.outputSchema !== undefined && !isRecord(tool.outputSchema)) return false;
    if (tool.execution !== undefined) {
      if (!isRecord(tool.execution) || !['never', 'idempotent-failover'].includes(String(tool.execution.retry))) return false;
      if (tool.execution.timeoutMs !== undefined && (!Number.isSafeInteger(tool.execution.timeoutMs) || Number(tool.execution.timeoutMs) <= 0 || Number(tool.execution.timeoutMs) > MAX_TIMER_MS)) return false;
      if (tool.execution.retry === 'idempotent-failover'
        && ((tool.annotations as any)?.readOnlyHint !== true || (tool.annotations as any)?.idempotentHint !== true)) return false;
    }
    try {
      fromJsonSchema(tool.inputSchema);
      if (tool.outputSchema !== undefined) fromJsonSchema(tool.outputSchema);
    } catch { return false; }
    return true;
  })) return false;
  if (!value.prompts.every(prompt => {
    if (!validCommonCapability(prompt) || !isRecord(prompt.inputSchema)) return false;
    try { fromJsonSchema(prompt.inputSchema); return true; } catch { return false; }
  })) return false;
  if (!value.resources.every(resource => {
    if (!validCommonCapability(resource)) return false;
    const hasUri = typeof resource.uri === 'string';
    const hasTemplate = typeof resource.uriTemplate === 'string';
    if (hasUri === hasTemplate) return false;
    try {
      if (hasUri) new URL(resource.uri as string);
      else new UriTemplate(resource.uriTemplate as string);
      return true;
    } catch { return false; }
  })) return false;
  const resourceIdentities = value.resources.map(resource => resource.uri ?? resource.uriTemplate);
  if (new Set(resourceIdentities).size !== resourceIdentities.length) return false;
  return true;
}

export function createMcpProviderFingerprint(identity: {
  providerId: string;
  displayName?: string;
  capabilities: McpProviderManifest['capabilities'];
}) {
  return createHash('sha256').update(stable(identity)).digest('hex');
}

export function parseMcpProviderManifest(value: unknown, topic?: string): McpProviderManifest | undefined {
  if (!isRecord(value) || value.protocol !== 1 || typeof value.providerId !== 'string' || !MCP_NAME.test(value.providerId)
    || typeof value.instanceId !== 'string' || !MCP_NAME.test(value.instanceId)
    || typeof value.namespace !== 'string' || value.namespace.length === 0
    || !isRecord(value.address) || typeof value.address.host !== 'string' || value.address.host.length === 0
    || !Number.isSafeInteger(value.address.port) || Number(value.address.port) < 1 || Number(value.address.port) > 65_535
    || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || (value.displayName !== undefined && typeof value.displayName !== 'string')
    || !validCapabilities(value.capabilities)) return undefined;
  let manifest: McpProviderManifest;
  try { manifest = structuredClone(value) as unknown as McpProviderManifest; } catch { return undefined; }
  if (topic !== undefined && topic !== `${MCP_PROVIDER_TOPIC_PREFIX}${manifest.providerId}/${manifest.instanceId}`) return undefined;
  const expected = createMcpProviderFingerprint({
    providerId: manifest.providerId,
    displayName: manifest.displayName,
    capabilities: manifest.capabilities,
  });
  return expected === manifest.fingerprint ? deepFreeze(manifest) : undefined;
}

export function createMcpProviderManifest(
  provider: McpProviderDefinition,
  runtime: { instanceId: string; namespace: string; address: { host: string; port: number } },
): McpProviderManifest {
  const tools: McpManifestCapability[] = Object.values(provider.tools).map(({ config }) => ({
    name: config.name, title: config.title, description: config.description,
    inputSchema: jsonSchema(config.inputSchema, 'input'),
    outputSchema: jsonSchema(config.outputSchema, 'output'),
    annotations: config.annotations,
    scopes: config.access?.scopes,
    execution: { timeoutMs: config.execution?.timeoutMs, retry: config.execution?.retry ?? 'never' },
  }));
  const resources: McpManifestCapability[] = Object.values(provider.resources).map(({ config }) => ({
    name: config.name, title: config.title, description: config.description,
    uri: config.kind === 'static' ? config.uri : undefined,
    uriTemplate: config.kind === 'template' ? config.uriTemplate : undefined,
    mimeType: config.mimeType, scopes: config.access?.scopes,
  }));
  const prompts: McpManifestCapability[] = Object.values(provider.prompts).map(({ config }) => ({
    name: config.name, title: config.title, description: config.description,
    inputSchema: jsonSchema(config.argsSchema, 'input'), scopes: config.access?.scopes,
  }));
  const capabilities = {
    tools: tools.sort(compareCapability),
    resources: resources.sort(compareCapability),
    prompts: prompts.sort(compareCapability),
  };
  const identity = { providerId: provider.id, displayName: provider.displayName, capabilities };
  const manifest = {
    protocol: 1,
    ...identity,
    instanceId: runtime.instanceId,
    namespace: runtime.namespace,
    address: runtime.address,
    fingerprint: createMcpProviderFingerprint(identity),
  } as McpProviderManifest;
  let transported: unknown;
  try { transported = JSON.parse(JSON.stringify(manifest)); } catch (cause) {
    throw new HileMcpError('INVALID_DEFINITION', 'Provider manifest must be JSON serializable', { cause });
  }
  const parsed = parseMcpProviderManifest(transported);
  if (!parsed) throw new HileMcpError('INVALID_DEFINITION', 'Provider produced an invalid MCP manifest');
  return parsed;
}
