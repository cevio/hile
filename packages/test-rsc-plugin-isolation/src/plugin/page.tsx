import IsolationWidget from './isolation-widget';

type PluginProps = {
  params?: Record<string, string | string[]>;
  searchParams?: Record<string, string | string[]>;
};

export function IsolationPage({ searchParams = {} }: PluginProps) {
  const marker = String(searchParams.marker ?? 'isolated');
  return (
    <article className="isolation-shell" data-testid="plugin-isolation" data-build="isolation-v1">
      <h1>Independent plugin namespace</h1>
      <p>This tree, client graph, CSS and microservice are isolated from the capabilities plugin.</p>
      <IsolationWidget marker={marker} />
    </article>
  );
}

export function InspectPage({ params = {}, searchParams = {} }: PluginProps) {
  return (
    <article className="isolation-shell" data-testid="isolation-inspect">
      <h1>Independent server-only route</h1>
      <pre>{JSON.stringify({ params, searchParams }, null, 2)}</pre>
    </article>
  );
}
