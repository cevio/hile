import { NextResponse } from 'next/server';
import { getDemoHostComposition } from '../../../../services/runtime-reference';

export const dynamic = 'force-dynamic';

export async function GET() {
  const runtime = getDemoHostComposition();
  return NextResponse.json({ snapshot: runtime.deployments.snapshot() });
}

export async function POST(request: Request) {
  try {
    const value = await request.json() as Record<string, unknown>;
    if (
      typeof value.operation !== 'string'
      || typeof value.pluginId !== 'string'
      || typeof value.buildId !== 'string'
    ) {
      return NextResponse.json({ error: 'operation, pluginId and buildId are required' }, { status: 400 });
    }
    const runtime = getDemoHostComposition();
    const snapshot = runtime.lifecycle.apply(
      value.operation as 'install' | 'activate' | 'deactivate' | 'remove',
      { pluginId: value.pluginId, buildId: value.buildId },
    );
    return NextResponse.json({ snapshot });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 },
    );
  }
}
