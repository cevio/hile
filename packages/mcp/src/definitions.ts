import { HileMcpError } from './errors.js';
import { UriTemplate } from '@modelcontextprotocol/server';
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

function validateName(name: string, subject: string): void {
  if (typeof name !== 'string' || !MCP_NAME.test(name)) {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} name must match ${MCP_NAME}`);
  }
}

function frozenConfig<T extends Record<string, any>>(config: T): Readonly<T> {
  const copy: Record<string, any> = { ...config };
  if (copy.annotations) copy.annotations = Object.freeze({ ...copy.annotations });
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
  const scopes = config.access?.scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string' || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)))) {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} scopes must contain valid OAuth scope tokens`);
  }
  if (config.access?.authorize !== undefined && typeof config.access.authorize !== 'function') {
    throw new HileMcpError('INVALID_DEFINITION', `${subject} authorize must be a function`);
  }
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
    try { new UriTemplate((config as McpTemplateResourceConfig).uriTemplate); } catch (cause) {
      throw new HileMcpError('INVALID_DEFINITION', 'Template resource uriTemplate must be a valid RFC 6570 template', { cause });
    }
  } else {
    throw new HileMcpError('INVALID_DEFINITION', 'Resource kind must be static or template');
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
