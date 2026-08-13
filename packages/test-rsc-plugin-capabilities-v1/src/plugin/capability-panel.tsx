'use client';

import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useReducer,
  useState,
  useTransition,
} from 'react';
import './capabilities.css';

const LazyInspector = lazy(() => import('./lazy-inspector'));
const AccentContext = createContext('violet');

function Counter({ initialCount }: { initialCount: number }) {
  const accent = useContext(AccentContext);
  const inputId = useId();
  const [count, increment] = useReducer((value: number) => value + 1, initialCount);
  return (
    <div className="capability-counter" data-accent={accent}>
      <label htmlFor={inputId}>Hydrated reducer value</label>
      <output id={inputId} data-testid="counter-value">{count}</output>
      <button type="button" onClick={increment} data-testid="increment-client">
        Increment in browser
      </button>
    </div>
  );
}

export interface CapabilityPanelProps {
  rsc: {
    pluginId: string;
    buildId: string;
  };
  initialCount: number;
  queryLabel: string;
}

export default function CapabilityPanel({ rsc, initialCount, queryLabel }: CapabilityPanelProps) {
  const [hydrated, setHydrated] = useState(false);
  const [showLazy, setShowLazy] = useState(false);
  const [actionResult, setActionResult] = useState('not invoked');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setHydrated(true);
  }, []);

  async function invokeRemoteAction() {
    const response = await fetch(
      `/_hile/rsc/actions/${encodeURIComponent(rsc.pluginId)}/${encodeURIComponent(rsc.buildId)}/increment`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rsc-demo-token': 'demo-token',
        },
        body: JSON.stringify({ input: { value: initialCount } }),
      },
    );
    if (!response.ok) throw new Error(`Remote action failed: ${response.status}`);
    const result = await response.json() as { value: number; buildId: string; calls: number };
    setActionResult(`${result.buildId}:${result.value}:call-${result.calls}`);
  }

  return (
    <AccentContext.Provider value="violet">
      <section className="capability-panel" data-testid="capability-client-panel">
        <p data-testid="hydration-state">{hydrated ? 'hydrated' : 'server-rendered'}</p>
        <p data-testid="query-label">Serialized query: {queryLabel}</p>
        <Counter initialCount={initialCount} />
        <div className="capability-actions">
          <button
            type="button"
            data-testid="load-lazy"
            onClick={() => startTransition(() => setShowLazy(true))}
          >
            {isPending ? 'Loading…' : 'Load lazy client chunk'}
          </button>
          <button type="button" data-testid="invoke-action" onClick={invokeRemoteAction}>
            Invoke internal plugin action
          </button>
        </div>
        <output data-testid="action-result">{actionResult}</output>
        {showLazy ? (
          <Suspense fallback={<span data-testid="lazy-fallback">Loading chunk…</span>}>
            <LazyInspector buildId={rsc.buildId} />
          </Suspense>
        ) : null}
      </section>
    </AccentContext.Provider>
  );
}
