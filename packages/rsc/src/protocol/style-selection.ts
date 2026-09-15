export interface RscSelectableStyle {
  path: string;
  scope?: 'plugin' | 'client';
}

export interface RscStyleSelectionClient {
  styles?: readonly string[];
}

/** Selects plugin-wide and reachable client CSS, preserving legacy all-style behavior. */
export function selectRscClientStyles<TStyle extends RscSelectableStyle>(
  styles: readonly TStyle[],
  clients: readonly RscStyleSelectionClient[],
): TStyle[] | undefined {
  if (clients.some((client) => client.styles === undefined)) return [...styles];
  const requested = new Set([
    ...styles.filter(({ scope }) => scope !== 'client').map(({ path }) => path),
    ...clients.flatMap(({ styles: paths }) => paths ?? []),
  ]);
  const selected = styles.filter(({ path }) => requested.has(path));
  return selected.length === requested.size ? selected : undefined;
}
