import { loadService } from '@hile/core';
import { listActiveRscPlugins } from '@hile/rsc/host/plugin-metadata';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { RscDevelopmentReload } from '@hile/rsc-development/client';
import runtimeService from '../services/runtime.boot';

export const dynamic = 'force-dynamic';

export default async function Layout({ children }: { children: ReactNode }) {
  const composition = await loadService(runtimeService);
  const plugins = listActiveRscPlugins(composition.deployments, composition.artifacts);
  const navigation = plugins.flatMap((plugin) =>
    (plugin.metadata?.navigation ?? []).map((item) => ({ plugin, item })))
    .sort((left, right) =>
      (left.item.order ?? 0) - (right.item.order ?? 0)
      || left.plugin.pluginId.localeCompare(right.plugin.pluginId)
      || left.item.id.localeCompare(right.item.id));

  return <html lang="en"><body>
    {process.env.NODE_ENV === 'development' ? <RscDevelopmentReload /> : null}
    <header>
      <Link href="/">Hile RSC</Link>
      <nav aria-label="Plugin navigation">
        {navigation.map(({ plugin, item }) => (
          <Link
            key={`${plugin.pluginId}:${item.id}`}
            href={`/plugins/${encodeURIComponent(plugin.pluginId)}${item.path === '/' ? '' : item.path}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
    <main>{children}</main>
  </body></html>;
}
