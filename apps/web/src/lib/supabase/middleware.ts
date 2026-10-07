import { createServerClient } from "@supabase/ssr";
import { isAuthApiError, isAuthSessionMissingError } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseFetch } from "./fetch";

function isLocalDbMode() {
  if(process.env.NODE_ENV==='production'&&(process.env.LOCAL_DB_MODE==='true'||process.env.NEXT_PUBLIC_LOCAL_DB_MODE==='true'))throw new Error('Local authentication bypass is forbidden in production.');
  return process.env.LOCAL_DB_MODE === "true" || process.env.NEXT_PUBLIC_LOCAL_DB_MODE === "true";
}

function requireEnv(name: string, value?: string) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const INVALID_SESSION_ERROR_CODES = new Set([
  "bad_jwt",
  "invalid_credentials",
  "no_authorization",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_expired",
  "session_not_found",
  "unexpected_audience",
  "user_not_found",
]);

function isInvalidSessionError(error: unknown) {
  if (isAuthSessionMissingError(error)) {
    return true;
  }

  return (
    isAuthApiError(error) &&
    (error.status === 401 || Boolean(error.code && INVALID_SESSION_ERROR_CODES.has(error.code)))
  );
}

function redirectToLogin(
  request: NextRequest,
  pathname: string,
  options: { clearSession?: boolean; supabaseUrl?: string } = {}
) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  if (pathname !== "/") {
    url.searchParams.set("next", pathname);
  }

  const redirect = NextResponse.redirect(url);

  if (options.clearSession && options.supabaseUrl) {
    const projectRef = new URL(options.supabaseUrl).hostname.split(".")[0];
    const authCookiePrefix = `sb-${projectRef}-auth-token`;

    request.cookies.getAll().forEach(({ name }) => {
      if (name.startsWith(authCookiePrefix)) {
        redirect.cookies.set(name, "", {
          maxAge: 0,
          path: "/",
        });
      }
    });
  }

  return redirect;
}

export async function updateSession(request: NextRequest) {
  if (isLocalDbMode()) {
    return NextResponse.next({
      request,
    });
  }

  const pathname = request.nextUrl.pathname;
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/auth");

  if (isAuthRoute) {
    return NextResponse.next({
      request,
    });
  }

  let response = NextResponse.next({
    request,
  });

  const supabaseUrl = requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL
  );

  const supabase = createServerClient(
    supabaseUrl,
    requireEnv(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ),
    {
      global: {
        fetch: createSupabaseFetch(),
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  let user;

  try {
    // Route navigation only needs a cryptographically verified identity.
    // getClaims() can verify asymmetric JWTs from the cached JWKS instead of
    // making a Supabase Auth network request for every page/RSC prefetch.
    const result = await supabase.auth.getClaims();
    if (result.error) {
      if (isAuthSessionMissingError(result.error)) {
        user = null;
      } else if (isInvalidSessionError(result.error)) {
        console.warn("Discarding an invalid Supabase browser session", {
          code: result.error.code,
          status: result.error.status,
        });
        return redirectToLogin(request, pathname, {
          clearSession: true,
          supabaseUrl,
        });
      } else {
        throw result.error;
      }
    } else {
      user = result.data?.claims ?? null;
    }
  } catch (error) {
    console.error("Supabase auth service could not be reached:", error);

    return new NextResponse(
      "The authentication service is temporarily unreachable. Please refresh in a moment.",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "5",
        },
      }
    );
  }

  if (!user) {
    return redirectToLogin(request, pathname);
  }

  return response;
}
