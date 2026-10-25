# Byte-budgeted residency cache

## Decision
Residency is governed by one byte budget instead of fixed counts. `memory-budget.js` holds the policy:

- `deriveBudget({setting,deviceMemory,heapLimit})`: setting `auto` = min(20% deviceMemory, 30% JS heap limit), else a 384 MiB fallback; clamped to 192 MiB..3 GiB. Numeric settings are MB. The Settings panel select (`#memory-budget`) persists in `localStorage['racer.memoryBudget']`, outside `settings` so world loads don't reset it. `app.applyMemoryBudget()` runs before `client.open()` and on change.
- `splitBudget`: scene 40%, far 15%, terrain textures 20% (rest is headroom for GPU/wasm).
- `ByteBudget`/`BudgetedCache`: hysteresis. Items are admitted until the limit; the first overflow evicts down to 90% (unpinned first, farthest priority first, then LRU), so eviction runs in bursts, not every load. Pinned items are never evicted.
- Streams: `SceneStream.setBudget` (bytes govern; counts raised to `SCENE_CEILING`), `FarStream.setBudget` (distant tile cap 24 -> 96, byte-driven; a tile may only evict tiles farther than itself), `TerrainStream.setBudget` (texture cache by bytes). Message path: `client.budget` -> worker `budget` -> `setMemoryBudget` -> `applyMemoryBudget`.
- Loads stay time-sliced: the existing per-frame job limits are unchanged.
- HUD (`memoryLine`): `cache used/budget MiB · tiles · evict/s`.

## Not changed
- Rust `MAX_RESIDENT=8` collision tiles (`voyage.rs`) and `nearTiles=8` remain the hard cap for collision-critical tiles. Lifting it needs a wasm rebuild; follow-up.
- GPU bytes are shown by the existing stats but not enforced; the budget counts CPU-side cache bytes.
- Without a `budget` message, defaults are the previous limits.

## Risks
- A large budget raises worker heap; the 3 GiB cap and 20% deviceMemory default bound it.
- Peak-memory measurement on a long drive was not done in this step; drive p99 20.6-22.1 ms, 0 freezes (3 runs).
