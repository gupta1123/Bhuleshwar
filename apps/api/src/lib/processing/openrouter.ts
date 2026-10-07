import { AsyncLocalStorage } from "node:async_hooks";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  process.env.NEXT_PUBLIC_OPENROUTER_MODEL ||
  "google/gemini-2.5-flash-image";
const OPENROUTER_QUALITY_MODEL =
  process.env.OPENROUTER_QUALITY_MODEL ||
  process.env.GEMINI_THINKING_MODEL ||
  "google/gemini-2.5-flash";
const OPENROUTER_BANK_LEDGER_MODEL =
  process.env.OPENROUTER_BANK_LEDGER_MODEL ||
  "deepseek/deepseek-v4-pro";
const OPENROUTER_BANK_LEDGER_MAX_OUTPUT_TOKENS = Number(
  process.env.OPENROUTER_BANK_LEDGER_MAX_OUTPUT_TOKENS ?? 4096
);
const OPENROUTER_BANK_LEDGER_TIMEOUT_MS = Number(process.env.OPENROUTER_BANK_LEDGER_TIMEOUT_MS ?? 30_000);
const OPENROUTER_REVIEW_MODEL =
  process.env.OPENROUTER_REVIEW_MODEL ||
  process.env.OPENROUTER_EXTRACTION_REVIEW_MODEL ||
  "openai/gpt-5.5";
const OPENAI_REVIEW_MODEL =
  process.env.OPENAI_REVIEW_MODEL ||
  process.env.EXTRACTION_REVIEW_MODEL ||
  "gpt-5.5";
const EXTRACTION_REVIEW_PROVIDER = (
  process.env.EXTRACTION_REVIEW_PROVIDER ||
  process.env.OPENROUTER_REVIEW_PROVIDER ||
  process.env.OPENAI_REVIEW_PROVIDER ||
  ""
)
  .trim()
  .toLowerCase();
const OPENROUTER_REVIEW_REASONING_EFFORT =
  process.env.OPENROUTER_REVIEW_REASONING_EFFORT ||
  process.env.OPENAI_REVIEW_REASONING_EFFORT ||
  process.env.EXTRACTION_REVIEW_REASONING_EFFORT ||
  "medium";
const OPENROUTER_QUALITY_REASONING_TOKENS = Number(process.env.OPENROUTER_QUALITY_REASONING_TOKENS ?? 2000);
const OPENROUTER_MAX_OUTPUT_TOKENS = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS ?? 8192);
const OPENROUTER_REVIEW_MAX_OUTPUT_TOKENS = Number(process.env.OPENROUTER_REVIEW_MAX_OUTPUT_TOKENS ?? 4096);
const MAX_RETRIES = Number(process.env.OPENROUTER_MAX_RETRIES ?? 2);
const RETRY_BASE_MS = Number(process.env.OPENROUTER_RETRY_BASE_MS ?? 1200);
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS ?? 60_000);

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
};

type OpenRouterContentPart = {
  text?: string;
};

type OpenRouterReasoningOptions = {
  max_tokens?: number;
  effort?: "none" | "low" | "medium" | "high" | "max";
  enabled?: boolean;
  exclude?: boolean;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeMaxTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

function timeoutMessage(model: string, timeoutMs: number) {
  return `OpenRouter request timed out after ${Math.round(timeoutMs / 1000)}s for model ${model}.`;
}

// Test-only overrides for the extraction test endpoint. Production requests never run inside this
// context, so callOpenRouter behaves exactly as before for them.
export type AiCallTrace = {
  label: string;
  model: string;
  durationMs: number;
  usage: unknown;
  systemPrompt: string;
  userText: string;
  imageCount: number;
  response: string;
  error?: string;
};

export type AiTestOverrides = {
  model?: string;
  systemAppend?: string;
  systemReplace?: Array<{ find: string; replace: string }>;
  trace: AiCallTrace[];
};

const aiTestContext = new AsyncLocalStorage<AiTestOverrides>();

export function runWithAiTestOverrides<T>(overrides: AiTestOverrides, run: () => Promise<T>) {
  return aiTestContext.run(overrides, run);
}

function messageText(message: OpenRouterMessage) {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => ("text" in part ? part.text : "")).filter(Boolean).join("\n");
}

