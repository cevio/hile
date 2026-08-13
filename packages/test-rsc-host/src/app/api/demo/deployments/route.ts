import { NextResponse } from 'next/server';
import { getDemoHostComposition } from '../../../../services/runtime-reference';

export const dynamic = 'force-dynamic';

export async function GET() {
  const runtime = getDemoHostComposition();
  return NextResponse.json({
    snapshot: runtime.deployments.snapshot(),
    discovery: runtime.discovery.snapshot(),
  });
}
