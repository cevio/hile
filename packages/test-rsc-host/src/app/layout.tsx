import type { Metadata } from 'next';
import { RscDevelopmentReload } from '@hile/rsc-development/client';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hile RSC private demo suite',
  description: 'One public Next endpoint composing internal RSC plugin microservices',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {process.env.NODE_ENV === 'development' ? <RscDevelopmentReload /> : null}
        <div className="host-shell">
          <nav className="host-nav">
            <a href="/">Overview</a>
            <a href="/plugins/demo.rsc.capabilities?label=from-host&count=3">Capabilities plugin</a>
            <a href="/plugins/demo.rsc.isolation?marker=separate-state">Isolation plugin</a>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
