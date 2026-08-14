import { HileMcpError } from './errors.js';
import { UriTemplate, specTypeSchemas } from '@modelcontextprotocol/server';
import { assertTimerMs } from './limits.js';
import type {
  McpPromptConfig,
  McpPromptDefinition,
  McpProviderConfig,
  McpProviderDefinition,
  McpResourceConfig,
  McpResourceDefinition,
  McpStaticResourceConfig,
  McpTemplateResourceConfig,
  McpToolConfig,
  McpToolDefinition,
} from './types.js';

const MCP_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const definitions = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function clonedFrozen<T>(value: T): T {
  try { return deepFreeze(structuredClone(value)); } catch (cause) {
    throw new HileMcpError('INVALID_DEFINITION', 'MCP metadata must be structured-cloneable', { cause });
  }
}

function validOfficialMetadata(schema: { '~standard': { validate(value: unknown): { issues?: readonly unknown[] } } }, value: unknown) {
  return !schema['~standard'].validate(value).issues;
}

function validateName(name: string, subject: string): void {
  if (typeof name !== 'string' || !MCP_NAME.test(name)) {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} name must match ${MCP_NAME}`);
  }
}

function frozenConfig<T extends Record<string, any>>(config: T): Readonly<T> {
  const copy: Record<string, any> = { ...config };
  if (copy.icons) copy.icons = clonedFrozen(copy.icons);
  if (copy._meta) copy._meta = clonedFrozen(copy._meta);
  if (copy.annotations) copy.annotations = clonedFrozen(copy.annotations);
  if (copy.cacheHint) copy.cacheHint = Object.freeze({ ...copy.cacheHint });
  if (copy.completions) copy.completions = Object.freeze({ ...copy.completions });
  if (copy.execution) copy.execution = Object.freeze({ ...copy.execution });
  if (copy.access) copy.access = Object.freeze({
    ...copy.access,
    scopes: copy.access.scopes ? Object.freeze([...copy.access.scopes]) : undefined,
  });
  return Object.freeze(copy) as Readonly<T>;
}

function validateDefinition(config: Record<string, any>, handler: unknown, subject: string) {
  if (typeof handler !== 'function') throw new HileMcpError('INVALID_DEFINITION', `${subject} handler must be a function`);
  for (const field of ['title', 'description', 'mimeType']) {
    if (config[field] !== undefined && typeof config[field] !== 'string') {
      throw new HileMcpError('INVALID_DEFINITION', `${subject} ${field} must be a string`);
    }
  }
  if (config.access !== undefined && !isRecord(config.access)) {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} access must be an object`);
  }
  const scopes = config.access?.scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string' || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)))) {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} scopes must contain valid OAuth scope tokens`);
  }
  if (config.access?.authorize !== undefined && typeof config.access.authorize !== 'function') {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} authorize must be a function`);
  }
  if (config.icons !== undefined && (!Array.isArray(config.icons)
    || config.icons.some((icon: unknown) => !validOfficialMetadata(specTypeSchemas.Icon, icon)))) {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} icons must follow the MCP Icon schema`);
  }
  if (config._meta !== undefined && (!config._meta || typeof config._meta !== 'object' || Array.isArray(config._meta))) {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} _meta must be an object`);
  }
}

function validateCompletions(completions: unknown, argumentsToComplete: readonly string[], subject: string) {
  if (completions === undefined) return;
  if (!completions || typeof completions !== 'object' || Array.isArray(completions)) {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} completions must be a record`);
  }
  const allowed = new Set(argumentsToComplete);
  for (const [argument, complete] of Object.entries(completions)) {
    if (!allowed.has(argument)) throw new HileMcpError('INVALID_DEFINITION', `${subject} completion argument "${argument}" is not declared`);
    if (typeof complete !== 'function') throw new HileMcpError('INVALID_DEFINITION', `${subject} completion "${argument}" must be a function`);
  }
}

function schemaProperties(schema: any): string[] {
  const value = schema?.['~standard']?.jsonSchema?.input?.({ target: 'draft-2020-12' });
  const properties = value?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties) ? Object.keys(properties) : [];
}

function definition<T extends object>(value: T): T {
  definitions.add(value);
  return Object.freeze(value);
}

export function isMcpCapabilityDefinition(value: unknown): value is McpToolDefinition | McpResourceDefinition | McpPromptDefinition {
  return !!value && typeof value === 'object' && definitions.has(value as object);
}

