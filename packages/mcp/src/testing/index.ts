import type { McpProviderManifest, McpProviderSnapshotListener, McpProviderSource, McpResourceUpdate, McpResourceUpdateListener } from '../micro/types.js';

export class InMemoryMcpProviderSource implements McpProviderSource {
  private instances: McpProviderManifest[];
  private readonly listeners = new Set<McpProviderSnapshotListener>();
  private readonly resourceUpdateListeners = new Set<McpResourceUpdateListener>();
  readonly invocations: Array<{ instance: McpProviderManifest; operation: string; data: unknown }> = [];

  constructor(
    instances: readonly McpProviderManifest[] = [],
    private readonly handler: (instance: McpProviderManifest, operation: string, data: unknown) => unknown = () => ({ content: [] }),
  ) { this.instances = [...instances]; }

  async start() {}
  snapshot() { return [...this.instances]; }
  subscribe(listener: McpProviderSnapshotListener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  subscribeResourceUpdates(listener: McpResourceUpdateListener) {
    this.resourceUpdateListeners.add(listener);
    return () => { this.resourceUpdateListeners.delete(listener); };
  }
  emitResourceUpdated(update: McpResourceUpdate) {
    for (const listener of this.resourceUpdateListeners) listener(structuredClone(update));
  }
  setInstances(instances: readonly McpProviderManifest[]) {
    this.instances = [...instances];
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
  private async execute<T>(instance: McpProviderManifest, operation: string, data: unknown): Promise<T> {
    this.invocations.push({ instance, operation, data });
    return await this.handler(instance, operation, data) as T;
  }
  async stream(instance: McpProviderManifest, operation: string, data: unknown): Promise<AsyncIterable<unknown>> {
    const result = await this.execute(instance, operation, data);
    return (async function* () { yield { type: 'result', result }; })();
  }
  async close() { this.listeners.clear(); this.resourceUpdateListeners.clear(); }
}
