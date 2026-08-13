'use client';

import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Collapse,
  ConfigProvider,
  Row,
  Skeleton,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useReducer,
  useState,
  useTransition,
} from 'react';
import './capabilities.css';

const LazyInspector = lazy(() => import('./lazy-inspector'));
const AccentContext = createContext('violet');

function Counter({ initialCount }: { initialCount: number }) {
  const accent = useContext(AccentContext);
  const [count, increment] = useReducer((value: number) => value + 1, initialCount);
  return (
    <Card size="small" title="Context + reducer" data-accent={accent}>
      <Statistic title="Hydrated reducer value" value={count} styles={{ content: { color: '#6d28d9' } }} />
      <output className="capability-visually-hidden" data-testid="counter-value">{count}</output>
      <Button type="primary" onClick={() => increment()} data-testid="increment-client">Increment in browser</Button>
    </Card>
  );
}

export interface CapabilityPanelProps {
  rsc: { pluginId: string; buildId: string };
  initialCount: number;
  queryLabel: string;
}

function CapabilityWorkspace({ rsc, initialCount, queryLabel }: CapabilityPanelProps) {
  const { message } = AntdApp.useApp();
  const [hydrated, setHydrated] = useState(false);
  const [showLazy, setShowLazy] = useState(false);
  const [actionResult, setActionResult] = useState('not invoked');
  const [isPending, startTransition] = useTransition();

  useEffect(() => setHydrated(true), []);

  async function invokeRemoteAction() {
    const response = await fetch(
      `/_hile/rsc/actions/${encodeURIComponent(rsc.pluginId)}/${encodeURIComponent(rsc.buildId)}/increment`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rsc-demo-token': 'demo-token' },
        body: JSON.stringify({ input: { value: initialCount } }),
      },
    );
    if (!response.ok) throw new Error(`Remote action failed: ${response.status}`);
    const result = await response.json() as { value: number; buildId: string; calls: number };
    setActionResult(`${result.buildId}:${result.value}:call-${result.calls}`);
    void message.success('Model action returned through the Host gateway');
  }

  return (
    <section className="capability-panel" data-testid="capability-client-panel">
      <div className="capability-runtime-line">
        <Badge status={hydrated ? 'success' : 'processing'} text={<span data-testid="hydration-state">{hydrated ? 'hydrated' : 'server-rendered'}</span>} />
        <Space wrap><Tag color="purple">{rsc.buildId}</Tag><Tag>{rsc.pluginId}</Tag></Space>
      </div>
      <Alert showIcon type="info" title="Serialized Server → Client props" description={<span data-testid="query-label">Query label: {queryLabel}</span>} />
      <Row gutter={[14, 14]}>
        <Col xs={24} md={10}><Counter initialCount={initialCount} /></Col>
        <Col xs={24} md={14}>
          <Card size="small" title="Chunk and action controls" className="capability-control-card">
            <Space wrap>
              <Button data-testid="load-lazy" onClick={() => startTransition(() => setShowLazy(true))}>
                {isPending ? 'Loading…' : 'Load lazy client chunk'}
              </Button>
              <Button type="primary" ghost data-testid="invoke-action" onClick={() => void invokeRemoteAction()}>
                Invoke internal plugin action
              </Button>
            </Space>
            <Typography.Paragraph className="capability-result">Result: <Typography.Text code data-testid="action-result">{actionResult}</Typography.Text></Typography.Paragraph>
          </Card>
        </Col>
      </Row>
      {showLazy ? (
        <Suspense fallback={<Card><Skeleton active paragraph={{ rows: 2 }} data-testid="lazy-fallback" /></Card>}>
          <LazyInspector buildId={rsc.buildId} />
        </Suspense>
      ) : null}
      <Collapse size="small" items={[{
        key: 'composition',
        label: 'Why this is still an RSC plugin',
        children: 'The server page stays in the plugin service; only explicitly marked client references and their chunks execute in the browser.',
      }]} />
    </section>
  );
}

export default function CapabilityPanel(props: CapabilityPanelProps) {
  return (
    <AccentContext.Provider value="violet">
      <ConfigProvider theme={{ token: { colorPrimary: '#6d28d9', borderRadius: 5 } }}>
        <AntdApp><CapabilityWorkspace {...props} /></AntdApp>
      </ConfigProvider>
    </AccentContext.Provider>
  );
}
