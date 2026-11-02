import { jsonWithCors } from '@/lib/api/cors';
import { GstServiceError } from './service';
import { GstScopeError, resolveGstScope, type GstScope } from './scope';
import { PullBlockedError } from './return-store';
import { SandboxError } from './sandbox-client';

// Shared plumbing for the /api/gst routes: body, scope, and error mapping.
export async function gstRoute(request: Request, run: (scope: GstScope, body: Record<string, unknown>) => Promise<unknown>) {
  try {
    const body: Record<string, unknown> = request.method === 'GET'
      ? Object.fromEntries(new URL(request.url).searchParams)
      : await request.json();
    const scope = await resolveGstScope(request, body);
    return jsonWithCors(request, await run(scope, body));
  } catch (error) {
    if (error instanceof GstScopeError) return jsonWithCors(request, { error: error.message }, { status: error.status });
    if (error instanceof GstServiceError) return jsonWithCors(request, { error: error.message, code: error.code }, { status: error.status });
    if (error instanceof PullBlockedError) return jsonWithCors(request, { error: error.message, code: error.kind, retryAt: error.retryAt }, { status: 429 });
    if (error instanceof SandboxError) return jsonWithCors(request, { error: error.message, code: error.kind, portalCode: error.errorCode || undefined }, { status: 502 });
    return jsonWithCors(request, { error: error instanceof Error ? error.message : 'GST service is unavailable.' }, { status: 400 });
  }
}

export const RETURN_TYPES = ['gstr2a', 'gstr2b', 'gstr3b'] as const;

export function readReturnRequest(body: Record<string, unknown>) {
  const returnType = String(body.returnType || '');
  const period = String(body.period || '');
  if (!(RETURN_TYPES as readonly string[]).includes(returnType)) throw new Error('returnType must be gstr2a, gstr2b or gstr3b.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('period must be YYYY-MM.');
  return { returnType: returnType as (typeof RETURN_TYPES)[number], period };
}
