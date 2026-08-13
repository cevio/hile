import IsolationWidget from './isolation-widget';

type PluginProps = {
  params?: Record<string, string | string[]>;
  searchParams?: Record<string, string | string[]>;
};

export function IsolationPage({ searchParams = {} }: PluginProps) {
  const marker = String(searchParams.marker ?? 'isolated');
  return (
    <article className="isolation-shell" data-testid="plugin-isolation" data-build="isolation-v1">
      <header className="isolation-header">
        <p>ISOLATED ARTIFACT · INDEPENDENT CLIENT GRAPH</p>
        <h1>Independent plugin namespace</h1>
        <span>This server tree, Ant Design theme, browser state, CSS and microservice are isolated from the capabilities plugin.</span>
      </header>
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
