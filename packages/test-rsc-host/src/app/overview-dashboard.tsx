'use client';

import { ArrowRightOutlined, CloudServerOutlined, PartitionOutlined } from '@ant-design/icons';
import { Button, Card, Col, Row, Space, Statistic, Tag, Typography } from 'antd';
import Link from 'next/link';

export default function OverviewDashboard({ activeCount }: { activeCount: number }) {
  return (
    <>
      <section className="host-hero">
        <Tag color="cyan">ONE PUBLIC HTTP ENDPOINT · PORT 3200</Tag>
        <Typography.Title>Composable RSC micro-frontends</Typography.Title>
        <Typography.Paragraph>
          The Host owns the document, layout, theme, Flight decoding, browser assets and action gateway.
          Independently compiled plugin services contribute only their remote React trees.
        </Typography.Paragraph>
        <Space size="large" wrap>
          <Statistic title="Active deployments" value={activeCount} />
          <Statistic title="Public endpoints" value={1} />
          <Statistic title="Manual activation" value={0} />
        </Space>
      </section>
      <Row gutter={[16, 16]} className="host-module-grid">
        <Col xs={24} xl={12}>
          <Card className="host-module-card" title="Capability matrix" extra={<CloudServerOutlined />}>
            <Typography.Paragraph>
              Server Components, nested Client Components, Suspense chunks, Ant Design controls and model-backed actions.
            </Typography.Paragraph>
            <Link href="/plugins/demo.rsc.capabilities?label=from-overview&count=3">
              <Button type="primary" icon={<ArrowRightOutlined />}>Open active build</Button>
            </Link>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card className="host-module-card" title="Isolation laboratory" extra={<PartitionOutlined />}>
            <Typography.Paragraph>
              A separate namespace, artifact, client graph, local state and visual theme under the same Host layout.
            </Typography.Paragraph>
            <Link href="/plugins/demo.rsc.isolation?marker=isolated-from-overview">
              <Button icon={<ArrowRightOutlined />}>Inspect isolation</Button>
            </Link>
          </Card>
        </Col>
      </Row>
    </>
  );
}
