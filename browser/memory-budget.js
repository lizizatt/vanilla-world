// Byte-budgeted residency policy shared by the terrain, scene and distant caches (see design/memory-budget.md).
export const MIB = 1024 * 1024;
export const BUDGET_TARGET = 0.9;
export const BUDGET_FLOOR = 192 * MIB;
export const BUDGET_CAP = 3072 * MIB;
export const BUDGET_FALLBACK = 384 * MIB;
export const BUDGET_SETTINGS = Object.freeze(['auto', '256', '512', '1024', '2048', '3072']);

// How the whole budget is divided; the rest is headroom for wasm, JS heap and renderer overhead.
export const BUDGET_SHARES = Object.freeze({ scene: 0.4, far: 0.15, terrain: 0.2 });

/** Auto budget: a fraction of device memory (GiB, capped at 8 by browsers) bounded by the JS heap limit. */
export function deriveBudget({ setting = 'auto', deviceMemory, heapLimit } = {}) {
  const clamp = v => Math.min(BUDGET_CAP, Math.max(BUDGET_FLOOR, Math.floor(v)));
  const chosen = Number(setting);
  if (setting !== 'auto' && Number.isFinite(chosen) && chosen > 0) return clamp(chosen * MIB);
  const candidates = [];
  if (Number.isFinite(deviceMemory) && deviceMemory > 0) candidates.push(deviceMemory * 1024 * MIB * 0.2);
  if (Number.isFinite(heapLimit) && heapLimit > 0) candidates.push(heapLimit * 0.3);
  return clamp(candidates.length ? Math.min(...candidates) : BUDGET_FALLBACK);
}

export function splitBudget(total) {
  return Object.fromEntries(Object.entries(BUDGET_SHARES).map(([k, f]) => [k, Math.floor(total * f)]));
}

/** Accounting with hysteresis: eviction starts only past the limit and then drains to the target. */
export class ByteBudget {
  constructor(limit, target = BUDGET_TARGET) {
    if (!Number.isFinite(limit) || limit <= 0 || !(target > 0 && target < 1)) throw new Error('Invalid byte budget');
    this.limit = limit; this.targetRatio = target; this.used = 0; this.evictions = 0;
  }
  get target() { return Math.floor(this.limit * this.targetRatio); }
  setLimit(limit) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('Invalid byte budget');
    this.limit = limit;
  }
  fits(bytes = 0) { return this.used + bytes <= this.limit; }
  /** Bytes that must be freed before `incoming` can be admitted; zero while it fits (no thrash near the limit). */
  deficit(incoming = 0) { return this.fits(incoming) ? 0 : this.used + incoming - this.target; }
  add(bytes) { this.used += bytes; }
  remove(bytes) { this.used = Math.max(0, this.used - bytes); }
}

/**
 * LRU cache with a byte budget. Eviction order is least important first: pinned items are never evicted,
 * then larger priority (distance) numbers go before smaller, ties broken by least recently used.
 */
