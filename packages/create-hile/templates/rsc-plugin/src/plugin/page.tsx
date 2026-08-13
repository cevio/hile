import InteractiveBoundary from './interactive';
import type { RscRouteProps } from '@hile/rsc/plugin';

export default function PluginPage({ rsc }: RscRouteProps) {
  return (
    <section data-rsc-plugin>
      <h1>Independent RSC plugin</h1>
      <InteractiveBoundary initialValue={0} buildId={rsc.buildId} />
    </section>
  );
}