export function defineMcpTool<Input, Output>(
  config: McpToolConfig<Input, Output>,
  handler: McpToolDefinition<Input, Output>['handler'],
): McpToolDefinition<Input, Output> {
  validateName(config.name, 'Tool');
  validateDefinition(config, handler, 'Tool');
  if (!config.inputSchema) {
    throw new HileMcpError('INVALID_DEFINITION', 'Tool inputSchema is required');
  }
  if (config.execution?.timeoutMs !== undefined) {
    try { assertTimerMs(config.execution.timeoutMs, 'Tool timeoutMs'); } catch (cause) {
      throw new HileMcpError('INVALID_DEFINITION', 'Tool timeoutMs is outside the supported timer range', { cause });
    }
  }
  if (config.annotations !== undefined && !validOfficialMetadata(specTypeSchemas.ToolAnnotations, config.annotations)) {
    throw new HileMcpError('INVALID_DEFINITION', 'Tool annotations must follow the MCP ToolAnnotations schema');
  }
  if (config.execution !== undefined && (!isRecord(config.execution)
    || (config.execution.retry !== undefined && (typeof config.execution.retry !== 'string'
      || !['never', 'idempotent-failover'].includes(config.execution.retry))))) {
    throw new HileMcpError('INVALID_DEFINITION', 'Tool execution must contain a legal retry policy');
  }
  if (config.execution?.retry === 'idempotent-failover'
    && (!config.annotations?.readOnlyHint || !config.annotations?.idempotentHint)) {
    throw new HileMcpError('INVALID_DEFINITION', 'Failover requires a read-only and idempotent tool');
  }
  return definition({ kind: 'tool' as const, config: frozenConfig(config), handler });
}

export function defineMcpResource<Config extends McpResourceConfig>(
  config: Config,
  handler: McpResourceDefinition<Config>['handler'],
): McpResourceDefinition<Config> {
  validateName(config.name, 'Resource');
  validateDefinition(config, handler, 'Resource');
  if (config.kind === 'static') {
    try { new URL((config as McpStaticResourceConfig).uri); } catch (cause) {
      throw new HileMcpError('INVALID_DEFINITION', 'Static resource uri must be an absolute URI', { cause });
    }
  } else if (config.kind === 'template') {
    try {
      const template = new UriTemplate((config as McpTemplateResourceConfig).uriTemplate);
      validateCompletions((config as McpTemplateResourceConfig).completions, template.variableNames, 'Resource');
    } catch (cause) {
      if (cause instanceof HileMcpError) throw cause;
      throw new HileMcpError('INVALID_DEFINITION', 'Template resource uriTemplate must be a valid RFC 6570 template', { cause });
    }
  } else {
    throw new HileMcpError('INVALID_DEFINITION', 'Resource kind must be static or template');
  }
  if (config.size !== undefined && (!Number.isSafeInteger(config.size) || config.size < 0)) {
    throw new HileMcpError('INVALID_DEFINITION', 'Resource size must be a non-negative safe integer');
  }
  if (config.annotations !== undefined && !validOfficialMetadata(specTypeSchemas.Annotations, config.annotations)) {
    throw new HileMcpError('INVALID_DEFINITION', 'Resource annotations must follow the MCP Annotations schema');
  }
  if (config.cacheHint !== undefined && (!isRecord(config.cacheHint)
    || (config.cacheHint.ttlMs !== undefined && (typeof config.cacheHint.ttlMs !== 'number'
      || !Number.isSafeInteger(config.cacheHint.ttlMs) || config.cacheHint.ttlMs < 0))
    || (config.cacheHint.cacheScope !== undefined && (typeof config.cacheHint.cacheScope !== 'string'
      || !['public', 'private'].includes(config.cacheHint.cacheScope))))) {
    throw new HileMcpError('INVALID_DEFINITION', 'Resource cacheHint must contain a non-negative ttlMs and a legal cacheScope');
  }
  return definition({ kind: 'resource' as const, config: frozenConfig(config), handler });
}

export function defineMcpPrompt<Input, Output>(
  config: McpPromptConfig<Input, Output>,
  handler: McpPromptDefinition<Input, Output>['handler'],
): McpPromptDefinition<Input, Output> {
  validateName(config.name, 'Prompt');
  validateDefinition(config, handler, 'Prompt');
  if (!config.argsSchema) {
    throw new HileMcpError('INVALID_DEFINITION', 'Prompt argsSchema is required');
  }
  validateCompletions(config.completions, schemaProperties(config.argsSchema), 'Prompt');
  return definition({ kind: 'prompt' as const, config: frozenConfig(config), handler });
}

function freezeCapabilities<T extends { config: Readonly<{ name: string }> }>(
  providerId: string,
  kind: 'tool' | 'resource' | 'prompt',
  capabilities: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> {
  const copy = { ...capabilities };
  for (const [key, capability] of Object.entries(copy)) {
    if (!isMcpCapabilityDefinition(capability) || capability.kind !== kind) {
      throw new HileMcpError('INVALID_DEFINITION', `${providerId} ${kind} "${key}" must be created with defineMcp*`);
    }
    if (key !== capability.config.name) {
      throw new HileMcpError('INVALID_DEFINITION', `${providerId} ${kind} record key "${key}" must equal capability name "${capability.config.name}"`);
    }
  }
  return Object.freeze(copy);
}

export function defineMcpProvider(config: McpProviderConfig): McpProviderDefinition {
  validateName(config.id, 'Provider');
  if (config.displayName !== undefined && typeof config.displayName !== 'string') {
    throw new HileMcpError('INVALID_DEFINITION', 'Provider displayName must be a string');
  }
  return Object.freeze({
    id: config.id,
    displayName: config.displayName,
    tools: freezeCapabilities(config.id, 'tool', config.tools),
    resources: freezeCapabilities(config.id, 'resource', config.resources),
    prompts: freezeCapabilities(config.id, 'prompt', config.prompts),
  });
}
