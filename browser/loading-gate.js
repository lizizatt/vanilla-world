// Loading-screen release rule: the first few terrain chunks around the player must be resident (not just the support footprint).
// The wait is bounded so a slow or partial Data folder can never hang the loading screen.
export const NEAR_CHUNKS = 4;
export const NEAR_TIMEOUT_MS = 15000;

export function nearChunksReady(near, elapsedMs, { need = NEAR_CHUNKS, timeoutMs = NEAR_TIMEOUT_MS } = {}) {
  if (!near || elapsedMs >= timeoutMs) return true;
  return near.resident >= Math.min(need, near.total);
}
