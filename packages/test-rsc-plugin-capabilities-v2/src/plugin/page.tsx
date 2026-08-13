import UpdatePanel from './update-panel';
import type { RscRouteProps } from '@hile/rsc/plugin';

type PluginProps = RscRouteProps;

export async function CapabilitiesPage({ searchParams, rsc }: PluginProps) {
  await Promise.resolve();
  return (
    <article className="capability-v2" data-testid="plugin-capabilities" data-build="v2">
      <p>Remote React Server Component switched at runtime</p>
      <h1>Capabilities plugin · build v2</h1>
      <p data-testid="server-query">Server received label: {String(searchParams.label ?? 'default-label')}</p>
      <UpdatePanel initialValue={10} rsc={rsc} />
    </article>
  );
}

export function DetailsPage({ params, searchParams }: PluginProps) {
  return (
    <article className="capability-v2" data-testid="plugin-details" data-build="v2">
      <h1>Server-only details route · v2</h1>
      <pre>{JSON.stringify({ params, searchParams }, null, 2)}</pre>
    </article>
  );
}

export async function SlowPage() {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return <article className="capability-v2" data-testid="plugin-slow" data-build="v2">Delayed v2 render</article>;
}
