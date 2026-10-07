const activeByRuntime = new WeakMap();

// Called from the Tally lane but deliberately does not await document work.
// Parsing/upload/AI must not keep that lane occupied while ledger reads queue.
export function startDetachedDocument(runtime, command, sendResult, onDeliveryError = () => {}) {
  let active = activeByRuntime.get(runtime);
  if (!active) { active = new Map(); activeByRuntime.set(runtime, active); }
  if (active.has(command.id)) return;
  const task = Promise.resolve().then(() => runtime.execute(command)).catch(() => ({
    success: false, result: {}, error: 'Local document processing stopped. Check statement status before retrying.',
  })).then(outcome => sendResult(outcome)).catch(() => {
    // Delivery failure is not processing failure; never overwrite a successful
    // result with a fabricated failure just because its acknowledgement was lost.
    onDeliveryError();
  }).finally(() => active.delete(command.id));
  active.set(command.id, task);
}
