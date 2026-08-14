import DeploymentControls from './deployment-controls';
import OverviewDashboard from './overview-dashboard';
import McpWorkbench from './mcp-workbench';
import { getDemoHostComposition } from '../services/runtime-reference';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const runtime = getDemoHostComposition();
  const snapshot = runtime.deployments.snapshot();
  return (
    <>
      <OverviewDashboard activeCount={snapshot.length} />
      <McpWorkbench />
      <DeploymentControls initial={snapshot} discovery={runtime.discovery.snapshot()} />
    </>
  );
}