function applyTestPromptOverrides(messages: OpenRouterMessage[], overrides: AiTestOverrides) {
  if (!overrides.systemAppend && !overrides.systemReplace?.length) return messages;
  return messages.map((message) => {
    if (message.role !== "system" || typeof message.content !== "string") return message;
    let content = message.content;
    for (const { find, replace } of overrides.systemReplace ?? []) {
      if (find) content = content.split(find).join(replace);
    }
    if (overrides.systemAppend) content = `${content} ${overrides.systemAppend}`;
    return { ...message, content };
  });
}

function recordTestTrace(
  overrides: AiTestOverrides | undefined,
  messages: OpenRouterMessage[],
  entry: Pick<AiCallTrace, "model" | "durationMs" | "usage" | "response" | "error">
) {
  if (!overrides) return;
  const system = messages.find((message) => message.role === "system");
  const users = messages.filter((message) => message.role === "user");
  overrides.trace.push({
    label: `call-${overrides.trace.length + 1}`,
    systemPrompt: system ? messageText(system) : "",
    userText: users.map(messageText).join("\n"),
    imageCount: users.reduce(
      (count, message) =>
        count + (Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url").length : 0),
      0
    ),
    ...entry,
  });
}

function logOpenRouterDiagnostic(event: Record<string, unknown>) {
  if (process.env.OPENROUTER_DEBUG_LOG !== "true") return;
  console.log(JSON.stringify({ scope: "openrouter", ...event }));
}

export async function callOpenRouter(
  requestMessages: OpenRouterMessage[],
  options?: {
    expectJson?: boolean;
    jsonMode?: boolean;
    model?: string;
    reasoning?: OpenRouterReasoningOptions;
    maxTokens?: number;
    timeoutMs?: number;
    maxRetries?: number;
  }
) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  const testOverrides = aiTestContext.getStore();
  const messages = testOverrides ? applyTestPromptOverrides(requestMessages, testOverrides) : requestMessages;
  const callStartedAt = Date.now();
  const maxTokens = normalizeMaxTokens(options?.maxTokens ?? OPENROUTER_MAX_OUTPUT_TOKENS);
  const model = testOverrides?.model || options?.model || OPENROUTER_MODEL;
  const timeoutMs = Number.isFinite(options?.timeoutMs) && Number(options?.timeoutMs) > 0
    ? Number(options?.timeoutMs)
    : OPENROUTER_TIMEOUT_MS;
  const maxRetries = Number.isFinite(options?.maxRetries) && Number(options?.maxRetries) >= 0
    ? Math.floor(Number(options?.maxRetries))
    : MAX_RETRIES;
  let attempt = 0;
  let lastError = "OpenRouter request failed";

  while (attempt <= maxRetries) {
    const requestStartedAt = Date.now();
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: abortController.signal,
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_BASE_URL || "http://localhost:3001",
          "X-Title": "Autodealer Workflow Backend",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0,
          ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
          ...(options?.jsonMode ? { response_format: { type: "json_object" } } : {}),
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
        }),
      });
      clearTimeout(timeoutId);

      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.error) {
        const errorText =
          payload?.error?.message ||
          payload?.message ||
          (response.ok ? "OpenRouter returned an error payload" : `OpenRouter request failed (${response.status})`);
        lastError = errorText;
        logOpenRouterDiagnostic({
          event: "response_error",
          model,
          attempt: attempt + 1,
          status: response.status,
          durationMs: Date.now() - requestStartedAt,
          error: errorText,
        });

        if (!isRetryableStatus(response.status) || isHardQuotaError(errorText) || attempt === maxRetries) {
          throw new Error(errorText);
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
      logOpenRouterDiagnostic({
        event: "response_success",
        model,
        attempt: attempt + 1,
        status: response.status,
        durationMs: Date.now() - requestStartedAt,
        finishReason: payload?.choices?.[0]?.finish_reason ?? null,
        usage: payload?.usage ?? null,
        contentLength: content.length,
        content,
      });
      recordTestTrace(testOverrides, messages, {
        model,
        durationMs: Date.now() - callStartedAt,
        usage: payload?.usage ?? null,
        response: content,
      });
      return content;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? timeoutMessage(model, timeoutMs)
          : error instanceof Error
            ? error.message
            : String(error ?? "Unknown error");
      logOpenRouterDiagnostic({
        event: "request_exception",
        model,
        attempt: attempt + 1,
        durationMs: Date.now() - requestStartedAt,
        error: lastError,
      });
      if (attempt === maxRetries) {
        recordTestTrace(testOverrides, messages, {
          model,
          durationMs: Date.now() - callStartedAt,
          usage: null,
          response: "",
          error: lastError,
        });
        throw new Error(lastError);
      }
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw new Error(lastError);
}

export function getQualityExtractionModel() {
  return OPENROUTER_QUALITY_MODEL;
}

export function getBankLedgerMatchingModel() {
  return OPENROUTER_BANK_LEDGER_MODEL;
}

export function getBankLedgerMatchingMaxTokens() {
  return normalizeMaxTokens(OPENROUTER_BANK_LEDGER_MAX_OUTPUT_TOKENS);
}

export function getBankLedgerMatchingTimeoutMs() {
  if (!Number.isFinite(OPENROUTER_BANK_LEDGER_TIMEOUT_MS) || OPENROUTER_BANK_LEDGER_TIMEOUT_MS <= 0) {
    return undefined;
  }

  return OPENROUTER_BANK_LEDGER_TIMEOUT_MS;
}

export function getBankLedgerMatchingReasoning(): OpenRouterReasoningOptions | undefined {
  const mode = String(process.env.OPENROUTER_BANK_LEDGER_REASONING ?? "").trim().toLowerCase();
  if (!mode) return undefined;
  if (["off", "none", "disabled", "false", "0"].includes(mode)) {
    return { enabled: false, effort: "none" };
  }
  if (["low", "medium", "high", "max"].includes(mode)) {
    return { effort: mode as "low" | "medium" | "high" | "max", exclude: true };
  }
  return undefined;
}

function getConfiguredExtractionReviewProvider() {
  if (EXTRACTION_REVIEW_PROVIDER === "openai" || EXTRACTION_REVIEW_PROVIDER === "openrouter") {
    return EXTRACTION_REVIEW_PROVIDER;
  }

  return OPENROUTER_API_KEY ? "openrouter" : "openai";
}

export function getExtractionReviewModel() {
  return getConfiguredExtractionReviewProvider() === "openrouter" ? OPENROUTER_REVIEW_MODEL : OPENAI_REVIEW_MODEL;
}

export function getExtractionReviewProvider() {
  return getConfiguredExtractionReviewProvider();
}

export function getQualityExtractionReasoning() {
  if (!Number.isFinite(OPENROUTER_QUALITY_REASONING_TOKENS) || OPENROUTER_QUALITY_REASONING_TOKENS <= 0) {
    return undefined;
  }

  return {
    max_tokens: OPENROUTER_QUALITY_REASONING_TOKENS,
    exclude: true,
  } satisfies OpenRouterReasoningOptions;
}

export function getExtractionReviewReasoning() {
  if (!["low", "medium", "high"].includes(OPENROUTER_REVIEW_REASONING_EFFORT)) {
    return { effort: "medium", exclude: true } satisfies OpenRouterReasoningOptions;
  }

  return {
    effort: OPENROUTER_REVIEW_REASONING_EFFORT as "low" | "medium" | "high",
    exclude: true,
  } satisfies OpenRouterReasoningOptions;
}

export function getExtractionReviewReasoningEffort() {
  return getExtractionReviewReasoning().effort ?? "medium";
}

export async function callExtractionReviewModel(messages: OpenRouterMessage[]) {
  if (getConfiguredExtractionReviewProvider() === "openrouter") {
    return callOpenRouter(messages, {
      expectJson: true,
      jsonMode: true,
      model: OPENROUTER_REVIEW_MODEL,
      reasoning: getExtractionReviewReasoning(),
      maxTokens: normalizeMaxTokens(OPENROUTER_REVIEW_MAX_OUTPUT_TOKENS),
    });
  }

  let attempt = 0;
  let lastError = "OpenAI extraction review request failed";

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENAI_REVIEW_MODEL,
          messages,
          response_format: { type: "json_object" },
          reasoning_effort: getExtractionReviewReasoningEffort(),
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (payload?.error || !response.ok) {
        const errorText =
          payload?.error?.message ||
          payload?.message ||
          `OpenAI extraction review request failed (${response.status})`;
        lastError = errorText;

        if (!isRetryableStatus(response.status) || isHardQuotaError(errorText) || attempt === MAX_RETRIES) {
          throw new Error(errorText);
        }

        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(delayMs);
        attempt += 1;
        continue;
      }

      const message = payload?.choices?.[0]?.message?.content;
      return Array.isArray(message)
        ? message.map((part: OpenRouterContentPart) => part?.text || "").join("\n")
        : String(message || "");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error ?? "Unknown error");
      if (attempt === MAX_RETRIES) {
        throw new Error(lastError);
      }
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw new Error(lastError);
}
