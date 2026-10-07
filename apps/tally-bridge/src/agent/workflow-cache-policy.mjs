// Calendar-day freshness follows the Tally PC's local timezone.
export function workflowCacheState(updatedAt, now = new Date()) {
  const saved = new Date(updatedAt);
  if (!Number.isFinite(saved.getTime()) || saved > now) return { stale: true };
  return { stale: saved.getFullYear() !== now.getFullYear() || saved.getMonth() !== now.getMonth() || saved.getDate() !== now.getDate() };
}
