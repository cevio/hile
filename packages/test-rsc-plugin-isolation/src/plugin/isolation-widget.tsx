'use client';

import {
  Alert,
  Badge,
  Card,
  Col,
  ConfigProvider,
  Descriptions,
  Input,
  Row,
  Segmented,
  Slider,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useId, useMemo, useState } from 'react';
import './isolation.css';

export default function IsolationWidget({ marker }: { marker: string }) {
  const id = useId();
  const [value, setValue] = useState(marker);
  const [mode, setMode] = useState<string>('Local state');
  const [density, setDensity] = useState(56);
  const [enabled, setEnabled] = useState(true);
  const fingerprint = useMemo(() => `${value.length}-${mode.toLowerCase().replace(' ', '-')}`, [value, mode]);

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#c2410c', colorInfo: '#c2410c', borderRadius: 2 } }}>
      <section className="isolation-widget" data-testid="isolation-client">
        <Alert
          showIcon
          type="warning"
          title="No client state crosses the plugin boundary"
          description="Edit the controls below, then navigate to another plugin. Its client graph remains unaffected."
        />
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={15}>
            <Card title="Independent state controls" extra={<Badge status={enabled ? 'success' : 'default'} text={enabled ? 'active' : 'paused'} />}>
              <Space orientation="vertical" size="large" className="isolation-controls">
                <label htmlFor={id}>Independent client state</label>
                <Input id={id} value={value} disabled={!enabled} onChange={(event) => setValue(event.target.value)} />
                <div>
                  <Typography.Text type="secondary">State strategy</Typography.Text>
                  <Segmented block value={mode} options={['Local state', 'Reducer', 'External store']} onChange={setMode} />
                </div>
                <div>
                  <Typography.Text type="secondary">Visual density: {density}%</Typography.Text>
                  <Slider min={20} max={100} value={density} onChange={setDensity} />
                </div>
                <Space><Switch checked={enabled} onChange={setEnabled} /><span>Client island enabled</span></Space>
              </Space>
            </Card>
          </Col>
          <Col xs={24} lg={9}>
            <Card title="Boundary probe" className="isolation-probe">
              <Tag color="volcano">demo.rsc.isolation</Tag>
              <Typography.Title level={4} data-testid="isolation-value">{value}</Typography.Title>
              <Descriptions column={1} size="small" items={[
                { key: 'marker', label: 'Server seed', children: marker },
                { key: 'mode', label: 'Client mode', children: mode },
                { key: 'fingerprint', label: 'Fingerprint', children: fingerprint },
              ]} />
            </Card>
          </Col>
        </Row>
      </section>
    </ConfigProvider>
  );
}
