import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret, TALLY_CONNECTION_SELECT, type TallyConnectionRow } from "@/lib/tally/connections";

const MODEL = "openai/text-embedding-3-small";
const DIMENSIONS = 512;
const MAX_INPUTS = 256;
const MAX_INPUT_LENGTH = 1_000;

function bridgeToken(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ??
    request.headers.get("x-bridge-token") ??
    "";
}

async function isAuthorized(connectionId: string, token: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("tally_connections")
    .select(TALLY_CONNECTION_SELECT)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw error;
  const connection = data as unknown as TallyConnectionRow | null;
  return Boolean(
    connection &&
    !connection.revoked_at &&
    connection.bridge_token_hash &&
    hashSecret(token) === connection.bridge_token_hash
  );
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
    const token = bridgeToken(request);
    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }
    if (!(await isAuthorized(connectionId, token))) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const inputs = Array.isArray(body.inputs)
      ? body.inputs.map((value: unknown) => typeof value === "string" ? value.trim() : "")
      : [];
    if (
      !inputs.length ||
      inputs.length > MAX_INPUTS ||
      inputs.some((value: string) => !value || value.length > MAX_INPUT_LENGTH)
    ) {
      return jsonWithCors(
        request,
        { error: `Provide 1-${MAX_INPUTS} non-empty inputs of at most ${MAX_INPUT_LENGTH} characters.` },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return jsonWithCors(request, { error: "Semantic search is not configured on the server." }, { status: 503 });
    }
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://kalika.local",
        "X-Title": "Kalika Tally Connector",
      },
      body: JSON.stringify({ model: MODEL, input: inputs, dimensions: DIMENSIONS }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json().catch(() => null) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
      error?: { message?: string };
      usage?: unknown;
    } | null;
    if (!response.ok) {
      console.error("OpenRouter embedding request failed:", response.status, payload?.error?.message || "Unknown provider error");
      return jsonWithCors(request, { error: "The semantic embedding service is temporarily unavailable." }, { status: 502 });
    }
    const rows = Array.isArray(payload?.data)
      ? [...payload.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      : [];
    const embeddings = rows.map((row) => row.embedding);
    if (
      embeddings.length !== inputs.length ||
      embeddings.some((vector) =>
        !Array.isArray(vector) ||
        vector.length !== DIMENSIONS ||
        vector.some((value) => !Number.isFinite(value))
      )
    ) {
      throw new Error("Embedding provider returned an invalid response.");
    }
    return jsonWithCors(request, {
      model: MODEL,
      dimensions: DIMENSIONS,
      embeddings,
      usage: payload?.usage ?? null,
    });
  } catch (error) {
    console.error("Error in POST /api/tally/bridge/embeddings:", error);
    return jsonWithCors(request, { error: "Could not create semantic embeddings." }, { status: 500 });
  }
}
