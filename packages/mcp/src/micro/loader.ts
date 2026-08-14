import { Loader, type ScannedFile } from '@hile/loader';
import { HileMcpError } from '../errors.js';
import { defineMcpProvider, isMcpCapabilityDefinition } from '../definitions.js';
import type {
  McpPromptDefinition,
  McpProviderDefinition,
  McpResourceConfig,
  McpResourceDefinition,
  McpToolDefinition,
} from '../types.js';

type Capability = McpToolDefinition<any, any> | McpResourceDefinition<McpResourceConfig> | McpPromptDefinition<any, any>;

export class McpLoader extends Loader<Capability> {
  private readonly tools = new Map<string, McpToolDefinition<any, any>>();
  private readonly resources = new Map<string, McpResourceDefinition<McpResourceConfig>>();
  private readonly prompts = new Map<string, McpPromptDefinition<any, any>>();

  constructor(private readonly provider: { id: string; displayName?: string }) {
    super({ suffix: 'mcp', requireDefault: true });
  }

  protected bind(file: ScannedFile, capability: Capability): () => void {
    if (!isMcpCapabilityDefinition(capability)) {
      throw new HileMcpError('INVALID_DEFINITION', `${file.relative} must default export a defineMcp* definition`);
    }
    const target = capability.kind === 'tool' ? this.tools : capability.kind === 'resource' ? this.resources : this.prompts;
    const name = capability.config.name;
    if (target.has(name)) {
      throw new HileMcpError('DUPLICATE_CAPABILITY', `Duplicate ${capability.kind} "${name}" in ${file.relative}`);
    }
    target.set(name, capability as never);
    return () => { target.delete(name); };
  }

  snapshot() {
    return {
      tools: Object.fromEntries(this.tools),
      resources: Object.fromEntries(this.resources),
      prompts: Object.fromEntries(this.prompts),
    };
  }

  async loadProvider(directory: string): Promise<{ provider: McpProviderDefinition; unload(): void }> {
    const unload = await this.load(directory);
    try {
      const provider = defineMcpProvider({ ...this.provider, ...this.snapshot() });
      return { provider, unload };
    } catch (error) {
      unload();
      throw error;
    }
  }
}
