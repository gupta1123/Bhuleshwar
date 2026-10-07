type Snapshot = { processing?: boolean; job?: { status?: string; error?: string | null } | null };

// Notifications and loopback completion share one in-flight read. A notification
// never proves saving succeeded: only the durable snapshot permits preview load.
export function createBankPreviewCompletion<T extends Snapshot>(options: {
  snapshot: () => Promise<Snapshot>; preview: () => Promise<T>;
  pollMs?: number; timeoutMs?: number; readRetryDelaysMs?: number[];
}) {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  let terminal = false, online = false, inFlight: Promise<void> | null = null;
  let checkAgain = false;
  let polling: ReturnType<typeof setTimeout> | undefined;
  let readRetry: ReturnType<typeof setTimeout> | undefined;
  let readFailures = 0;
  const cleanup = () => { clearTimeout(polling); clearTimeout(readRetry); clearTimeout(deadline); };
  const fail = (error: Error) => { if (!terminal) { terminal = true; cleanup(); reject(error); } };
  const schedule = () => {
    clearTimeout(polling);
    // The socket is only a low-latency hint. It can remain connected while a
    // terminal job event is missed, so durable status polling must never stop.
    if (!terminal) polling = setTimeout(() => { void check().finally(schedule); }, options.pollMs ?? 15000);
  };
  const check = () => {
    if (terminal) return Promise.resolve();
    // A completion event may arrive while a pre-commit status read is already
    // in flight. Coalesce it into one follow-up read, rather than losing it.
    if (inFlight) { checkAgain = true; return inFlight; }
    inFlight = (async () => {
      try {
        const snapshot = await options.snapshot();
        if (terminal) return;
        if (['failed','cancelled','canceled'].includes(snapshot.job?.status || '')) {
          fail(new Error(snapshot.job?.error || 'Bank statement analysis failed or was cancelled.')); return;
        }
        if (snapshot.processing) { readFailures = 0; return; }
        const preview = await options.preview();
        if (terminal || preview.processing) return;
        terminal = true; cleanup(); resolve(preview);
      } catch {
        // An online socket will not repeat its completion event just because a
        // preview GET failed. Retry only that read, boundedly; never restart AI.
        if (terminal) return;
        const delays = options.readRetryDelaysMs ?? [300, 750, 1500];
        if (readFailures >= delays.length) {
          fail(new Error('Could not load the saved statement. Refresh to check its status; no new AI call was started.'));
        } else {
          clearTimeout(readRetry);
          readRetry = setTimeout(() => { void check(); }, delays[readFailures++]);
        }
      }
    })().finally(() => {
      inFlight = null;
      if (checkAgain && !terminal) { checkAgain = false; queueMicrotask(() => { void check(); }); }
    });
    return inFlight;
  };
  const deadline = setTimeout(() => {
    void check().finally(() => fail(new Error('Analysis status is unavailable. Refresh this statement before retrying; no new AI call was started.')));
  }, options.timeoutMs ?? 15 * 60_000);
  schedule();
  return { promise, check, fail,
    setOnline(value: boolean) { const wasOnline = online; online = value; schedule(); if (online && !wasOnline) void check(); },
    stop() { terminal = true; cleanup(); },
  };
}
