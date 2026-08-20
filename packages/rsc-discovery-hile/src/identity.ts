export interface ResolveHileRscPluginIdentityOptions {
  pluginId: string;
  buildId: string;
  development: boolean;
  namespace?: string;
  instanceId?: string;
}

export interface HileRscPluginIdentity {
  namespace: string;
  instanceId: string;
}

/** Resolves stable development identity or build-scoped production identity. */
export function resolveHileRscPluginIdentity(
  options: ResolveHileRscPluginIdentityOptions,
): HileRscPluginIdentity {
  const configuredNamespace = options.namespace?.trim() || undefined;
  if (options.development && !configuredNamespace) {
    throw new TypeError('RSC development namespace must not be empty');
  }
  if (!configuredNamespace && (!options.pluginId || !options.buildId)) {
    throw new TypeError('RSC production identity requires pluginId and buildId');
  }
  const namespace = configuredNamespace ?? `${options.pluginId}.${options.buildId}`;
  return {
    namespace,
    instanceId: options.instanceId?.trim() || namespace,
  };
}
