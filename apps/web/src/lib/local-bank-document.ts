const LOCAL_AGENT = "http://127.0.0.1:17843";

export function assertLocalBankContextIdentity(expected: Record<string, unknown>, actual: Record<string, unknown> | undefined) {
  for (const field of ['organizationId','ownerUserId','connectionId','installationId','sessionGeneration','companyGuid','companyName','financialYear']) {
    if (expected[field] == null || !String(expected[field]) || String(expected[field]) !== String(actual?.[field])) {
      throw new Error('The document and ledger preparation scopes differ. Refresh the selected connection and retry.');
    }
  }
}

export async function localPdfMetadata(file: File) {
  if (file.size < 1 || file.size > 25 * 1024 * 1024) throw new Error("Local parsing supports PDFs up to 25 MB.");
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return { name: file.name, size: file.size, sha256: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") };
}

export async function readDocumentProgress(response: Response, onStatus: (status: string) => void) {
  // Older agents acknowledge transfer without exposing the parsing phase.
  // Do not pretend that their parser is currently running.
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    onStatus("Processing document");
    return false;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Document progress stream is unavailable.");
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  const labels: Record<string, string> = {
    preparing_document: "Preparing document", parsing_document: "Document parsing",
    vector_matching: "Finding ledger candidates", analyzing_document: "Selecting ledgers", complete: "Finalizing results",
    saving_preview: "Finalizing results", recovery_pending: "Finalizing results",
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      if (done && buffer) { lines.push(buffer); buffer = ""; }
      if (buffer.length > 65536 || lines.some(line => line.length > 65536)) throw new Error('Invalid document status response.');
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.phase === "failed") throw new Error(event.error || "Document processing failed.");
        if (labels[event.phase]) onStatus(labels[event.phase]);
        if (event.phase === "complete") complete = true;
      }
      if (done) break;
    }
    if (!complete) throw new Error("Document processing connection was interrupted.");
    return true;
  } finally { reader.releaseLock(); }
}

export async function sendPdfToLocalAgent(file: File, token: string, onStatus: (status: string) => void = () => {}, signal?: AbortSignal) {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("Invalid local upload ticket.");
  const headers = { Authorization: `Bearer ${token}` };
  const expires = Date.now() + 120_000;
  let transferAccepted = false;
  try {
    while (Date.now() < expires) {
      const ready = await fetch(`${LOCAL_AGENT}/document/ready`, {
        headers, cache: "no-store", credentials: "omit", signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
      });
      if (ready.ok && (await ready.json()).ready === true) {
        // Never use a URL supplied by the server for raw PDF bytes.
        const uploaded = await fetch(`${LOCAL_AGENT}/document`, {
          method: "POST", headers: { ...headers, "Content-Type": "application/pdf" },
          body: file, credentials: "omit", signal: AbortSignal.any([AbortSignal.timeout(360_000), ...(signal ? [signal] : [])]),
        });
        if (!uploaded.ok) throw new Error((await uploaded.json()).error || "Local PDF transfer failed.");
        transferAccepted = true;
        return await readDocumentProgress(uploaded, onStatus);
      }
      if (!ready.ok && ready.status !== 409) throw new Error("The local agent rejected this browser or upload ticket.");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("The selected agent did not receive the upload job. Check that it is on this PC.");
  } catch (error) {
    if (!transferAccepted) await fetch(`${LOCAL_AGENT}/document/cancel`, { method: "POST", headers, credentials: "omit", signal: AbortSignal.timeout(2000) }).catch(() => {});
    if (error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")) {
      if (transferAccepted) throw new Error("The document analysis connection was interrupted or timed out. Check the statement status before retrying.");
      throw new Error("Cannot reach the selected Local Agent on this PC. Open the updated agent and allow this site's local-network permission. The PDF was not uploaded to the backend.");
    }
    throw error;
  }
}

export type LocalBankContext = {
  pipelineVersion: 2; identity: Record<string, unknown>;
  ledgerNames: string[]; bankAccountCandidates: { ledgerName: string; accountNumber: string }[];
};

export async function sendLedgerContextToLocalAgent(token: string, context: LocalBankContext, signal?: AbortSignal) {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid local upload ticket.');
  const expires = Date.now() + 120_000;
  // Retry only the explicit not-registered response. A conflicting context is
  // never replaced, and an unknown response cannot silently change inputs.
  while (Date.now() < expires) {
    signal?.throwIfAborted();
    const response = await fetch(`${LOCAL_AGENT}/document/context`, {
      method: 'POST', credentials: 'omit', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(context), signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
    });
    const result = await response.json();
    if (response.ok && result.accepted === true) return result.contextHash as string;
    if (response.status !== 202 || result.code !== 'CONTEXT_NOT_READY') throw new Error(result.error || 'Ledger context was rejected.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('The selected agent did not accept the ledger context before its deadline.');
}

export async function cancelLocalDocument(token: string) {
  if (!/^[a-f0-9]{64}$/i.test(token)) return;
  await fetch(`${LOCAL_AGENT}/document/cancel`, { method: 'POST', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) }).catch(() => {});
}
