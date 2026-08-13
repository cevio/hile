import type { ReactNode } from 'react';
import { RscDevelopmentReload } from '@hile/rsc-development/client';

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>
    {process.env.NODE_ENV === 'development' ? <RscDevelopmentReload /> : null}
    {children}
  </body></html>;
}
