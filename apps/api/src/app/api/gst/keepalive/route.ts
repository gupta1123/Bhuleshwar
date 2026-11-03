import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { keepGstSessionsAlive } from '@/lib/gst/service';

export const dynamic = 'force-dynamic';

function authorized(request: Request) {
  const expected = process.env.GST_KEEPALIVE_SECRET;
  const given = request.headers.get('x-keepalive-secret') || '';
  if (!expected || expected.length < 24) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Called by Supabase pg_cron every few hours. Refreshes GST tokens before they lapse.
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, results: await keepGstSessionsAlive() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'keep-alive failed' }, { status: 500 });
  }
}
