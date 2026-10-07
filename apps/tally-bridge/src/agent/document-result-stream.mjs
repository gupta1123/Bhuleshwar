import { gzipSync } from 'node:zlib';

// Compact NDJSON only. No response body, token or document content is logged.
export async function readDocumentResultStream(response, onProgress = () => {}) {
  if (!response.ok) {
    const error = new Error(`Document analysis endpoint returned HTTP ${response.status}.`);
    error.status = response.status;
    error.admissionRejected = response.headers.get('x-kalika-job-accepted') === 'false';
    error.retryAfterSeconds = Math.max(1, Math.min(30, Number(response.headers.get('retry-after')) || 5));
    throw error;
  }
  if (!response.body) throw new Error('Document analysis response was empty.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', terminal;
  const line = value => {
    if (!value.trim()) return;
    const message = JSON.parse(value);
    if (message.type === 'keepalive') return;
    if (message.type === 'progress') onProgress(message);
    else if (message.type === 'result') terminal = message;
    else if (message.type === 'error') {
      const error = new Error(message.error || 'Document analysis failed.'); error.code = message.code; throw error;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 65536) throw new Error('Oversized document status response.');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { line(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
      if (done) break;
    }
    if (pending) line(pending);
    if (!terminal) throw new Error('Document response was interrupted. Check job status before retrying.');
    return terminal;
  } finally { await reader.cancel().catch(() => {}); }
}

export async function uploadDocumentEnvelope({ url, token, envelope, statusUrl, deadlineAt, onProgress, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const normalizedDeadlineAt = Math.trunc(Number(deadlineAt));
  if (!Number.isFinite(normalizedDeadlineAt)) throw new Error('Document job deadline is invalid.');
  const remainingMs = maximum => Math.max(1, Math.trunc(Math.min(maximum, normalizedDeadlineAt - Date.now())));
  const bytes = gzipSync(JSON.stringify(envelope));
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.kalika.bank-document-v2+json', 'Content-Encoding': 'gzip' };
  let uncertain = false;
  const pause = ms => sleep(Math.max(0, Math.trunc(Math.min(ms, normalizedDeadlineAt - Date.now()))));
  while (Date.now() < normalizedDeadlineAt) {
    if (uncertain) {
      // Never resend a possibly accepted result without consulting durable state.
      const response = await fetchImpl(statusUrl, { headers: { Authorization: headers.Authorization }, signal: AbortSignal.timeout(remainingMs(10000)) });
      if (!response.ok) throw new Error('Cannot determine document job status. No AI retry was attempted.');
      const current = await response.json();
      if (['completed','failed','cancelled'].includes(current.state)) return current;
      if (current.state !== 'preparing') { await pause(15000); continue; }
      uncertain = false;
    }
    try {
      const response = await fetchImpl(url, { method: 'POST', headers, body: bytes, signal: AbortSignal.timeout(remainingMs(Number.MAX_SAFE_INTEGER)) });
      const result = await readDocumentResultStream(response, onProgress);
      if (result.state === 'busy') { await pause(Math.min(30000, Math.max(1000, (result.retryAfterSeconds || 5)*1000))); continue; }
      if (['analyzing', 'saving', 'recovery'].includes(result.state)) { uncertain = true; continue; }
      return result;
    } catch (error) {
      if ([429,503].includes(error.status) && error.admissionRejected) { await pause(error.retryAfterSeconds*1000); continue; }
      if (error.status >= 500) { uncertain = true; continue; }
      if (error.status || error.code) throw error;
      uncertain = true;
    }
  }
  throw new Error('Document job deadline exceeded. Check its status before explicitly retrying.');
}