export class BudgetedCache {
  constructor(limit, { onEvict, target } = {}) {
    this.budget = new ByteBudget(limit, target);
    this.items = new Map(); this.onEvict = onEvict; this.clock = 0; this.rejected = 0;
  }
  get size() { return this.items.size; }
  get bytes() { return this.budget.used; }
  has(key) { return this.items.has(key); }
  get(key) {
    const item = this.items.get(key);
    if (!item) return undefined;
    item.used = ++this.clock;
    return item.value;
  }
  setLimit(limit) { this.budget.setLimit(limit); this.trim(); }
  setPriority(key, priority) { const item = this.items.get(key); if (item) item.priority = priority; }
  pin(key, pinned = true) { const item = this.items.get(key); if (item) item.pinned = pinned; }
  delete(key) {
    const item = this.items.get(key);
    if (!item) return false;
    this.items.delete(key); this.budget.remove(item.bytes);
    return true;
  }
  clear() { this.items.clear(); this.budget.used = 0; }
  #victims(skip) {
    return [...this.items.entries()].filter(([k, v]) => !v.pinned && k !== skip)
      .sort((a, b) => b[1].priority - a[1].priority || a[1].used - b[1].used);
  }
  #evict(key) {
    const item = this.items.get(key);
    this.delete(key); this.budget.evictions++;
    this.onEvict?.(key, item.value);
  }
  /** Evict as needed (down to the target) so `bytes` fit; false when pinned items leave no room. */
  reserve(bytes, skip) {
    let need = this.budget.deficit(bytes);
    if (!need) return true;
    for (const [key, item] of this.#victims(skip)) {
      if (need <= 0) break;
      need -= item.bytes; this.#evict(key);
    }
    return this.budget.fits(bytes);
  }
  set(key, value, bytes, { priority = 0, pinned = false } = {}) {
    this.delete(key);
    if (!this.reserve(bytes)) { this.rejected++; return false; }
    this.items.set(key, { value, bytes, priority, pinned, used: ++this.clock });
    this.budget.add(bytes);
    return true;
  }
  /** Re-run eviction after a limit change; returns the number of evicted items. */
  trim() {
    const before = this.budget.evictions;
    if (this.budget.used > this.budget.limit) this.reserve(0);
    return this.budget.evictions - before;
  }
  stats() {
    let pinnedBytes = 0;
    for (const v of this.items.values()) if (v.pinned) pinnedBytes += v.bytes;
    return { used: this.budget.used, limit: this.budget.limit, count: this.items.size, pinnedBytes,
      evictions: this.budget.evictions, rejected: this.rejected };
  }
}

/** Evictions per second over a sliding window, for the live readout. */
export class RateMeter {
  constructor(windowMs = 5000) { this.windowMs = windowMs; this.marks = []; this.last = 0; }
  sample(total, now) {
    if (total !== this.last) { this.marks.push([now, total - this.last]); this.last = total; }
    while (this.marks.length && now - this.marks[0][0] > this.windowMs) this.marks.shift();
    return this.marks.reduce((n, m) => n + m[1], 0) * 1000 / this.windowMs;
  }
}

/** Live readout inputs from a worker snapshot: CPU-side bytes held by the residency caches vs. the budget. */
export function memoryUsage(s) {
  const d = s.distant || {}, t = s.terrain || {};
  return {
    used: (s.scene?.bytes || 0) + (t.bytes || 0) + (d.scene?.bytes || 0) + (d.tileBytes || 0),
    budget: s.memory?.budget || 0,
    tiles: (s.resident?.length || 0) + (d.resident || 0),
    evictions: (s.evictions || 0) + (s.memory?.sceneEvictions || 0) + (t.evictions || 0) + (d.evictions || 0),
  };
}
export const TILE_CAP_MIN = 8;
export const TILE_CAP_MAX = 32;
const TILE_STEP = 96 * MIB;
/** Collision/detail terrain tiles kept resident: 8 at the fallback budget, one more per 96 MiB, capped at the wasm limit. */
export const residentTileCap = (budget) =>
  Math.max(TILE_CAP_MIN, Math.min(TILE_CAP_MAX, TILE_CAP_MIN + Math.floor((budget - BUDGET_FALLBACK) / TILE_STEP)));
/** A small body has far fewer tiles to cover than Azeroth, so its near engine always keeps enough tiles (radius ~1200 yd) for a whole grafted 3 x 3 site plus its neighbours. */
export const MOON_TILE_CAP = 16;
export const bodyTileCap = (budget, moon = false) => (moon ? Math.max(MOON_TILE_CAP, residentTileCap(budget)) : residentTileCap(budget));
/** Observer radius whose disc covers `tiles` ADT tiles; 8 tiles gives the original 850 yd. */
export const nearRadius = (tiles, tile = 1600 / 3) => (tiles <= TILE_CAP_MIN ? 850 : Math.round(tile * Math.sqrt(tiles / Math.PI)));
/** Renderer-side bytes (terrain textures, scene meshes/textures, coast water, minimap) from a draw() stats object. */
export const gpuBytesOf = (stats) =>
  (stats?.terrainGpuBytes || 0) + (stats?.sceneGpuMeshBytes || 0) + (stats?.coastalWaterGpuBytes || 0) + (stats?.minimapGpuBytes || 0);
/** CPU-side budget left once measured GPU bytes are charged against the total; never below a quarter. */
export const effectiveBudget = (budget, gpu = 0) => Math.max(Math.floor(budget * 0.25), budget - Math.max(0, gpu));