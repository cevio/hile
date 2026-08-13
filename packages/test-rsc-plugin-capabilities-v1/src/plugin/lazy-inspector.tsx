'use client';

import { Alert, Descriptions } from 'antd';

export default function LazyInspector({ buildId }: { buildId: string }) {
  return (
    <aside className="capability-lazy" data-testid="lazy-inspector">
      <Alert type="success" showIcon title="Lazy client chunk loaded independently" />
      <Descriptions size="small" column={1} items={[
        { key: 'build', label: 'Build', children: buildId },
        { key: 'boundary', label: 'Boundary', children: 'React.lazy + Suspense' },
        { key: 'delivery', label: 'Delivery', children: 'Plugin-owned browser chunk' },
      ]} />
    </aside>
  );
}
