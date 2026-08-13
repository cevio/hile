export type RscHostMiddleware = (context: any, next: () => Promise<unknown>) => unknown;

export interface RscMiddlewareHost<THost = unknown> {
  use(middleware: RscHostMiddleware): THost;
}

export interface RscHostAdapters {
  asset?: RscHostMiddleware;
  action?: RscHostMiddleware;
  serverFunction?: RscHostMiddleware;
  middleware?: RscHostMiddleware[];
}

export function mountRscHostAdapters<THost extends RscMiddlewareHost<THost>>(
  host: THost,
  adapters: RscHostAdapters,
): THost {
  if (adapters.asset) host.use(adapters.asset);
  if (adapters.action) host.use(adapters.action);
  if (adapters.serverFunction) host.use(adapters.serverFunction);
  for (const middleware of adapters.middleware ?? []) host.use(middleware);
  return host;
}
