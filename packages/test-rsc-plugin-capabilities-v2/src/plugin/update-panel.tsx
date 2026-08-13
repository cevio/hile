'use client';

import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  ConfigProvider,
  Descriptions,
  Form,
  InputNumber,
  Modal,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { useActionState, useEffect, useState } from 'react';
import { incrementWithServerFunction } from './actions';
import './update.css';

type RscIdentity = { pluginId: string; buildId: string };

const capabilityRows = [
  { key: 'server', boundary: 'Server Component', owner: 'Plugin microservice', evidence: 'Request metadata in initial Flight' },
  { key: 'client', boundary: "'use client'", owner: 'Browser graph', evidence: 'Form, tabs, modal and local state' },
  { key: 'action', boundary: "'use server'", owner: 'Server Function → @hile/model', evidence: 'Same-origin Host gateway and microservice execution' },
  { key: 'style', boundary: 'Component library', owner: 'Independent artifact', evidence: 'Ant Design bundled per plugin' },
];

function InteractiveWorkspace({ initialValue, rsc }: { initialValue: number; rsc: RscIdentity }) {
  const { notification } = AntdApp.useApp();
  const [hydrated, setHydrated] = useState(false);
  const [inputValue, setInputValue] = useState(initialValue);
  const [modalOpen, setModalOpen] = useState(false);
  const [actionState, formAction, pending] = useActionState(incrementWithServerFunction, {
    buildId: 'v2', value: initialValue, invoked: false,
  });
  const result = actionState.invoked ? `${actionState.buildId}:${actionState.value}` : 'not invoked';

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (!actionState.invoked) return;
    notification.success({
      title: 'Server Function completed',
      description: `Build ${actionState.buildId} model returned ${actionState.value}.`,
      placement: 'bottomRight',
    });
  }, [actionState, notification]);

  return (
    <section className="update-panel" data-testid="update-client-panel">
      <div className="update-status-line">
        <Badge status={hydrated ? 'success' : 'processing'} text={<span data-testid="v2-hydration">{hydrated ? 'hydrated-v2' : 'server-rendered-v2'}</span>} />
        <Space wrap><Tag color="cyan">{rsc.pluginId}</Tag><Tag color="gold">{rsc.buildId}</Tag></Space>
      </div>
      <Tabs
        defaultActiveKey="action"
        items={[
          {
            key: 'action',
            label: 'Server Function',
            children: (
              <Row gutter={[16, 16]}>
                <Col xs={24} lg={15}>
                  <Card title="Same-origin Server Function gateway" className="update-action-card">
                    <Alert type="info" showIcon title="React Server Function crosses the Host gateway, then invokes the plugin's scanned model." />
                    <form action={formAction} className="update-form" data-testid="v2-server-function-form">
                      <Form.Item label="Input value" help="The v2 model adds 100 to this value.">
                        <InputNumber min={-1000} max={1000} value={inputValue} onChange={(value) => setInputValue(value ?? 0)} />
                        <input type="hidden" name="value" value={inputValue} />
                      </Form.Item>
                      <Space wrap>
                        <Button htmlType="submit" type="primary" loading={pending} data-testid="invoke-v2-action">
                          Invoke Server Function
                        </Button>
                        <Button data-testid="open-v2-modal" onClick={() => setModalOpen(true)}>Open client modal</Button>
                      </Space>
                    </form>
                  </Card>
                </Col>
                <Col xs={24} lg={9}>
                  <Card title="Execution result" className="update-result-card">
                    <Statistic title="Model output" value={result} styles={{ content: { fontSize: 22 } }} />
                    <output className="update-result-output" data-testid="v2-action-result">{result}</output>
                    <Progress percent={result === 'not invoked' ? 25 : 100} status={result === 'not invoked' ? 'active' : 'success'} showInfo={false} />
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'matrix',
            label: 'Component matrix',
            children: (
              <div data-testid="component-matrix">
                <Table
                  rowKey="key"
                  pagination={false}
                  size="small"
                  dataSource={capabilityRows}
                  columns={[
                    { title: 'Boundary', dataIndex: 'boundary', key: 'boundary', render: (value) => <Typography.Text strong>{value}</Typography.Text> },
                    { title: 'Runtime owner', dataIndex: 'owner', key: 'owner' },
                    { title: 'Visible evidence', dataIndex: 'evidence', key: 'evidence' },
                  ]}
                  scroll={{ x: 620 }}
                />
              </div>
            ),
          },
          {
            key: 'timeline',
            label: 'Render lifecycle',
            children: <Timeline items={[
              { color: 'green', content: 'Registry resolves and verifies the active immutable build.' },
              { color: 'blue', content: 'Plugin service renders the server graph into a Flight stream.' },
              { color: 'blue', content: 'Host decodes Flight and places the tree inside its outer layout.' },
              { color: hydrated ? 'green' : 'gray', content: 'Browser loads client references and hydrates interactive islands.' },
            ]} />,
          },
        ]}
      />
      <Modal
        open={modalOpen}
        title="Client Component modal"
        closable={false}
        footer={<Button type="primary" onClick={() => setModalOpen(false)}>Close demonstration</Button>}
      >
        <Descriptions column={1} bordered size="small" items={[
          { key: 'plugin', label: 'Plugin', children: rsc.pluginId },
          { key: 'build', label: 'Build', children: rsc.buildId },
          { key: 'state', label: 'Local input', children: inputValue },
        ]} />
        <Typography.Paragraph className="update-modal-note">
          This modal state exists only in the remote plugin client graph; the surrounding navigation remains owned by the Host.
        </Typography.Paragraph>
      </Modal>
    </section>
  );
}

export default function UpdatePanel(props: { initialValue: number; rsc: RscIdentity }) {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#087f5b', borderRadius: 4 } }}>
      <AntdApp><InteractiveWorkspace {...props} /></AntdApp>
    </ConfigProvider>
  );
}
