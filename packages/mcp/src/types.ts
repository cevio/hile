import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type {
  Annotations,
  CacheHint,
  CallToolResult,
  GetPromptResult,
  Icon,
  InputRequiredResult,
  ReadResourceResult,
  ToolAnnotations,
  Variables,
} from '@modelcontextprotocol/server';
import type { ExecutionContext } from '@hile/context';

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
  executionContext: ExecutionContext;
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
  executionContext: ExecutionContext;
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
  authorize?: (
    principal: McpPrincipal | undefined,
    input: Input,
    executionContext: ExecutionContext,
  ) => MaybePromise<boolean>;
}

export interface McpToolExecution {
  timeoutMs?: number;
  retry?: 'never' | 'idempotent-failover';
}

export interface McpCapabilityMetadata {
  title?: string;
  description?: string;
  icons?: readonly Icon[];
  _meta?: Readonly<Record<string, unknown>>;
}

export interface McpCompletionContext {
  executionContext: ExecutionContext;
  signal: AbortSignal;
  principal?: McpPrincipal;
  arguments?: Readonly<Record<string, string>>;
}

export type McpCompletionHandler = (
  value: string,
  context: McpCompletionContext,
) => MaybePromise<readonly string[]>;

export interface McpCompletions {
  completions?: Readonly<Record<string, McpCompletionHandler>>;
}

export interface McpToolConfig<Input = unknown, Output = Input> extends McpCapabilityMetadata {
  name: string;
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

export interface McpResourceMetadata extends McpCapabilityMetadata {
  mimeType?: string;
  size?: number;
  annotations?: Annotations;
  cacheHint?: CacheHint;
}

export interface McpStaticResourceConfig extends McpResourceMetadata {
  kind: 'static';
  name: string;
  uri: string;
  access?: McpCapabilityAccess<URL>;
}

export interface McpTemplateResourceConfig extends McpResourceMetadata, McpCompletions {
  kind: 'template';
  name: string;
  uriTemplate: string;
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

export interface McpPromptConfig<Input = unknown, Output = Input> extends McpCapabilityMetadata, McpCompletions {
  name: string;
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
