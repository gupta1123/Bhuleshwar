import { createHmac, timingSafeEqual } from "node:crypto";

function secret() {
  const value = process.env.AGENT_JOB_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error("AGENT_JOB_TOKEN_SECRET is not configured.");
  return value;
}

export function createAgentJobToken(input: { jobId: string; connectionId: string; ownerUserId: string; ttlSeconds?: number }) {
  const payload = Buffer.from(JSON.stringify({
    ...input,
    exp: Math.floor(Date.now() / 1000) + Math.min(Math.max(input.ttlSeconds || 600, 60), 900),
  })).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAgentJobToken(token: string) {
  const [payload, supplied] = token.split(".");
  if (!payload || !supplied) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return decoded as { jobId: string; connectionId: string; ownerUserId: string; exp: number };
}
