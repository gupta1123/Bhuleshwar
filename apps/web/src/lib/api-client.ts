"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import {accessCacheEpoch} from '@/lib/access-cache';

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
const USE_CROSS_ORIGIN_API =
  process.env.NEXT_PUBLIC_USE_DIRECT_API_BASE_URL === "true" && API_BASE_URL.length > 0;
const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 30_000;

function isLocalDbMode() {
  return process.env.NEXT_PUBLIC_LOCAL_DB_MODE === "true";
}

let browserClient: ReturnType<typeof createSupabaseBrowserClient> | null = null;
let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let pendingAccessToken: Promise<string | null> | null = null;
let observedAuthUserId: string | null = null;

function clearCachedAccessToken() {
  cachedAccessToken = null;
  pendingAccessToken = null;
}

function getBrowserClient() {
  if (!browserClient) {
    browserClient = createSupabaseBrowserClient();
    browserClient.auth.onAuthStateChange((event,session) => {
      clearCachedAccessToken();
      const userChanged=observedAuthUserId!==(session?.user.id??null);
      observedAuthUserId=session?.user.id??null;
      if (event === 'SIGNED_OUT' || (event === 'SIGNED_IN'&&userChanged) || event === 'USER_UPDATED') {
        queueMicrotask(() => window.dispatchEvent(new Event('kalika-auth-changed')));
      }
    });
  }

  return browserClient;
}

async function readAccessToken() {
  if (isLocalDbMode()) {
    return null;
  }

  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.token;
  }

  if (pendingAccessToken) {
    return pendingAccessToken;
  }

  pendingAccessToken = getBrowserClient()
    .auth.getSession()
    .then(({ data: { session } }) => {
      const token = session?.access_token ?? null;
      const expiresAtSeconds = session?.expires_at;

      if (token && typeof expiresAtSeconds === "number") {
        const expiresAt = expiresAtSeconds * 1000 - ACCESS_TOKEN_EXPIRY_SAFETY_MS;
        if (expiresAt > Date.now()) {
          cachedAccessToken = { token, expiresAt };
        }
      } else {
        cachedAccessToken = null;
      }

      return token;
    })
    .finally(() => {
      pendingAccessToken = null;
    });

  return pendingAccessToken;
}

async function refreshAccessToken() {
  if (isLocalDbMode()) {
    return null;
  }

  clearCachedAccessToken();
  const {
    data: { session },
  } = await getBrowserClient().auth.refreshSession();
  const token = session?.access_token ?? null;
  const expiresAtSeconds = session?.expires_at;

  if (token && typeof expiresAtSeconds === "number") {
    const expiresAt = expiresAtSeconds * 1000 - ACCESS_TOKEN_EXPIRY_SAFETY_MS;
    if (expiresAt > Date.now()) {
      cachedAccessToken = { token, expiresAt };
    }
  }

  return token;
}

export function buildApiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (!USE_CROSS_ORIGIN_API) {
    return normalizedPath;
  }

  return `${API_BASE_URL}${normalizedPath}`;
}

export async function getApiAccessToken() {
  return readAccessToken();
}

async function authenticatedFetch(path: string, init?: RequestInit) {
  // Pin organization before asynchronous token refresh. A retry must not move
  // an old screen's mutation into a newly selected organization.
  const organization=typeof window!=='undefined'?sessionStorage.getItem('kalika-access-organization'):null;
  const accessToken = await readAccessToken();
  const apiUrl = buildApiUrl(path);

  async function sendRequest(token: string | null) {
    const headers = new Headers(init?.headers);
    if (path.startsWith('/api/') && typeof window !== 'undefined' && !headers.has('X-Kalika-Organization')) {
      if (organization) headers.set('X-Kalika-Organization', organization);
    }
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    return fetch(apiUrl, {
      ...init,
      headers,
      credentials: USE_CROSS_ORIGIN_API ? "omit" : (init?.credentials ?? "same-origin"),
    });
  }

  const response = await sendRequest(accessToken);
  if (response.status !== 401) {
    return response;
  }

  const refreshedAccessToken = await refreshAccessToken().catch(() => null);
  if (!refreshedAccessToken || refreshedAccessToken === accessToken) {
    return response;
  }

  return sendRequest(refreshedAccessToken);
}

export async function apiFetch(path: string, init?: RequestInit) {
  const started = performance.now();
  const epoch=accessCacheEpoch();
  const response = await authenticatedFetch(path, init);
  if(epoch!==accessCacheEpoch()){
    void response.body?.cancel().catch(()=>{});
    throw new DOMException('Access context changed; discard the previous response.','AbortError');
  }
  if (typeof window !== 'undefined') {
    if (path === '/api/tally/connections' && (!init?.method || init.method === 'GET') && response.ok) {
      // Reuse status reads already performed by pages; the sidebar need not
      // issue a second request to learn about their refreshed observations.
      void response.clone().json().then(payload => window.dispatchEvent(new CustomEvent('kalika:tally-status-observed', {
        detail: { connections: payload.connections, serverDate: payload.observedAt || response.headers.get('date'), started },
      }))).catch(() => {});
    } else if (response.ok && init?.method && !['GET','HEAD','OPTIONS'].includes(init.method.toUpperCase()) &&
      /^\/api\/tally\/connections\/(?:disconnect-others|[^/]+\/(?:disconnect|pair))$/.test(path)) {
      window.dispatchEvent(new Event('kalika:tally-status-invalidated'));
    }
  }
  return response;
}
