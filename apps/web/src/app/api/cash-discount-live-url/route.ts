export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function normalizeApiTarget(value?: string | null) {
  const normalized = value?.trim().replace(/\/+$/, "");
  return normalized?.replace(/\/api$/i, "") || null;
}

export function GET() {
  const target =
    normalizeApiTarget(process.env.API_PROXY_TARGET) ||
    normalizeApiTarget(process.env.NEXT_PUBLIC_API_BASE_URL) ||
    normalizeApiTarget(process.env.NEXT_PUBLIC_BRIDGE_API_BASE_URL);

  if (!target) {
    return Response.json({ error: "The case Tally API URL is not configured." }, { status: 500 });
  }

  const url = new URL(target);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/agent-live";
  url.search = "";
  url.hash = "";

  return Response.json({ url: url.toString() });
}
