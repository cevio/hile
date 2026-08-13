import CapabilityPanel from './capability-panel';
import type { RscRouteProps } from '@hile/rsc/plugin';

type PluginProps = RscRouteProps;

function first(value: string | string[] | undefined, fallback: string): string {
  return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback;
}

export async function CapabilitiesPage({ searchParams, rsc }: PluginProps) {
  await Promise.resolve();
  const queryLabel = first(searchParams.label, 'default-label');
  const count = Number(first(searchParams.count, '2'));
  return (
    <article className="capability-shell" data-testid="plugin-capabilities" data-build="v1">
      <p>Remote React Server Component</p>
      <h1>Capabilities plugin · build v1</h1>
      <p data-testid="server-query">Server received label: {queryLabel}</p>
      <CapabilityPanel
        rsc={rsc}
        initialCount={Number.isSafeInteger(count) ? count : 2}
        queryLabel={queryLabel}
      />
    </article>
  );
}

export function DetailsPage({ params, searchParams }: PluginProps) {
  return (
    <article className="capability-shell" data-testid="plugin-details" data-build="v1">
      <h1>Server-only details route · v1</h1>
      <pre data-testid="details-payload">{JSON.stringify({ params, searchParams }, null, 2)}</pre>
    </article>
  );
}

export async function SlowPage() {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return (
    <article className="capability-shell" data-testid="plugin-slow" data-build="v1">
      <h1>Delayed Flight render completed · v1</h1>
    </article>
  );
}
