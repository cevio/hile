'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Card, Table, Tabs, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';

type Snapshot = {
  pluginId: string;
  buildId: string;
  namespace: string;
  state: string;
  references: number;
};

type DiscoverySnapshot = {
  pluginId: string;
  buildId: string;
  namespace: string;
  instanceId: string;
  priority: number;
  state: string;
  missingReconciliations: number;
};

export default function DeploymentControls({
  initial,
  discovery: initialDiscovery,
}: {
  initial: Snapshot[];
  discovery: DiscoverySnapshot[];
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [discovery, setDiscovery] = useState(initialDiscovery);
  const [error, setError] = useState('');

  useEffect(() => {
    let closed = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/demo/deployments', { cache: 'no-store' });
        const body = await response.json() as {
          snapshot?: Snapshot[];
          discovery?: DiscoverySnapshot[];
          error?: string;
        };
        if (!response.ok || !body.snapshot || !body.discovery) {
          throw new Error(body.error ?? `Registry lifecycle query failed: ${response.status}`);
        }
        if (!closed) {
          setSnapshot(body.snapshot);
          setDiscovery(body.discovery);
          setError('');
        }
      } catch (caught) {
        if (!closed) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    const timer = setInterval(() => void refresh(), 500);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  const discoveryColumns: TableColumnsType<DiscoverySnapshot> = [
    { title: 'Plugin', dataIndex: 'pluginId', key: 'pluginId', render: (value) => <Typography.Text code>{value}</Typography.Text> },
    { title: 'Build', dataIndex: 'buildId', key: 'buildId', render: (value) => <Tag color="cyan">{value}</Tag> },
    { title: 'Namespace', dataIndex: 'namespace', key: 'namespace', responsive: ['lg'] },
    { title: 'Priority', dataIndex: 'priority', key: 'priority', width: 88 },
    { title: 'State', dataIndex: 'state', key: 'state', render: (value) => <Badge status="success" text={value} /> },
  ];
  const deploymentColumns: TableColumnsType<Snapshot> = [
    { title: 'Plugin', dataIndex: 'pluginId', key: 'pluginId', render: (value) => <Typography.Text code>{value}</Typography.Text> },
    { title: 'Build', dataIndex: 'buildId', key: 'buildId', render: (value) => <Tag color="green">{value}</Tag> },
    { title: 'Namespace', dataIndex: 'namespace', key: 'namespace', responsive: ['lg'] },
    { title: 'Leases', dataIndex: 'references', key: 'references', width: 80 },
    { title: 'State', dataIndex: 'state', key: 'state', render: (value) => <Badge status="processing" text={value} /> },
  ];

  return (
    <Card className="host-lifecycle-card" data-testid="deployment-controls" title="Registry-driven lifecycle">
      <Typography.Paragraph>
        Registered and verified plugin microservices become available automatically. Upgrades and removals follow
        Registry state; no separate install or activation command exists.
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon title="Lifecycle refresh failed" description={error} /> : null}
      <Tabs
        items={[
          {
            key: 'discovery',
            label: `Discovery (${discovery.length})`,
            children: (
              <div data-testid="discovery-snapshot">
                <Table rowKey={(row) => `${row.pluginId}:${row.instanceId}`} size="small" pagination={false} dataSource={discovery} columns={discoveryColumns} scroll={{ x: 720 }} />
              </div>
            ),
          },
          {
            key: 'active',
            label: `Active deployments (${snapshot.length})`,
            children: (
              <div data-testid="deployment-snapshot">
                <Table rowKey={(row) => `${row.pluginId}:${row.buildId}`} size="small" pagination={false} dataSource={snapshot} columns={deploymentColumns} scroll={{ x: 680 }} />
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}
