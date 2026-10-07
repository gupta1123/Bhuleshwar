const DEFAULT_SUPABASE_FETCH_TIMEOUT_MS = 20_000;

export function createSupabaseFetch(timeoutMs = DEFAULT_SUPABASE_FETCH_TIMEOUT_MS): typeof fetch {
  return async function supabaseFetch(input, init) {
    const controller = new AbortController();
    const callerSignal = init?.signal;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const abortFromCaller = () => controller.abort();

    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}
