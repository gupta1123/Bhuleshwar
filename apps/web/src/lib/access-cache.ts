'use client';
const caches = new Map<string, () => void>();
let epoch = 0;
export function accessCacheEpoch() { return epoch; }
export function registerAccessCache(name: string, clear: () => void) { caches.set(name, clear); }
if (typeof window !== 'undefined') {
  window.addEventListener('kalika-access-invalidated', () => {
    epoch++;
    for (const clear of caches.values()) clear();
  });
}
