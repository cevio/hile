'use client';

import {
  ApiOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  PlayCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Alert, Button, Card, Col, Input, Progress, Row, Space, Tag, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';

type Catalog = { tools: string[]; resources: string[]; prompts: string[] };

function textContent(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '');
  const record = value as Record<string, any>;
  if (Array.isArray(record.content)) return record.content.filter(item => item?.type === 'text').map(item => item.text).join('\n');
  if (Array.isArray(record.contents)) return record.contents.map(item => item?.text ?? item?.uri).join('\n');
  if (Array.isArray(record.messages)) return record.messages.map(item => item?.content?.text ?? '').join('\n');
  return JSON.stringify(value, null, 2);
}

export default function McpWorkbench() {
  const clientPromise = useRef<Promise<Client> | undefined>(undefined);
  const [catalog, setCatalog] = useState<Catalog>({ tools: [], resources: [], prompts: [] });
  const [query, setQuery] = useState('desk');
  const [progress, setProgress] = useState(0);
  const [instances, setInstances] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [output, setOutput] = useState('Choose an operation to inspect the protocol result.');
  const [status, setStatus] = useState<'offline' | 'connecting' | 'ready' | 'error'>('offline');
  const [busy, setBusy] = useState('');

  const connect = () => {
    if (clientPromise.current) return clientPromise.current;
    setStatus('connecting');
    clientPromise.current = (async () => {
      const client = new Client({ name: 'test-rsc-browser-workbench', version: '1.0.0' }, {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      });
      client.setRequestHandler('elicitation/create', async request => ({
        action: window.confirm(request.params.message) ? 'accept' : 'decline',
        content: { confirmed: true },
      }));
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin), {
        requestInit: { headers: { Authorization: 'Bearer demo-mcp-token' } },
      }));
      setStatus('ready');
      return client;
    })().catch(error => {
      clientPromise.current = undefined;
      setStatus('error');
      throw error;
    });
    return clientPromise.current;
  };

  useEffect(() => () => { void clientPromise.current?.then(client => client.close()).catch(() => undefined); }, []);

  const run = async (name: string, operation: (client: Client) => Promise<void>) => {
    setBusy(name);
    try {
      await operation(await connect());
    } catch (error) {
      setOutput(error instanceof Error ? error.message : String(error));
      setStatus('error');
    } finally {
      setBusy('');
    }
  };

  const discover = () => run('discover', async client => {
    const [tools, resources, templates, prompts] = await Promise.all([
      client.listTools(), client.listResources(), client.listResourceTemplates(), client.listPrompts(),
    ]);
    setCatalog({
      tools: tools.tools.map(item => item.name),
      resources: [...resources.resources.map(item => item.uri), ...templates.resourceTemplates.map(item => item.uriTemplate)],
      prompts: prompts.prompts.map(item => item.name),
    });
    setOutput(`Discovered ${tools.tools.length} tools, ${resources.resources.length + templates.resourceTemplates.length} resources and ${prompts.prompts.length} prompt.`);
  });

  const searchTwice = () => run('search', async client => {
    setProgress(0);
    const selected: string[] = [];
    for (let index = 0; index < 2; index++) {
      const result = await client.callTool({ name: 'catalog.search_products', arguments: { query, limit: 2 } }, {
        onprogress: event => {
          setProgress(Math.round((event.progress / (event.total ?? 1)) * 100));
          setLogs(current => [...current.slice(-4), `[progress] ${event.message ?? event.progress}`]);
        },
      });
      selected.push(String((result.structuredContent as { instance?: string } | undefined)?.instance ?? '?'));
      setOutput(textContent(result));
    }
    setInstances(selected);
  });

  const readResources = () => run('resources', async client => {
    const [about, product] = await Promise.all([
      client.readResource({ uri: 'demo://catalog/about' }),
      client.readResource({ uri: 'demo://catalog/products/p-100' }),
    ]);
    setOutput(`${textContent(about)}\n\n${textContent(product)}`);
  });

  const getPrompt = () => run('prompt', async client => {
    setOutput(textContent(await client.getPrompt({ name: 'catalog.recommend_products', arguments: { need: 'home office' } })));
  });

  const createOrder = () => run('create', async client => {
    setOutput(textContent(await client.callTool({ name: 'orders.create_order', arguments: { product_id: 'p-100', quantity: 2 } })));
  });

  const confirmOrder = () => run('confirm', async client => {
    setOutput(textContent(await client.callTool({ name: 'orders.confirm_order', arguments: { order_id: 'order-demo' } })));
  });

  return (
    <section className="mcp-workbench" data-testid="mcp-workbench">
      <div className="mcp-workbench-heading">
        <div>
          <Typography.Text className="mcp-kicker">LIVE PROTOCOL CONSOLE · MCP 2026-07-28</Typography.Text>
          <Typography.Title level={2}>Touch every capability.</Typography.Title>
          <Typography.Paragraph>
            These controls use the official browser client against the same <code>/mcp</code> endpoint—no demo-only API proxy.
          </Typography.Paragraph>
        </div>
        <Tag icon={status === 'ready' ? <CheckCircleOutlined /> : <SyncOutlined spin={status === 'connecting'} />} color={status === 'ready' ? 'success' : status === 'error' ? 'error' : 'cyan'}>
          {status.toUpperCase()}
        </Tag>
      </div>

      <Row gutter={[14, 14]}>
        <Col xs={24} lg={10}>
          <Card className="mcp-control-card" title={<><ApiOutlined /> Discovery & execution</>}>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Button type="primary" block icon={<PlayCircleOutlined />} loading={busy === 'discover'} onClick={discover}>Discover capabilities</Button>
              <div className="mcp-query-row">
                <Input aria-label="Catalog query" value={query} onChange={event => setQuery(event.target.value)} />
                <Button icon={<ExperimentOutlined />} loading={busy === 'search'} onClick={searchTwice}>Search twice</Button>
              </div>
              <Progress data-testid="mcp-progress" percent={progress} size="small" strokeColor="#f59e0b" />
              <div className="mcp-stream-log" data-testid="mcp-log">
                <span>STREAM EVENT</span>
                <code>{logs.at(-1) ?? 'waiting for provider notification'}</code>
              </div>
              <div className="mcp-instance-route">
                <span>EXACT-PEER ROUTE</span>
                <strong data-testid="mcp-instance-history">{instances.length ? instances.join(' → ') : 'waiting for two calls'}</strong>
              </div>
              <Space wrap>
                <Button icon={<DatabaseOutlined />} loading={busy === 'resources'} onClick={readResources}>Read resources</Button>
                <Button icon={<FileSearchOutlined />} loading={busy === 'prompt'} onClick={getPrompt}>Generate prompt</Button>
                <Button loading={busy === 'create'} onClick={createOrder}>Create order</Button>
                <Button danger loading={busy === 'confirm'} onClick={confirmOrder}>Confirm order</Button>
              </Space>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card className="mcp-inspector-card" title="Registry projection">
            <div className="mcp-catalog-block"><span>TOOLS</span><Space wrap data-testid="mcp-tools">{catalog.tools.map(item => <Tag key={item}>{item}</Tag>)}</Space></div>
            <div className="mcp-catalog-block"><span>RESOURCES</span><Space wrap>{catalog.resources.map(item => <Tag key={item}>{item}</Tag>)}</Space></div>
            <div className="mcp-catalog-block"><span>PROMPTS</span><Space wrap>{catalog.prompts.map(item => <Tag key={item}>{item}</Tag>)}</Space></div>
            <Alert className="mcp-output" type={status === 'error' ? 'error' : 'info'} showIcon message="Latest protocol result" description={<pre data-testid="mcp-output">{output}</pre>} />
          </Card>
        </Col>
      </Row>
    </section>
  );
}
