import type { Metadata } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { listActiveRscPlugins } from '@hile/rsc/host/plugin-metadata';
import { RscDevelopmentReload } from '@hile/rsc-development/client';
import type { ReactNode } from 'react';
import { getDemoHostComposition } from '../services/runtime-reference';
import HostShell, { type HostNavigationItem } from './host-shell';
import './globals.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Hile RSC private demo suite',
  description: 'One public Next endpoint composing internal RSC plugin microservices',
};

export default async function Layout({ children }: { children: ReactNode }) {
  const composition = getDemoHostComposition();
  const plugins = listActiveRscPlugins(composition.deployments, composition.artifacts);
  const navigation: HostNavigationItem[] = plugins
    .flatMap((plugin) => (plugin.metadata?.navigation ?? []).map((item) => ({
      pluginId: plugin.pluginId,
      id: item.id,
      label: item.label,
      path: item.path,
      order: item.order ?? Number.MAX_SAFE_INTEGER,
    })))
    .sort((left, right) => left.order - right.order
      || left.pluginId.localeCompare(right.pluginId)
      || left.id.localeCompare(right.id))
    .map((item) => {
      const pluginRoot = `/plugins/${encodeURIComponent(item.pluginId)}`;
      const href = item.path === '/' ? pluginRoot : `${pluginRoot}${item.path}`;
      return {
        key: href,
        label: item.label,
        href,
      };
    });

  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <HostShell navigation={navigation}>
            {process.env.NODE_ENV === 'development' ? <RscDevelopmentReload /> : null}
            {children}
          </HostShell>
        </AntdRegistry>
      </body>
    </html>
  );
}
