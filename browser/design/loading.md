# Nearby loading and arrival readiness

`loading-gate.js` exports the one `ARRIVAL` policy: four nearest terrain tiles,
eight nearest non-NPC instances and four nearest NPC instances within 128 yards,
a 15-second nearby-readiness deadline, and a 25 ms polling interval. Asset keys
are deduplicated after selecting instance quotas. Empty authored areas require
no invented objects; fewer than four nearby tiles require only the available
tiles. This is a minimum playable neighborhood, not an all-assets barrier.

## Release contract

The worker's `state.arrival` and main-thread `worldEvidence.loading` expose four
checks and `completed / total` progress:

1. Pod support tiles are resident and exact object collision is not waiting.
   Fly arrivals instead require the nearest terrain under the new focus.
2. The exact nearest tile IDs are resident in physics and uploaded in the
   renderer; departure tiles cannot satisfy the count.
3. Visual selection matches the current position, map, placements and asset
   revision. Nearby unresolved WMO roots must expand first. Selected model/NPC
   geometry and its textures must be present in the renderer. These are actual
   meshes, stronger than placeholders; animated poses need not be ready.
4. No required collision asset request remains uncached. A failed required
   request is not counted as successful.

Terrain material layers, remaining scenery, animation, distant minimaps and
exterior/coast water may finish later. Terrain collision admission retains its
authored holes and water behavior; optional water *rendering* is not a gate.
The terrain criterion is geometry, not completion of every terrain texture.

`app-loading.js` owns the existing modal, progress and `app.arriving`. While
arriving, the ordinary frame loop and input-to-worker path are held. Explicit
zero-dt, zero-input `loading:true` frames keep near streaming and GPU material
uploads progressing. The worker independently refuses physics/pod-control
advance and clears accumulated time for these frames. Actor animation/wandering
also pauses. A pre-placement loading frame drains previously queued motion.

The nearby-readiness deadline starts **after mandatory source/pose preparation**.
If the neighborhood is still incomplete (including a stalled readiness reply),
the modal releases with a persistent status warning and `timedOut:true`,
`ready:false`; existing terrain/object collision holds remain in force.
It does not pretend missing collision is safe. Archive opening, engine warming
and the requested restore itself are not cancelled by this deadline: abandoning
an in-flight mutation could teleport the player later. Their existing errors
are surfaced normally. This is not a watchdog for a hung worker or synchronous
decoder; those still require reopening the page/Data source.

## Relocation paths and seamless flight

Initial open, saved-position load, reset, unstuck, map/body/pole teleports,
pose-link restore, race-grid placement, wreck respawn, overview and the moon
camera shortcut use the gate. The race countdown starts only after release.
Cross-body pose restoration is awaited rather than detached from startup.

`soiSwap(id, {seamless:true})` is used only by automatic fly-camera and powered
pod SOI handoffs. They retain their existing swap/adopt/release sequence without
the loading screen. An explicit swap called inside a gated map/pose operation
reuses that operation rather than opening a nested modal. Low-level test RPCs
remain an intentional bypass; user-facing restore hooks use the gate.

## Loading work and ownership

- MPQ sector read-ahead ends at the validated selected packed block, rather than
  reading up to 1 MiB of unrelated following assets for every small extraction.
  The existing 1 MiB maximum remains. A synthetic compressed-block regression
  checks exact bytes read even when the archive has 2 MiB of trailing data.
- Arrival admission prioritizes support and four nearest tiles rather than
  filling the normal larger residency window and cross-frame prefetch first.
  Collision requests still precede appearance requests. Selected arrival
  model/texture/root keys precede other cosmetic demand.
- Far-scene demand, cached/uncached far minimap draining and exterior water
  pumping yield to nearby loading. Normal frames restore their scheduling.
- Asset-worker cap 64, one active asset job and bounded sector inflate lanes
  are unchanged. Scene request counts describe desired assets, not concurrent
  file reads. No new persistent extraction/model cache, OPFS store, duplicate
  mesh representation or dependency was introduced.
- Existing warm memory caches, IndexedDB terrain/minimap caches, source epochs
  and renderer rebind ownership remain. Near selection remains distance-based;
  this change does not add near-camera frustum priority.

## Measured workload

Muted headless Edge, isolated ephemeral port, real authorized local Classic and
SWE1R Data, local NPC pack, fresh browser context, shared `heavy-lock.mjs`.
Baseline served `c0c76fce` with the same locally built Wasm. Reports are ignored
under `test-results/body-swap/nearby-baseline` and `nearby-verified`.
Each teleport phase includes a 1-second dwell and sampling overhead; it is not
pure file IO latency. OS cache state was uncontrolled. Single runs are evidence,
not universal speed or tail-latency guarantees.

| Metric | Baseline | Updated |
|---|---:|---:|
| Initial release | 3,357 ms | 2,799 ms |
| Initial scene instances | 0 | 140 |
| Initial admitted terrain | 8 | 4 |
| Initial Azeroth archive bytes read | 86.5 MB | 38.5 MB |
| Reset phase | 1,095 ms | 1,106 ms |
| Elune arrival phase | 2,252 ms | 2,758 ms |
| Elune north-pole phase | 2,912 ms | 1,590 ms |
| Return-home phase | 1,841 ms | 1,593 ms |
| Azeroth archive bytes through home dwell | 598.2 MB | 172.2 MB |
| Sampled asset queue peak, common phases | 10 | 6 |
| Active asset jobs | 1 | 1 |
| World / source RPC peak, common phases | 4 / 8 | 3 / 6 |
| Worst phase handler p99, common phases | 0.7 ms | 9.6 ms |
| Worst handler, common phases | 69.9 ms | 26.5 ms |
| Main heap peak, common phases | 445.5 MiB | 459.7 MiB |
| Largest individual world Wasm, common phases | 151.2 MiB | 138.3 MiB |

Updated readiness waits: startup 813 ms, reset 27 ms, Elune 1,251 ms,
pole 68 ms, home 102 ms. Every arrival released ready without a timeout.
Elune deliberately waits longer for its nearby scenery instead of releasing
with missing models. Startup scene decoding performed more useful work before
release (22 versus 4 loads); cumulative decode CPU was 12.1 versus 6.1 ms.
Initial terrain-preprocessing slice maximum was 4.5 versus 8 ms; geometry slice
maximum 9 versus 13 ms. This is not a claim that the parsers themselves became
faster: less distant work ran ahead of the release.

The updated extra pose-link and real ramp/powerup flight checks passed;
Elune-to-Azeroth flight took 43.4 seconds with no arrival loading frames during
automatic handoff. Across the run, 111 loading frames carried no nonzero dt or
controls and none ran without the modal. No page/world/console errors occurred;
both runs logged the existing zero-vertex WebGPU draw warning. All tracked
workers were destroyed at teardown. Long tasks remain (192 ms in the common
arrival phases); this is not a complete hitch fix or a memory reduction claim.

Unit coverage includes exact destination readiness, missing textures, unresolved
WMO discovery, selection freshness, bounded quotas, failed critical requests,
timeout warning, seamless bypass, worker simulation hold, critical-first
priority and packed-block read bounds. The smoke exercises held controller
input, not just idle arrivals. Permission prompts, corrupted real installations,
slow-storage distributions and every individual UI relocation were not manually
exercised; mandatory preparation is outside the optional-readiness timeout.
