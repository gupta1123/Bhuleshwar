// Automatic background synchronization is allowed only when Tally exposes a
// trustworthy global AlterID watermark. Without it, polling every minute means
// repeatedly querying four large master collections and can monopolize Tally's
// single HTTP listener. Explicit Refresh/Sync operations remain available.
export function automaticCatalogueSyncPlan(dataset, capabilities = null) {
  if (!dataset) return { probeCapabilities: true, sync: true, reason: "initial_company_observation" };
  if (dataset.status === "ready" && dataset.cacheHealth?.watermarkReliable !== true) {
    return { probeCapabilities: false, sync: false, reason: "cached_fallback_catalogue" };
  }
  if (!capabilities) return { probeCapabilities: true, sync: false, reason: "capability_probe_required" };
  const reliable = capabilities.fallback !== true && Number(capabilities.version || 0) > 0 &&
    Number(capabilities.highestAlterId || 0) > 0;
  if (!reliable) return { probeCapabilities: false, sync: false, reason: "unreliable_global_watermark" };
  const previous = Number(dataset.cacheHealth?.highestAlterId || 0);
  return Number(capabilities.highestAlterId || 0) === previous
    ? { probeCapabilities: true, sync: false, reason: "watermark_unchanged" }
    : { probeCapabilities: true, sync: true, reason: "alter_id_watermark_changed" };
}
