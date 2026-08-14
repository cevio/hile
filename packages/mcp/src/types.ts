import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type {
  CallToolResult,
  GetPromptResult,
  InputRequiredResult,
  ReadResourceResult,
  ToolAnnotations,
  Variables,
} from '@modelcontextprotocol/server';

export type MaybePromise<T> = T | Promise<T>;
export type McpSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>;

export interface McpPrincipal {
  subject: string;
  clientId?: string;
  tenantId?: string;
  scopes: readonly string[];
  claims?: Readonly<Record<string, unknown>>;
}

export interface McpInvocationDescriptor {
  providerId: string;
  instanceId: string;
  fingerprint: string;
  kind: 'tool' | 'resource' | 'prompt';
  name: string;
  input: unknown;
}

export interface McpInvocationCredentialCodec {
  create(descriptor: McpInvocationDescriptor, principal: McpPrincipal | undefined, signal?: AbortSignal): MaybePromise<unknown>;
  verify(credential: unknown, descriptor: McpInvocationDescriptor, signal?: AbortSignal): MaybePromise<McpPrincipal | undefined>;
}

export interface McpInvocationContext {
  signal: AbortSignal;
  principal?: McpPrincipal;
  inputResponses?: Readonly<Record<string, unknown>>;
  /** Untrusted client round-trip state unless the surrounding application verifies it. */
  requestState?: unknown;
  emit: {
    progress(progress: number, total?: number, message?: string): Promise<void>;
    log(level: 'debug' | 'info' | 'notice' | 'warning' | 'error', data: unknown): Promise<void>;
  };
}

export interface McpCapabilityAccess<Input = unknown> {
  scopes?: readonly string[];
  authorize?: (principal: McpPrincipal | undefined, input: Input) => MaybePromise<boolean>;
}

export interface McpToolExecution {
  timeoutMs?: number;
  retry?: 'never' | 'idempotent-failover';
}

export interface McpToolConfig<Input = unknown, Output = Input> {
  name: string;
  title?: string;
  description?: string;
  inputSchema: McpSchema<Input, Output>;
  outputSchema?: McpSchema;
  annotations?: ToolAnnotations;
  access?: McpCapabilityAccess<Output>;
  execution?: McpToolExecution;
}

export interface McpToolDefinition<Input = unknown, Output = Input> {
  readonly kind: 'tool';
  readonly config: Readonly<McpToolConfig<Input, Output>>;
  readonly handler: (input: Output, context: McpInvocationContext) => MaybePromise<CallToolResult | InputRequiredResult>;
}

export interface McpStaticResourceConfig {
  kind: 'static';
  name: string;
  title?: string;
  description?: string;
  uri: string;
  mimeType?: string;
  access?: McpCapabilityAccess<URL>;
}

export interface McpTemplateResourceConfig {
  kind: 'template';
  name: string;
  title?: string;
  description?: string;
  uriTemplate: string;
  mimeType?: string;
  access?: McpCapabilityAccess<Variables>;
}

export type McpResourceConfig = McpStaticResourceConfig | McpTemplateResourceConfig;
export interface McpResourceDefinition<Config extends McpResourceConfig = McpResourceConfig> {
  readonly kind: 'resource';
  readonly config: Readonly<Config>;
  readonly handler: (
    input: Config extends McpTemplateResourceConfig ? Variables : URL,
    context: McpInvocationContext,
  ) => MaybePromise<ReadResourceResult | InputRequiredResult>;
}

export interface McpPromptConfig<Input = unknown, Output = Input> {
  name: string;
  title?: string;
  description?: string;
  argsSchema: McpSchema<Input, Output>;
  access?: McpCapabilityAccess<Output>;
}

export interface McpPromptDefinition<Input = unknown, Output = Input> {
  readonly kind: 'prompt';
  readonly config: Readonly<McpPromptConfig<Input, Output>>;
  readonly handler: (input: Output, context: McpInvocationContext) => MaybePromise<GetPromptResult | InputRequiredResult>;
}

export interface McpProviderConfig {
  id: string;
  displayName?: string;
  tools?: Readonly<Record<string, McpToolDefinition<any, any>>>;
  resources?: Readonly<Record<string, McpResourceDefinition<McpResourceConfig>>>;
  prompts?: Readonly<Record<string, McpPromptDefinition<any, any>>>;
}

export interface McpProviderDefinition {
  readonly id: string;
  readonly displayName?: string;
  readonly tools: Readonly<Record<string, McpToolDefinition<any, any>>>;
  readonly resources: Readonly<Record<string, McpResourceDefinition<McpResourceConfig>>>;
  readonly prompts: Readonly<Record<string, McpPromptDefinition<any, any>>>;
}
