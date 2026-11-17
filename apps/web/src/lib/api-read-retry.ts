/** Recover transient reads without ever replaying a mutation or crossing access scopes. */
export async function fetchWithReadRetry(
  request: () => Promise<Response>,
  init?: Pick<RequestInit, "method" | "signal">,
  isCurrent = () => true
) {
  const read = ["GET", "HEAD"].includes((init?.method || "GET").toUpperCase());
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await request();
      if (![502, 503, 504].includes(response.status)) return response;
    } catch (error) {
      if (!(error instanceof TypeError) || !read || attempt >= 2 || init?.signal?.aborted || !isCurrent()) throw error;
    }
    if (!read || attempt >= 2 || init?.signal?.aborted || !isCurrent()) return response!;
    await response?.body?.cancel().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason || new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 500 * (attempt + 1));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (!isCurrent()) throw new DOMException("Access context changed; discard the previous request.", "AbortError");
  }
}
