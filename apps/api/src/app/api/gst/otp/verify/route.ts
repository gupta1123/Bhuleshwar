import { withTeamAccess } from '@/lib/access/route-boundary';
import { optionsWithCors } from '@/lib/api/cors';
import { gstRoute } from '@/lib/gst/route';
import { verifyGstOtp } from '@/lib/gst/service';

export const OPTIONS = optionsWithCors;

async function handler(request: Request) {
  return gstRoute(request, async (scope, body) => {
    const gstin = String(body.gstin || '').trim().toUpperCase();
    const username = String(body.username || '').trim();
    const otp = String(body.otp || '').trim();
    if (!gstin || !username || !/^\d{4,8}$/.test(otp)) throw new Error('Enter the GSTIN, username and the OTP.');
    return verifyGstOtp(scope, { gstin, username, otp });
  });
}
export const POST = withTeamAccess(handler);
