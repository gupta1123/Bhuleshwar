import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  process.env.NEXT_PUBLIC_OPENROUTER_MODEL ||
  "google/gemini-2.5-flash-image";
const MAX_RETRIES = Number(process.env.OPENROUTER_MAX_RETRIES ?? 2);
const RETRY_BASE_MS = Number(process.env.OPENROUTER_RETRY_BASE_MS ?? 1200);

type OpenRouterContentPart = {
  text?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function isHardQuotaError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("limit: 0") ||
    lower.includes("quota exceeded") ||
    lower.includes("billing") ||
    lower.includes("insufficient credits")
  );
}

function isRetryableStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function POSTHandler(req: Request) {
  const user = await requireRequestUser(req);
  if (!user) {
    return jsonWithCors(req, { error: "Unauthorized" }, { status: 401 });
  }

  if (!OPENROUTER_API_KEY) {
    return jsonWithCors(req,
      { error: "OPENROUTER_API_KEY is not configured." },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => null);
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  const expectJson = Boolean(body?.expectJson);

  if (!messages) {
    return jsonWithCors(req, { error: "Missing messages payload." }, { status: 400 });
  }

  let attempt = 0;
  let lastError = "OpenRouter request failed";

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "Procurement Comparator",
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
          temperature: 0,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorText =
          payload?.error?.message ||
          payload?.message ||
          `OpenRouter request failed (${response.status})`;
        lastError = errorText;

        if (!isRetryableStatus(response.status) || isHardQuotaError(errorText) || attempt === MAX_RETRIES) {
          return jsonWithCors(req, { error: errorText }, { status: response.status || 500 });
        }

        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(delayMs);
        attempt += 1;
        continue;
      }

      const message = payload?.choices?.[0]?.message?.content;
      const content = Array.isArray(message)
        ? message.map((part: OpenRouterContentPart) => part?.text || "").join("\n")
        : String(message || "");

      return jsonWithCors(req, {
        content,
        model: OPENROUTER_MODEL,
      });
    } catch (error) {
      lastError = toMessage(error);
      if (attempt === MAX_RETRIES) {
        return jsonWithCors(req, { error: lastError }, { status: 502 });
      }
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
      await sleep(delayMs);
      attempt += 1;
    }
  }

  return jsonWithCors(req, { error: lastError }, { status: 502 });
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export const POST = withTeamAccess(POSTHandler);
