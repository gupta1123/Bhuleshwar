import { createClient } from "@supabase/supabase-js";

import { isLocalDbMode, LOCAL_USER_ID } from "@/lib/local/mode";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type RequestUser = { id: string };

const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_EXPIRY_SAFETY_MS = 15_000;

let tokenValidationClient: ReturnType<typeof createClient> | null = null;
const bearerUserCache = new Map<string, { user: RequestUser; expiresAt: number }>();
const pendingBearerValidations = new Map<string, Promise<RequestUser | null>>();

function requireEnv(name: string, value?: string) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createTokenValidationClient() {
  if (tokenValidationClient) {
    return tokenValidationClient;
  }

  tokenValidationClient = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    requireEnv(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );

  return tokenValidationClient;
}

function getTokenCacheExpiry(expClaim: unknown) {
  const maxExpiry = Date.now() + AUTH_CACHE_TTL_MS;

  if (typeof expClaim !== "number" || !Number.isFinite(expClaim)) {
    return maxExpiry;
  }

  return Math.min(maxExpiry, expClaim * 1000 - AUTH_EXPIRY_SAFETY_MS);
}

async function validateBearerToken(token: string): Promise<RequestUser | null> {
  if (token.split(".").length !== 3) {
    return null;
  }

  const supabase = createTokenValidationClient();
  const { data, error } = await supabase.auth.getClaims(token).catch(() => ({
    data: null,
    error: new Error("Bearer token validation failed"),
  }));

  if (error || !data || typeof data.claims.sub !== "string" || !data.claims.sub) {
    return null;
  }

  const user = { id: data.claims.sub };
  const expiresAt = getTokenCacheExpiry(data.claims.exp);
  if (expiresAt > Date.now()) {
    bearerUserCache.set(token, { user, expiresAt });
  }

  return user;
}

function getCachedBearerUser(token: string) {
  const cached = bearerUserCache.get(token);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    bearerUserCache.delete(token);
    return null;
  }

  return cached.user;
}

function getBearerValidation(token: string) {
  const pending = pendingBearerValidations.get(token);
  if (pending) {
    return pending;
  }

  const validation = validateBearerToken(token).finally(() => {
    pendingBearerValidations.delete(token);
  });
  pendingBearerValidations.set(token, validation);
  return validation;
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

async function resolveUserFromBearer(request: Request): Promise<RequestUser | null> {
  const token = getBearerToken(request);
  if (!token) {
    return null;
  }

  const cachedUser = getCachedBearerUser(token);
  if (cachedUser) {
    return cachedUser;
  }

  return getBearerValidation(token);
}

async function resolveUserFromCookies(): Promise<RequestUser | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user ? { id: user.id } : null;
}

const requestUsers = new WeakMap<Request, Promise<RequestUser | null>>();
export function requireRequestUser(request: Request): Promise<RequestUser | null> {
  let pending = requestUsers.get(request);
  if (!pending) { pending = resolveRequestUser(request); requestUsers.set(request, pending); }
  return pending;
}

async function resolveRequestUser(request: Request): Promise<RequestUser | null> {
  if (isLocalDbMode()) {
    return { id: LOCAL_USER_ID };
  }

  const bearerUser = await resolveUserFromBearer(request);
  if (bearerUser) {
    return bearerUser;
  }

  return resolveUserFromCookies();
}
