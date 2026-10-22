import type { StorageLike } from '../platform/types';
// Mejor esfuerzo: localStorage carece de compare-and-swap. Véase README.
export function acquireLease(storage: StorageLike, key: string, now: () => number) {
  const lockKey = `${key}:lock`, token = crypto.randomUUID();
  for (let attempt = 0; attempt < 1; attempt++) {
    let previous;
    try { previous = JSON.parse(storage.getItem(lockKey) ?? 'null'); } catch { previous = null; }
    if (previous?.expiresAt > now()) continue;
    const raw = JSON.stringify({ token, expiresAt: now() + 2000 });
    storage.setItem(lockKey, raw);
    if (storage.getItem(lockKey) !== raw) continue;
    return {
      owns: () => storage.getItem(lockKey) === raw && now() < JSON.parse(raw).expiresAt,
      release: () => { if (storage.getItem(lockKey) === raw) storage.setItem(lockKey, JSON.stringify({ token, expiresAt: 0 })); },
    };
  }
}
