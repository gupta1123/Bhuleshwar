import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute } from '@/lib/gst/route';
import { gstDefaults, sendGstOtp } from '@/lib/gst/service';

export const OPTIONS = optionsWithCors;

async function handler(request: Request) {
  return gstRoute(request, async (scope, body) => {
    const defaults = gstDefaults();
    const gstin = String(body.gstin || defaults?.gstin || '').trim().toUpperCase();
    const username = String(body.username || defaults?.username || '').trim();
    if (!/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(gstin) || !username) throw new Error('Enter the GSTIN and the GST portal username.');
    await sendGstOtp(scope, { gstin, username });
    return { sent: true };
  });
}
export const POST = withTeamAccess(handler);
