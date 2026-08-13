import type { Metadata } from 'next';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { RscDevelopmentReload } from '@hile/rsc-development/client';
import type { ReactNode } from 'react';
import HostShell from './host-shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hile RSC private demo suite',
  description: 'One public Next endpoint composing internal RSC plugin microservices',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AntdRegistry>
          <HostShell>
            {process.env.NODE_ENV === 'development' ? <RscDevelopmentReload /> : null}
            {children}
          </HostShell>
        </AntdRegistry>
      </body>
    </html>
  );
}
