export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProxyRouteContext = {
  params: Promise<{ path?: string[] }>;
};

type ProxyRequestInit = RequestInit & {
  duplex?: "half";
};

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const REQUEST_HEADER_BLOCKLIST = [
  ...HOP_BY_HOP_HEADERS,
  "accept-encoding",
  "content-length",
  "cookie",
  "host",
];

const RESPONSE_HEADER_BLOCKLIST = [
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
];

function normalizeApiTarget(value?: string | null) {
  const normalized = value?.trim().replace(/\/+$/, "");
  if (!normalized) {
    return null;
  }

  return normalized.replace(/\/api$/i, "");
}

function getApiProxyTarget() {
  return normalizeApiTarget(process.env.API_PROXY_TARGET) ||
    normalizeApiTarget(process.env.NEXT_PUBLIC_API_BASE_URL);
}

function getProxyRequestHeaders(request: Request) {
  const headers = new Headers(request.headers);

  for (const header of REQUEST_HEADER_BLOCKLIST) {
    headers.delete(header);
  }

  return headers;
}

function getProxyResponseHeaders(response: Response) {
  const headers = new Headers(response.headers);

  for (const header of RESPONSE_HEADER_BLOCKLIST) {
    headers.delete(header);
  }

  headers.set("X-API-Proxy", "next");
  return headers;
}

async function buildTargetUrl(request: Request, context: ProxyRouteContext) {
  const target = getApiProxyTarget();
  if (!target) {
    return null;
  }

  const { path = [] } = await context.params;
  const sourceUrl = new URL(request.url);
  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/");

  return `${target}/api/${encodedPath}${sourceUrl.search}`;
}

async function proxyToApi(request: Request, context: ProxyRouteContext) {
  const targetUrl = await buildTargetUrl(request, context);

  if (!targetUrl) {
    return Response.json(
      { error: "API proxy target is not configured" },
      { status: 500 }
    );
  }

  const method = request.method.toUpperCase();
  const init: ProxyRequestInit = {
    method,
    headers: getProxyRequestHeaders(request),
    redirect: "manual",
    signal: request.signal,
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const response = await fetch(targetUrl, init);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: getProxyResponseHeaders(response),
    });
  } catch (error) {
    console.error("API proxy request failed:", error);
    return Response.json({ error: "API proxy request failed" }, { status: 502 });
  }
}

export function GET(request: Request, context: ProxyRouteContext) {
  return proxyToApi(request, context);
}

export function POST(request: Request, context: ProxyRouteContext) {
  return proxyToApi(request, context);
}

export function PATCH(request: Request, context: ProxyRouteContext) {
  return proxyToApi(request, context);
}

export function PUT(request: Request, context: ProxyRouteContext) {
  return proxyToApi(request, context);
}

export function DELETE(request: Request, context: ProxyRouteContext) {
  return proxyToApi(request, context);
}

export function OPTIONS(request: Request, context: ProxyRouteContext) {
  return proxyToApi(request, context);
}
