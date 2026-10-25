# Byte-budgeted residency cache

## Decision
Residency is governed by one byte budget instead of fixed counts. `memory-budget.js` holds the policy:

- `deriveBudget({setting,deviceMemory,heapLimit})`: setting `auto` = min(20% deviceMemory, 30% JS heap limit), else a 384 MiB fallback; clamped to 192 MiB..3 GiB. Numeric settings are MB. The Settings panel select (`#memory-budget`) persists in `localStorage['racer.memoryBudget']`, outside `settings` so world loads don't reset it. `app.applyMemoryBudget()` runs before `client.open()` and on change.
- `splitBudget`: scene 40%, far 15%, terrain textures 20% (rest is headroom for GPU/wasm).
- `ByteBudget`/`BudgetedCache`: hysteresis. Items are admitted until the limit; the first overflow evicts down to 90% (unpinned first, farthest priority first, then LRU), so eviction runs in bursts, not every load. Pinned items are never evicted.
- Streams: `SceneStream.setBudget` (bytes govern; counts raised to `SCENE_CEILING`), `FarStream.setBudget` (distant tile cap 24 -> 96, byte-driven; a tile may only evict tiles farther than itself), `TerrainStream.setBudget` (texture cache by bytes). Message path: `client.budget` -> worker `budget` -> `setMemoryBudget` -> `applyMemoryBudget`.
- Loads stay time-sliced: the existing per-frame job limits are unchanged.
- HUD (`memoryLine`): `cache used/budget MiB · tiles · evict/s`.

## Resident tile cap and radius
Collision/detail terrain tiles are now budget-aware too. `residentTileCap(budget)` = 8 at the 384 MiB fallback, +1 per 96 MiB, capped at 32. The engine (`world-engine.js` `LIMIT`) uses it for the resident set and `scene.limits.nearTiles`; `nearRadius(cap)` widens the observer disc (850 yd at 8 tiles, about 1700 yd at 32) so the extra tiles are actually requested, nearest first, with required support tiles always first. Rust `MAX_RESIDENT` is now 32 (hard cap; wasm rebuilt) and `asset-worker.js` accepts up to `TILE_CAP_MAX` tiles per detail job.

## GPU accounting
The renderer's measured bytes (`gpuBytesOf(stats)`: terrain textures, scene meshes/textures, coast water, minimap) are sent to the worker about once a second (`client.budget(bytes, gpu)`). The engine charges them against the total (`effectiveBudget`, never below a quarter) before splitting shares, and only re-splits when the figure moves by more than 8% of the budget (avoids revision churn). The HUD shows `cache CPU + GPU / budget`. Wasm heap for resident tiles (about 8 MiB per tile) is not charged separately; it is bounded by the tile cap.

## Measurements (5 min muted drive, port 4183, `MEM_SAMPLE=1 BUDGET_SETTING=<MB> node driving-smoke.mjs`)
| setting | resident ADT tiles (old = 8) | far tiles | CPU cache peak | GPU peak | JS heap peak | wasm peak | drive p99 |
|---|---|---|---|---|---|---|---|
| 256 MB (low) | 8 | 5 | 91 MiB | 165 MiB | 144 MiB | 85 MiB | 14.6 ms |
| 3072 MB (high) | 32 | 62-78 | 310 MiB (still growing) | 400 MiB | 250 MiB | 253 MiB | 18.0 ms |

At 256 MB, CPU cache sits at 84-91 MiB, i.e. the budget minus measured GPU (91 MiB), so the cache converges on the budget with GPU charged. At 3072 MB the drive never fills the budget (scenery radius, not memory, is the limit there), so the cache keeps growing but stays far below it. Default (auto) 3x drive check: p99 14.4/14.7/14.4 ms, 0 freezes. Startup, loading and pose smokes pass.

## Not changed / follow-ups
- Scenery coverage radius (`SCENE_LIMITS.radius` 850) is unchanged, so extra terrain tiles beyond it have collision and terrain but no new scenery.
- Without a `budget` message the old limits apply.
- A large budget raises worker memory (wasm about 8 MiB per resident tile); the 3 GiB cap and the deviceMemory default bound it.
- Gotcha: a stale `server.mjs` left on port 4183 makes smokes hit old code and fail with "World worker failed: undefined"; check the port before measuring.