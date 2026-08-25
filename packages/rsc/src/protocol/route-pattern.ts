const ROUTE_PARAMETER_SEGMENT = /^\[([A-Za-z][A-Za-z0-9_]*)\]$/;

export function splitRscRoutePath(path: string): string[] {
  return path === '/' ? [] : path.slice(1).split('/');
}

export function rscRouteParameterName(segment: string): string | undefined {
  return ROUTE_PARAMETER_SEGMENT.exec(segment)?.[1];
}
