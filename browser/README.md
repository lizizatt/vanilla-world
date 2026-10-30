# Vanilla World in your browser

A local, single-player **world explorer**, using this repository's Rust racer
physics and ADT/WDT/WDL/M2/WMO/BLP parsers through WebAssembly. This is an alternate
WebGPU rendering adapter, **not a Bevy/VMaNGOS port or a completed singleplayer RPG**.
It does not connect to or modify the native server, database or account system.

## Terrain-material ordering correction

Yielded detail geometry could arrive after its terrain material. The renderer
discarded that early material, leaving a permanently untextured tile. Material
extraction now waits for published detail of the same tile admission; eviction
and source replacement invalidate that permission. Collision admission still
proceeds immediately, without waiting for visual preprocessing.

Isolated Edge reproduction on port 4183 now reaches 8/8 textured flats tiles and
1/1 Tanaris tiles with no dropped materials. The `material-order` both-order
150/300 comparison against `31fd878` covered about 585 yards and 6.10 active
seconds per current run: handler p99 **4.9/4.9 ms** versus **23.5/23.5 ms**,
with **0/0 moving freezes over 50 ms** and no current-run loading holds.
Fresh browser/worker contexts included source-focus preparation; OS cache was
uncontrolled. This is a bounded driving gate, not a universal 20 ms guarantee.
The independently reproduced authored ocean gap predates this async regression
and is not fixed by material ordering.

## Body-swap loading stress

After building the browser, set `WOW_DATA` and `SWE1R_DATA` to your own local
Data directories, then run `node browser\body-swap-stress.mjs` from the repository
root. The harness acquires `heavy-lock.mjs` itself (do not wrap it in another
lease), uses muted headless Edge on an ephemeral loopback port, and creates a
fresh browser context without touching existing saves or port 4173.

The default three cycles mix real map pod teleports with rapid swaps during
loading, followed by four immediate swaps without awaiting worker replies.
Set `SWAP_FLIGHT=1` to also exercise the Elune ramp/powerup flight to
Azeroth and map back. A local NPC pack is served from
`runtime\browser\npc-spawns.json`, or the explicit `NPC_PACK` path; without one,
NPC stress coverage is unavailable. `SWAP_CYCLES` accepts 1–10 and `RUN_LABEL`
names the ignored `browser\test-results\body-swap\<label>\results.json` report.
`SOURCE_REF` optionally serves committed browser JS/HTML/CSS for a baseline;
it still uses the locally built Wasm, so only compare compatible Wasm builds.

Reports include per-phase live worker queues, outstanding RPCs, unresolved
scene demand (not concurrent IO), main-message-handler timing, long tasks,
heap/Wasm high-water sizes, renderer resource estimates, worker targets and
ground readiness. They do not measure driver GPU memory, OS file caches, or
abort an already synchronous decoder. Parked engines retain bounded model
caches but cancel obsolete demand and retire their far/actor/water work;
rebind generations prevent late results from publishing to a new consumer.

Set `NEARBY_LOADING=1` for the initial-load/reset/Elune/pole/home workload.
It holds controller input during teleports, checks the blocking modal and
zero-input worker frames, requires destination readiness, and checks startup
and each phase's message-handler p99 against 20 ms. Current-code runs also
restore a cross-body pose link; `SWAP_FLIGHT=1` verifies that automatic powered
SOI handoff never enters the arrival gate. Reports include each action's
release sample separately from its subsequent dwell.

Initial loading and explicit relocations now use the same arrival gate: resident
support, four nearest terrain tiles, bounded nearest model/NPC geometry and
textures, and no pending required collision request. Automatic flight transitions
remain seamless. See [Nearby loading and arrival readiness](design/loading.md)
for the policy, timeout boundary, scheduling, measurements and limitations.

## Run locally

Use a current hardware-accelerated Edge or Chrome. Every Edge test/probe script launches with
`--mute-audio` so runs never reach the speakers; the AudioContext still runs, so analyser-based
checks (`sound-smoke.mjs`, `hud-smoke.mjs`) keep working. Pass it in any new script too.
From the repository root:

```powershell
.\browser\Build.ps1
node .\browser\server.mjs
```

Open **http://127.0.0.1:4173** and select the **Data** directory in your own Classic
1.12 installation. The browser reads the local MPQ patch chain directly. No
exported terrain pack, login, upload or whole-archive copy into Wasm is needed.
The native directory picker stores only the folder handle in IndexedDB (never
contents or art). On reload it auto-loads if read permission is still granted;
otherwise a **Continue with <folder>** button (a user gesture is required) and
**Choose a different folder** appear. A handle that fails validation or opening is
cleared; **Forget folder** in the footer clears it too. The permission prompt itself
is not Playwright-automatable, so that branch is manually verified. **Choose folder as files**
under **Controls & settings** is the fallback and must be reselected after reload.

If the build reports a missing target or binding generator, install those exact
prerequisites, then rerun it:

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.122 --locked --root .\target-web\tools -j 2
```

Build output stays in this worktree's `target-web`; it does not touch the native
racer cache. The server binds loopback only and serves an explicit file allowlist,
not your Data directory.

## Yielded terrain admission

The browser prepares one ADT at a time outside the frame handler. The shared Rust
parser/mesher advances one MCNK at a time; worker turns stop after 4 ms or sixteen
steps. Placement validation and collision-index construction also yield in
bounded batches. Terrain and its prepared scene index become resident together
in the next frame, never exposing partial collision support. Changed metadata
invalidates the staged index; changing the source cancels staged work.

Required terrain remains genuinely unavailable until publication, without making
the frame await decoding or inventing loading holds. Startup and pose restoration
still await actual readiness. A required tile can preempt optional preparation
after its non-interruptible archive read. Eight detailed tiles, the existing
physics, caches and worker counts are unchanged. The synchronous native API
reuses the same chunk builder and retains its existing behavior.

The 4 ms scheduling budget is not a hard deadline for an individual Wasm call,
JSON parse, allocation or host pause. Render-geometry extraction remains separately
yielded; this change does not add workers, liquid range reads or fidelity changes.
Shell cache v34 includes the staged admission APIs.

Isolated Edge `admission-sliced` gate against `cdeaff6` (including its preserved
original Wasm), forward/reverse execution order, unchanged 150/300 handling:

| Metric | Staged candidate | Baseline |
| --- | --- | --- |
| Active handler p99 | 12.4 / 12.5 ms | 15.6 / 9.8 ms |
| Moving freezes over 50 ms | 0 / 0 | 0 / 1 |
| Active selection maximum | 9.6 / 11.8 ms | 47.3 / 7.3 ms |
| Active terrain-stream maximum | 12.2 / 25.2 ms | 16.6 / 21.6 ms |
| Preparation-inclusive selection maximum | 13.3 / 18.5 ms | 47.3 / 24.8 ms |

Both orders covered about 585 yards and 6.07-6.08 active seconds. They pass the
20 ms p99/zero moving-tail gate, not a strict relative-regression or hard
per-operation limit. Background preparation slices still peaked at 34.9/22.6 ms
including startup; the specific single call or host pause responsible is not
isolated. Separately yielded render geometry peaked at 32.1/42.6 ms.
There were no terrain holds, but real object-readiness holds remained:
254/323 ms over the full trials, versus 253/639 ms baseline.
Fresh contexts do not control filesystem caches or other shared-host activity.

## View-aware distant selection

Far selection now prefers visible known bounds, retaining bounded discovery for
unknown models. A selected instance must fit together with its known mesh, WMO
root and texture dependencies in the existing 32 MiB/96-model/96-texture budget.
Ordinary optional omissions are reported as `budgetOmitted`, rather than treating
a full distant cache as missing world data. Invalid or individually oversized
resources still report errors.

The nearest 24 placement tiles are unchanged, but metadata ahead of the camera
is requested before tiles behind it. Camera turns refresh selection even while
stationary. Near collision demand is not view-culled. Terrain and water draws
use conservative cached bounds with movement/rotation guards; neither residency
nor collision data is culled. A clipped vertical chase view retains a valid
camera basis instead of failing the new camera-metadata validation.

This is fidelity step 1 only: no extra tiles, impostors, terrain morph, admission
fade or color-ring change. Shell cache v35 includes the shared view module.

The `fidelity-rebased-camera` equal-path Edge gate against admission-only
`7c5aa2d` passed in both orders (about 585 yards / 6.10 active seconds):

| Metric | Fidelity candidate | Admission-only baseline |
| --- | --- | --- |
| Active handler p99 | 11.6 / 15.2 ms | 16.9 / 11.1 ms |
| Moving freezes over 50 ms | 0 / 0 | 0 / 0 |
| Active selection maximum | 10.3 / 22.3 ms | 18.6 / 16.0 ms |
| Active terrain-stream maximum | 18.6 / 15.1 ms | 19.6 / 24.2 ms |

The reverse selection still exceeds 20 ms, despite passing the p99 gate.
Including startup, background preparation reached 45.7/18.4 ms and separately
yielded geometry 104.3/38.8 ms. Real full-trial object holds were 612/0 ms versus
253/140 ms; no terrain holds occurred. This does not close startup/all-work
hitches. The earlier restored run failed camera validation; the subsequent run
includes its deterministic clipped-camera regression fix, not an unchanged retry.

Five fixed-pose captures have no browser errors. Compared with the original
analysis snapshots, city distant draws increased from 99 to 307 and the sixteen
distant-capacity errors disappeared. The candidate culled 1,258 terrain/water
draws in that city view and 1,924 at the coast. Sampled dedicated GPU usage was
371-428 MiB, with unchanged residency/cache caps. These are not synchronized
streaming benchmarks: fewer water tiles were loaded in the new captures, so the
lower total draws/GPU usage must not all be attributed to culling. Coarse distant
terrain coloring and the existing ocean ripple aliasing remain visible.

## Readiness-aware visual transitions

A ready far instance remains available until its matching near geometry and
textures arrive, including resource-only updates. New visual admissions dither
in over 350 ms; objects within 128 yards remain immediately opaque. Ordinary
offscreen/re-entry does not restart a fade. Far selection gives retained instances
a 12% prominence preference, without overriding view priority or byte limits.
Detailed terrain blends from its existing minimap/base color into ready layers.
There is no additional resource retention, atlas, tile budget or terrain height
morph. These transitions do not gate physics or collision readiness.

The first transition candidates failed the moving-tail gate. Attribution found
a 64 ms monolithic terrain-material build and substantial selection/post-frame
work. Material construction now advances through the same authored Rust chunk
builder in yielded turns (at most sixteen chunks or 4 ms), before separately
copying its buffers. An exact terrain spatial shortlist replaces the repeated
whole-manifest scan; distance ordering and required-tile priority are unchanged.
Native synchronous material output remains identical. Shell cache v36 requires
the rebuilt Wasm for these material APIs.

Final isolated Edge `fidelity-transition-grid`, against `e7b07ee` with its preserved
original Wasm, used the unchanged approximately 585-yard, 6.10-active-second
segment in both execution orders:

| Metric | Candidate forward / reverse | Baseline forward / reverse |
| --- | --- | --- |
| Active handler p99 | 4.1 / 4.2 ms | 5.4 / 3.8 ms |
| Moving freezes over 50 ms | 0 / 0 | 0 / 0 |
| Active selection maximum | 9.5 / 6.4 ms | 5.5 / 2.7 ms |
| Active terrain-stream maximum | 5.5 / 9.5 ms | 15.7 / 16.7 ms |
| Preparation-inclusive selection maximum | 9.5 / 11.9 ms | 8.7 / 3.9 ms |

Neither order had terrain or object readiness holds. Earlier failed evidence is
retained; this was a changed implementation, not an unchanged pass-seeking rerun.
OS cache and shared-host scheduling remain uncontrolled, so the difference is
not a controlled attribution of every millisecond to the shortlist. The full
trials still recorded a 42.5 ms material-mask copy, 33 ms background preparation,
and 30.4 ms geometry extraction outside this active gate. Individual Wasm copies,
allocations and host pauses are not interruptible; this passes the bounded p99
and moving-tail target, not a hard 20 ms deadline for every operation.
Five fixed-pose Edge captures completed without browser errors; sampled dedicated
GPU memory was 399-457 MiB. Distant terrain geometry/color discontinuities remain
for the separate color-ring stage.

## Runtime loading-screen artwork

After archive indexing, the first archive asset read is
`DBFilesClient\LoadingScreens.dbc`. The previous continent is used when known;
otherwise the first valid authored entry is the default. The selected BLP and
`Interface\Glues\LoadingBar\Loading-Bar{Background,Fill,Border}.blp` are decoded
with the existing BLP decoder. Missing or invalid art produces an explicit
nonfatal notice and retains the art-free screen/native progress bar.

Only the small DBC read is foreground work. Image reads use the existing
preemptible background extraction queue, retry when required world reads take
priority, and stop on dismissal. No worker, MPQ index or decode lane was added.
The images are transferred directly into temporary canvases: no object URLs,
image files, IndexedDB records, service-worker image entries or shipped artwork.
All canvases, including the bar's intermediate surfaces, are cleared on close;
late results are ignored. The accessible native progress element remains driven
by actual stage counts underneath the decorative bar.

Isolated Edge checks verified the DBC was first, actual decoded screen pixels
reached the visible canvas, all three bar parts appeared before entry, Escape
could not expose an unready world, and dismissal/error cleanup removed the
surfaces. The artwork check deliberately does not save loading-screen captures.
Do not record startup video while this artwork is visible; later driving gates
disable video in both variants and retain timing metadata instead.
The local default screen arrived around 0.49-0.78 seconds after folder selection.

Matched first-motion measurements against `c17975b`, in seconds:

| Execution order | Baseline cold / warm | Artwork cold / warm |
| --- | --- | --- |
| Forward | 2.07 / 1.97 | 2.20 / 1.89 |
| Reverse | 2.15 / 2.47 | 2.42 / 2.14 |

Cold entry cost about 0.12-0.28 seconds here; warm results were faster but are not
a speedup claim. Browser/worker contexts were fresh on cold entry; OS file cache
and shared-host load were uncontrolled.

**This artwork checkpoint has an explicitly accepted telemetry-tail caveat, not
a passing strict moving-tail gate.** `loading-local-art` measured active-handler
p99 7.5/6.1 ms, but moving freezes over 50 ms were **1/0**. The forward freeze was
81.6 ms, attributed to an 88.7 ms `world.telemetry()` call after the artwork was
already dismissed. Active selection was 8.7/6.5 ms and terrain-stream maxima
4.7/6.7 ms. A separate, single bounded profile with artwork removed caught a
48.5 ms telemetry pause with a 38.8 ms sampling gap, but did not isolate a costly
Rust surface-sampling operation. That profile is diagnostic, not another gate.
No speculative physics fix or telemetry commit was made; the artwork was
checkpointed under the explicit fallback authorization. Shell cache v37 includes
the new loader module.

## Scheduling-tail profile (no code change)

The occasional 50-100 ms forward tail seen once in the water gate (78 ms in its
baseline too) did not reproduce: a profiled 30 s drive (`PROFILE=1 TRACE=1`,
filtered pack) recorded zero moving freezes over 25 ms (worst main-thread work
2.3 ms, handler/RTT ~2.6 ms), and the four music-gate runs had no tails. With
no isolated cause, no speculative fix was made; the earlier tails coincided
with `VIDEO=1` capture on a shared host. Re-open if a trace shows one.

## World map (M)

`M` toggles a fullscreen `<dialog>` map (Esc, `M` or Close dismisses it; input is paused while open, focus returns to
the canvas). Art is read at runtime from the user's Data and kept in memory only: `DBFilesClient\WorldMapArea.dbc`
(area 0 rows give each continent's WoW bounds: field 1 map, 2 area, 3 name, 4 left, 5 right, 6 top, 7 bottom) and
`Interface\WorldMap\<Continent>\<Continent>1..12.blp`, stitched 4x3 from 256 px tiles by the existing BLP decoder. If
any file is missing the map falls back to a schematic drawn from the manifest horizon bounds, so it is never blank.

Coordinates: the map is drawn in the client's render space, because both continents share one provisional space with
the Maelstrom in the gap between them. A region's WoW origin sits at `K = placement + (32 - tile_origin) * 1600/3`; render
`x = Kx - wowY`, `z = Kz - wowX` (east is +x, north is -z), so a continent image occupies
`[Kx-left, Kz-top, Kx-right, Kz-bottom]`. `toMap`/`fromMap` convert render yards to 0..1 frame fractions. The two
icons are the default spawn (the Steamwheedle raceway, via the existing `reset` path) and the Maelstrom centre
(`maelstromCentre`, via `restore` at +400 yd over the sea). Click, Enter or Space teleports and closes the map. The
blue arrow is the live position and heading. Continent images overlap where the provisional layout does; this is expected.

## Runtime zone music

Zone music is read from the user's Data at runtime and never persisted. The
world worker resolves the car's `AreaTable` id (`Voyage.area()`, sampled at
most every 500 ms) through `AreaTable` -> `ZoneMusic` -> `SoundEntries`
(`music.js`, validated layouts of 25/8/29 fields); sub-areas inherit their
parent's set. A track is only read after the main thread asks for it, as a
background (deferrable) archive read, so it cannot delay first-motion reads. The
page plays the encoded bytes through a media element from a blob URL (no PCM
decode into memory, decoding stays off the main thread), crossfades over 2 s when
the zone's set changes, and after a track ends waits the set's silence range
(`ZoneMusic` silence min/max, 180-300 s for the standard sets) before the next
one. Music follows the Sound checkbox, pauses with it, and has its own volume
slider (session only, 0 = off). The CSP gains `media-src blob:`; blobs are
revoked when a track is disposed. Day/night picks the day/night sound kit by
local clock (in the shipped DBCs both kits list the same files for several sets).

Coverage in the 1.12.1 DBCs (`client/crates/flats-racer-web/tests/music_audit.rs`,
local only): 1,081 areas, 1,021 resolve to music, 60 have none, 41 sets, 118
files, 5 referenced files are missing from the archives. Of 36 ocean-named
areas 35 inherit music; open ocean outside any loaded tile has area 0 and plays
none. Run `node browser/music-smoke.mjs` (needs `WOW_DATA`, server on 4183).
Shell cache v40 adds `music.js` and `world-music.js`.

## Explore

Selecting Data now opens a full-screen, art-free loading view with accessible
stage text and a progress bar. Counts are completed archives, topology files
or horizon tiles **within the current stage**, not an estimated percentage of
time remaining. Unknown-size work is indeterminate. Entry waits for required
near terrain, collision and its rendered detail; it does not wait for all
optional scenery, textures, distant-worker work or water. No physics time is
advanced by this readiness preparation. Errors dismiss the modal and retain
the existing error message. Shell cache v31 includes the loading view.

With `WOW_DATA` set, `node browser\loading-smoke.mjs` records cold-profile and same-profile
warm startup timelines on isolated port 4183. Set `CHECK_SCREEN=1` to also check
modal/escape behavior, real progress counts and invalid-folder cleanup. Warm
means retained browser storage after a twelve-second streaming interval, not
a fully warmed world; OS filesystem cache is uncontrolled. The harness uses
a test-only instrumented nested worker and leaves production CSP unchanged.
Its private JSON traces include archive/source queue times and IDB operations.
The loading-screen-only checkpoint passed 234 JavaScript tests and the
both-order 150/300 driving gate against a fully pinned `24db173` server:
p99 **5.9/5.0 ms** versus **10.0/5.0 ms**, with zero moving >50 ms tails over
about 585 yards / 6.06 active seconds. One cold/warm startup pair measured
**5.53/3.83 seconds to first motion**, versus baseline **3.88/4.14 seconds**.
The screen alone is not a loading-speed improvement; it waits for actual
collision and rendered support instead of exposing an unfinished world.

### Bounded loading overlap

Startup now overlaps required near terrain/collision work with horizon
publication. On browsers supporting background `scheduler.postTask`, horizon
batches yield without the repeated zero-delay timer clamp. Fallback browsers
keep the prior timer yield. All horizon patches, eight near tiles and 24 far
tiles retain their existing budgets and readiness rules.

The single archive owner also overlaps **two sector inflaters** within one
full-asset extraction, retaining the single MPQ index and read window.
Combined sector output stays within 1 MiB; required requests still preempt
optional work between batches, and failed/cancelled batches drain before the
next asset. This is not two independent full-asset/texture decoding workers.
Shell cache v32 includes these changes.

The isolated Edge cold/warm audit found:

| Path | Measured serialization and decision |
| --- | --- |
| Archives/topology | One index mount and ordered topology reads retained. Baseline open 426/300 ms and topology 150/166 ms; final sample 122/109 ms and 101/93 ms. Cache/host variation also affects these figures. |
| Horizon/near terrain | Baseline horizon publication occupied about 2.3 seconds before the first ADT request. The optimized timeline requests the ADT during publication; publication took 165/94 ms in that sample. |
| MPQ sectors | Real overlap peaked at two inflaters / 8192 declared output bytes; archive index remained 13,089,776 bytes and read window 1 MiB. |
| Textures | Decode/mip construction remains serialized in the asset worker. Largest observed texture stage was 11.5/12.3 ms; another Wasm/index owner is not added. |
| Models/WMO and terrain parsing | Admissions remain serialized on their owning near/far workers to preserve collision and residency ownership. Startup/early-streaming ADT admissions still reached 31.5/31.7 ms in a follow-up trace. |
| Water/far work | Existing independent consumers retain one staged read each, background priority and bounded transfers. At twelve seconds after first motion, cold water loads increased from 47 to 100 and far residency from 20 to 24. |
| IndexedDB | One shared connection and asynchronous per-record transactions retained. Largest sampled completion wait was 11.3/14.0 ms, not synchronous main-thread work. |

Across two optimized cold/warm pairs, first motion was **1.04-1.36 seconds
cold / 0.96-1.13 seconds warm**, versus baseline **3.88/4.14 seconds**.
The last pair included additional terrain-parse tracing. These are bounded
shared-host samples, not OS-cold disk benchmarks. The twelve-second samples
held 25.3/27.5 MB of near scene data and 9.6/10.0 MB of far scene data, with
48.5/59.4 MB of sampled main JS heap; these are not total process peaks.
Near/far Wasm high-water samples were 87.6/12.9 MB (cold); source Wasm stayed
1.9 MB. More already-loaded scenery uses more of the unchanged resident budgets.

Final two-lane 150/300 equal-path gate against fully pinned `24db173`:
**p99 5.1/4.8 ms**, zero moving >50 ms tails and no loading holds over about
585 yards / 6.06 active seconds. Baseline p99 was **4.6/4.3 ms**:
the approximately **0.5 ms regression was explicitly accepted** under the
20 ms p99 target, rather than represented as a strict no-regression pass.
Four inflaters were rejected after a larger relative p99 regression.
Maximum active handlers were 15.9/23.1 ms; selection including preparation
21.6/12.7 ms and active terrain admission 7.4/13.5 ms. This does not promise
every task under 20 ms or eliminate all serial loading/pop-in.

236 JavaScript tests, 77-file native/Node/Edge byte parity, loading/error checks
and v31-to-v32 offline upgrade passed. `ASSET_PORT=4183` selects the isolated
port for `asset-smoke.mjs`. Private timelines, the rejected four-lane comparison,
and the explicitly accepted two-lane gate remain under `test-results`.

You start on actual raceway terrain in `Kalimdor_39_43.adt`, in Thousand Needles.
The spawn height comes from the ADT, not a guessed sea-level floor.

| Mode | Controls |
|---|---|
| Pod drive | W thrust, S reverse, A/D steer, Up/Down arrows pitch, X brake, J hop, Shift boost, Space/C drift, F cockpit, V look behind, F9 reset |
| Pod standard controller | Left stick X steers, Y pitches (pull down = nose up); RT (7) accelerates minus LT (6) reverse thrust; bottom face (0, PS X / Xbox A) boosts; left face (2, square / Xbox X) drifts; RB/R1 (5) hops; right stick looks/clicks cockpit; D-pad chase zoom; Y/triangle resets; Start drive/fly |
| Chase camera | **Left-drag** orbits the camera independently of heading and it stays where left (no snap-back; it recentres only while you drive with keys/pad). **Right-drag** steers: the camera keeps its heading and the craft turns toward it. **Both buttons** steer and thrust forward. Left/Right arrows orbit in pod drive, wheel zooms |
| Free flight | W/S forward/back, A/D strafe, Q/E altitude, arrows look, Shift fast |
| World overview | Frames both complete coarse continents |
| Return to vehicle | Returns to the parked hovercraft; does not teleport it to the flight camera |

Click the view to capture keyboard input. Flight is deliberately collision-free.
**Save** stores the parked vehicle, flight camera, mode and display
settings. **Load** restores them; **Reset** recovers without
overwriting a saved pose until you explicitly save.
Display switches do not disable collision.
**Controls & settings** keeps the existing **Space key** choice: drift (default) or
brake (legacy saves; drift stays on C); J always hops, Ctrl is no longer a drift key (Ctrl+W closes the tab). **S reverses and X brakes in both profiles**,
matching the controller's signed throttle without applying brake to reverse.

The pod mapping is class-based, including the Data Rocket skin; free flight and
other vehicle classes keep their controls. Left-stick axes have an axial 0.15
deadzone and a mild cubic response; triggers retain their 0.08 deadzone and analog
scaling. Holding LT at rest backs up; simultaneous triggers subtract.
Pod pitch input is inverted for both devices: ArrowDown / stick down raises the
nose; ArrowUp / stick up lowers it. One input-level `POD_PITCH_SIGN` controls both;
physics and free-flight/camera conventions are unchanged.

Pitch targets ±20 degrees and eases at 8/s in the authoritative fixed-step physics
(including digital keyboard presses), returning level on release. Forward, reverse
and boosted engine thrust follow that pitched axis; reverse reverses its vertical
component too. Gravity, support rays, hover springs and contact resolution remain
world-vertical. Bank remains cosmetic. The speed cap and drift grip remain
**horizontal**; neither deletes jump/fall momentum. X/legacy Space remain the
existing non-engine handbrake. Pitch is telemetry slot 17, appended after engine
health; the confirmed-pose renderer interpolates it, with no separate main-thread
physics predictor. Craft, cockpit and exhaust transforms share this attitude.
Reset/load returns the parked pod level. Vertical collision readiness includes
pitched acceleration before the worker advances.

**Climb math, unchanged defaults:** browser thrust is 50 + 30 boosted yd/s²;
airborne authority is 0.9. At 20°, upward engine acceleration is 24.625 yd/s²
boosted or 15.391 without boost. Azeroth gravity is 48; Elune is 24 (0.5x).
Thus unsupported Azeroth boost still accelerates downward by 23.375 yd/s²;
Elune boost accelerates upward by 0.625. There is no artificial altitude ceiling.
The existing bar measures **heat, not finite boost energy**: cold-to-full is 7.5 s,
boost remains available afterward, and default durability wrecks continuously
overheated engines at approximately 18.2 s from cold (0.15/s damage split 60/40,
not the earlier 13.8 s estimate). Disabling durability/overheat changes
that safety assumption; this change does not add a cutoff or retune it.

Deterministic 120 Hz trajectories (`voyage/tests.rs`, 60 s observation) measure:

| Launch assumption | Azeroth apex Y | Elune apex Y |
|---|---:|---:|
| 7 yd/s hop from Y=3; release boost when heat fills | 4.019 | 80.999 |
| 300 yd/s horizontal, 400 yd-long 35% ramp from sea level, hop at lip; release boost when heat fills | 407.648 | 1539.839 |
| Same, extreme but collision-admitted 140% ramp | 3966.619 | 13940.477 |

Ramp tests traverse actual triangle support/collision; they assume an already-built
300 yd/s approach, not a launch from rest. They are fixtures, not a claim that those
ramps exist in the authored maps. The ramp consumes 1.342 s of the heat window.
Horizontal speed does not cap terrain-generated vertical launch momentum, so
these are **not universal altitude bounds**: a sufficiently high/steep ramp can
cross Azeroth's atmosphere band despite the downward acceleration. The rendering
atmosphere edge (1711 yd) and cloud base (1316.8 yd) are already below Hyjal's
1971 yd summit. Full space rendering starts at 5193 yd on Azeroth; Elune's SOI
exit is about 20110 yd above its surface. A 60 s unlimited boost after the extreme
Elune ramp reaches 27263.5 yd in the numerical model, but requires surviving
overheat. Ordinary pod motion retains that local law. Pickup-powered ramp
departures now support ballistic SOI handoff as described below; free flight is unchanged.

**Placeable launches:** press T for the track editor's launch panel. Place a
15/25/45/90-degree curved ramp or a pickup granting **15 seconds of actual boost
use**, then rotate/delete saved objects independently of the track. Placements
persist per body/installation. Reset/restore/reopen clears charge and respawns
pickups, but keeps placed objects. ArrowDown / stick down raises the nose.
With charge, launch attitude remains stabilized until the charge is exhausted,
then eases to normal +/-20-degree input in the retained launch control frame.
Powered boost supplies **172 yd/s² total**, replacing ordinary thrust/boost,
not stacking with them. Heat and overheat damage build normally; the current
60/40 engine-damage split lets a cold full burn survive without an exemption.
When the charge runs out, the held button uses ordinary boost under its
regular engine speed governor. Coasting momentum and gravitational acceleration
are not speed-clamped; coast is ballistic, not free-camera movement.
SOI transitions retain the full attitude and metric chase/cockpit frame; the pod
and engine effects render rigidly in camera-relative coordinates, not through
per-vertex globe bending. Manual map teleports clear both workers' journey/charge
and cached snapshots, preventing a stale automatic handoff from swapping back.

Load local Azeroth Data before traveling to Elune, so both resident worlds are
available. A 90-degree launch just outside the base reaches Azeroth on a full
15-boost-second burn, including real body handoff and return to normal ground
physics. The other ramp angles can escape Elune but miss Azeroth; no angle
cutoffs were added. Ordinary, uncharged ramps retain constant-gravity local
physics and cannot enter orbital mode. No ordinary defaults or altitude ceiling
were changed. See [the launch design and measured results](design/pod-launch.md)
for exact launch assumptions, numbers, persistence semantics and limitations.

Run `node browser\pod-controls-smoke.mjs` with read-only `WOW_DATA` and `SWE1R_DATA`
paths. It owns an ephemeral loopback server and the machine heavy-job lock, checks
synthetic standard gamepad input through the real worker/Wasm on the Data Rocket
and an Elune SWE1R pod, and asserts moving-frame p99 within 33.33 ms. The local
reference run measured 7.1 ms p99 on both bodies; the gate now requires 30 s of
actual movement during a 40 s forward/reverse run on each body. Max tail spikes are
reported but not gated. Ignored results/screenshots are in
`browser\test-results\pod-controls`.
A short hop tap survives an in-flight worker request or a zero-step frame.
Its discrete edge is acknowledged after one fixed-step attempt, not held until
landing; pause, reset, source and flight transitions discard unsent edges.
Loading-readiness holds preserve the edge until physics resumes.
Gamepad inputs use standard browser mappings,
deadzone rescaling and press edges; disconnect, lost focus and editing controls
clear thrust instead of leaving a stuck accelerator. Held keyboard controls take
precedence over concurrent controller activity, including S reverse and X brake;
controller view/mode press edges still work, and driving activity can take over
again after release. Flight retains keyboard
movement, with right-drag look.

The amber/teal instruments show actual signed motion, airborne/hold state and
boost (engine heat). The visible **Sound** control enables an original low twin-engine
core, filtered stereo airflow and a building/releasing boost wash through three
reused Web Audio voices. Pitch/load follow actual speed and controls; collision
holds release thrust/boost rather than suggesting forward acceleration.
Airborne, actual water contact, lift/landing and brake edges subtly change the
same layers without spawning extra sounds. There are no sampled game sounds,
music or audio dependencies. Sound is opt-in and its saved on/off preference is
preserved, including when resuming fails. **Resume sound** is shown when an enabled
preference has no running audio context; actual errors stay visible next to it.
Canvas clicks/keys can also retry. Ordinary toolbar/help focus no longer silences
the foreground engine. Flight, editing, backgrounding and explicit mute still
pause it; returning focus retries an existing wanted context without unmuting a
saved-off preference. Output-device audibility is not inferred from analyser RMS.

The default view keeps driving instruments and folder/save/sound/flight controls.
Instructions and configuration are collapsed under **Controls & settings**;
stream/cache counters update only while **Diagnostics** is open. Actual loading
failures remain separately discoverable under **Loading issues**.

The game fills the browser's entire content viewport, without requesting OS
fullscreen or reserving space for panels. Buttons and compact text/instrument
groups have a 20% black backdrop, with fully opaque text, text shadows and thin
control outlines. Buttons inside a shaded group do not add a second dark layer.
Unused overlay space and
the HUD pass pointer input through to the world; interactive controls remain
focusable. Expanded help/settings scroll within a bounded overlay. Handling stays
modal with a transparent backdrop. Editing ignores driving input but does not
apply the brakes; the vehicle can coast.
The existing renderer follows live canvas size/aspect and caps backing DPR at 2.
For example, a 1280 x 800 content viewport now draws 1280 x 800 at DPR 1, rather
than the old 1206 x 534 inset canvas. Earlier smaller-canvas performance results
below are **not full-viewport FPS guarantees**.
The viewport check covers the observed app content size (676 x 1315), 1280 x 800,
360 x 640 and 640 x 360, plus DPR 2.5 capped to 2. It checks live projection aspect,
zero page overflow, HUD/unused-overlay pointer pass-through, orbit, keyboard focus
and exact single-layer 20% black compositing under controls, while unused overlay
space leaves scene pixels unchanged. Bright-coast and dark-terrain screenshots
cover readability without changing the existing layout.
Evidence is local under `test-results/viewport`; controls, sound recovery and
offline saves also pass at full viewport with shell cache v20. These are functional
checks, not a new performance benchmark or an OS-fullscreen test.

The player craft resolves local display **10318** and renders its authored M2 and
textures independently of scenery visibility. Its weighted **Stand frame 0**
(absolute animation time 3333 ms) is baked once, preserving the chassis and embedded
goblin's separate root transforms; it is not a guessed model yaw. This is a static
Stand pose, not live animation. A temporary body remains while loading or after an
explicit craft error, and the craft is hidden during free flight. The mount's raw
and posed attachment 0 are available, but do not supply a selected rider's head
height or an animated cockpit.

**F**, the **Cockpit** button, or a right-stick click toggles functional first
person. Its eye uses that actual posed attachment plus **0.75 model units along
local up**, transformed with the same scale, heading and bank as the craft.
It uses exactly the same presented craft pose and transform, without an independent
position filter. The body-to-eye segment is checked against existing camera
collision data without moving the eye away from the seat. The entire player
craft, including its embedded goblin, is hidden to prevent self-geometry blocking
the view; world scenery remains visible. Right-drag, arrows/right stick and V
retain look controls. Wheel, D-pad or distance-slider zoom returns to chase.
Fly parks the craft; F returns to cockpit. Reset preserves the view preference,
and Save/Load retains it (legacy saves default to chase). Missing seat metadata
falls back to chase with a short error; this is not exact native avatar-head parity.
Blocked or unresolved camera geometry temporarily clears the world view and shows
a short status, while controls and the requested cockpit mode remain available.
The camera stays at the moving seat and recovers automatically when clear; it never
retracts, switches to chase, or freezes an old world frame. Unresolved bounds are
reported as pending, not as proven physical obstruction.

`node browser\cockpit-smoke.mjs` uses the normal app route and actual Edge input.
It captures before the first draw and covers seat-relative eye positions in motion/mode/rebase/resize cases,
look/back, keyboard/button/controller toggles (including while W is held),
self hiding, focus, sound recovery,
and cockpit/mute preferences across offline reloads. S produces **actual backward
displacement from rest**, not only a signed HUD value, in default, active-controller,
native-reload and legacy-reload cases; opposing keys, release and X brake are checked.
Local screenshots and JSON live under `test-results/cockpit`. Controller readings
are injected through `navigator.getGamepads`; physical hardware is not automated.
The first run exposed controller activity stealing a held X brake, retained under
`before-brake-priority.*`; held-key precedence fixes it. `npm --prefix browser test`
automatically discovers all JavaScript unit suites, including cockpit coverage.
Its additional clearance fixtures check fresh GPU clearing, a moving exact seat,
and automatic recovery. Real Rust ocean driving checks chase offsets through
500 yd/s acceleration/turning and reverse; a labelled render-only 8 Hz displacement
checks vertical jitter attenuation without changing authoritative physics.
Full-viewport checks preserve transparent unused areas and single 20% black control backdrops.

The cache-v26 integrated gate passes 49 native and 148 JavaScript tests plus the
matching-Wasm roof/ceiling/rebase checks. Edge 155 recorded 4,160 focused camera
frames with no hidden frames or GPU errors: maximum seat-transform error
1.44e-14 yards and unobstructed chase-offset error 2.96e-14 yards, including real
500 yd/s forward/reverse motion. The calibrated vertical input span of 0.300 yards
became 0.020 yards of camera motion; look pitch is damped consistently too.
Four separate cold startup/reload cases retained 2,811 focused draws and stable
default/tuned spawns. This measures camera attachment and onset correctness,
not a hitch-free or maximum-frame-latency guarantee.

**Handling** edits the 17 existing Rust physics parameters plus **Chase damping (s)**.
The existing persisted `cameraSeconds` field now damps local distance expansion and
grounded vertical suspension jitter, not world translation or cockpit position.
Vertical compensation is bounded to 0.35 yards and clears for jumps, holds and
resets; heading and translation stay relative to the current presented vehicle.
Rust validates the complete physics set; successful writes persist in
a separate per-install tuning record without overwriting the saved vehicle pose.
Failed storage leaves active handling unchanged. There are no gameplay upper
ceilings, but values must fit finite f32 physical domains, and extreme combinations
can fail simulation explicitly. Opening Handling does not apply the brakes.
Form typing and controller input cannot drive while it is open; ordinary
window-blur/visibility safety and the explicit X brake are unchanged.
Camera zoom is separately limited to 0-50 yards. Desired and damped local chase paths
are clipped against loaded ground and the shared collision BVH. Clearance contracts
immediately and expands with the selected damping. There is no accumulating
speed-dependent follow distance. The 50-yard query bound is not a world draw-distance limit.

Current browser defaults, requested from the user's Handling screenshot, are:
cruise/boost **150/300 yd/s**, thrust/extra boost thrust **50/30** yd/s (saved tunings still holding the old 1000/250 boost values are migrated once) and yd/s² (boost was 300 and 50 before), braking 30,
drag 0.25, turn rate 2.2, turn response 10, grip 8, drift grip 1.5, drift turn
multiplier 1.3, hover height **3 yd**, spring 90, damping 18, gravity 48 (saved tunings still at the old 24 are migrated once; customised values stay), hop speed
7, air control 0.9 and chase damping **0.5 s**. Fresh Rust worlds (`voyage.rs` defaults) and Restore
defaults agree. Existing saved handling overrides remain authoritative; Reset
retains active handling. Shared native-client physics defaults are unchanged.
Historical performance measurements below used the former 36/50 yd/s defaults,
not these new speed caps.

### Elevated obstacle clearance

Airborne forward thrust and boost use the shared Rust air-control multiplier;
boost is unlimited while held (heat is the only limiter) and respects braking, reverse and speed caps.
Neither supplies vertical lift. In the browser, loaded authored holes now mean
absent support during flight rather than freezing the entire falling vehicle.
Flight above known impassable terrain is allowed only beyond support reach.
Grounded hole/impassable guards, unloaded tiles, world boundaries, hull sweeps
and save validation remain strict. Native uses the same propulsion code and
already passes optional support probes to it; no native controller change is needed.
`node browser\airborne-smoke.mjs` (with `WOW_DATA` and an isolated 4183 server)
checks actual Edge keyboard thrust/boost from rest during a 100-yard-high fall.
Rust fixtures separately cover full/partial authored holes, impassable terrain,
unloaded tiles, world boundaries, collision rollback and strict save restoration.

The `airborne-thrust` both-order gate against `b4ed49b` uses the same filtered
population, 150/300 handling and video-disabled capture in both variants.
Across the common 585-yard segment (over six active seconds), handler p99 is
**2.1/2.7 ms** (baseline 2.7/3.0), moving >50 ms tails **0/0**, worst active
selection **5.1/2.9 ms** (including preparation 5.1/5.4), and active terrain
admission **0.9/0.8 ms**, with no readiness holds. Actual Edge keyboard checks
reached 24.25 yd/s under ordinary airborne thrust versus 47.84 with boost while
falling 4.03/4.14 yards; heat rose instead of staying cold.
The shared Rust and browser suites pass 79 tests; the native Bevy executable
was not launched.

The support-edge guard previously stopped any per-probe rise of 0.6 yards,
even when the obstacle was well below an elevated vehicle. It now permits
such a rise only below the entire swept hull's **0.5-yard half-height**.
Real mesh/bounds collisions, protruding terrain, missing geometry, grounded
hole guards, floor correction and the independent presentation timeline are unchanged.

Actual Edge reproduction used the supplied rounded Gadgetzan coordinates
(-1055 E, 6446 S) and the requested handling. Live Y/heading were unavailable:
ground+3 overlapped authored geometry and was explicitly rejected, so matched
before/after runs started at the verified clear Y=41.8907 (ground+6). Three
directions previously stopped after 55.10, 0 and 1.28 yards with repeated
steep-support rejects, zero solid sweeps and zero collision-readiness waits.
They subsequently covered 171.22, 110.95 and 166.59 yards with no steep-support
rejects; the middle route correctly stopped on a real mesh collision.
The old scene-capacity indicator was not the blocking reason in these runs.

`obstacle-smoke.mjs` also checks an isolated low-platform/true-wall fixture,
Handling-open coasting and key isolation, saved override reload, Restore defaults
and explicit braking. For before/after comparison it requires the local pre-fix
`8b0fb5f` Wasm saved as `test-results/elevated-obstacles/before.wasm`; this generated
binary and the evidence are deliberately untracked. Run against an isolated
server with `WOW_DATA` and `BASE_URL=http://127.0.0.1:4183`.
This is not a strict all-world hitch or high-speed-route acceptance.

**Load** prepares destination terrain and the stationary support column before
committing the vehicle pose. Authored bridges are queried at the **saved Y**, not
the old vehicle height. Rust checks finite state, the same floor clearance used
by driving, and occupied hull geometry; it does not impose the old floor+20-yard
ceiling on legal high-hover or airborne saves. Invalid restoration leaves the
old vehicle state intact and restores old scene demand. If that recovery cannot
read previously available terrain/collision, it reports the recovery failure
explicitly rather than moving the vehicle or inventing empty ground.
Persisted handling loads before the saved pose, and outgoing saves are validated
before overwriting IndexedDB. Native tests cover hover30, airborne height2000,
bridge-over-hole support, billion-yard origins, occupancy and atomic rejection;
worker/scene tests cover destination read ordering and failure recovery.
`node browser\save-smoke.mjs` exercises legal hover30 save/offline reopen and
preservation of the previous record after an injected invalid outgoing snapshot.

Save keys include layout version 3 and an SHA-256 fingerprint of ordered archive
metadata. This is not a full-content archive hash. Different installations/layouts
do not silently relocate one another's saves. Legacy racer/voyage IndexedDB
databases are left untouched; old demo entrypoints are no longer the app.
The service worker caches the app shell and, when present, the private NPC
companion for offline use. Local Data access is still required offline.

## World and streaming boundaries

Both complete authored WDL continents stay resident, at original scale and
orientation. On the tested installation they contain **1705 patches, 929225
vertices and 1745920 triangles**, about 26.3 MB of GPU payload. Kalimdor and
Eastern Kingdoms are separated by **8192 yards** between authored bounds.
Eastern Kingdoms is shifted **11200 yards south**, half its WDL north/south extent.
This is provisional map layout, not canonical ocean geography.

Detailed ADTs stream around the driver or flight camera. At most
**eight** are resident: all support/swept-query tiles are pinned before eviction,
including four-way corners. Prefetch is lower priority. An expected but missing,
corrupt or still-loading ADT blocks driving; it never becomes substitute ocean.
Only successfully parsed WDT absence connected to the map exterior can add
exterior ocean, and contradictory WDL land remains unavailable for driving.
WDL supplies no collision. Below-sea land, including the raceway, is retained.
Authored MCLQ supplies detailed inland water.

Loaded ADTs replace their WDL patches atomically. Edge strips bridge coarse/detailed
height differences visually, not physically. Both use real projected depth;
coarse terrain can still produce visibly angular cliffs and shorelines.

### Authored distant water

The large offshore "curtains" in the coast captures were predominantly exposed
coarse seabed, not the ADT/WDL edge strips: the Tanaris sample contains authored
underwater drops of 515 yards, versus a 29.14-yard maximum detailed edge strip.
Removing the strips did not remove those curtains. Distant water now uses
authored MCLQ coverage and heights; WDL positions, coastlines, holes, exterior
ocean topology, fog and physics are unchanged. The visual-only boundary backing
exception below supplements certain authored-dry ocean cells.

`WaterStream` reads one local ADT at a time, then runs a
header/liquid-only Rust scan after the physics reply. It does not instantiate
terrain, collision, textures or placements. Root framing, MCNK headers and
MCLQ offsets/grids are checked; unrelated ADT payloads are intentionally not
validated by this scanner. Existing liquid meshing preserves wet/dry masks and
kinds. Only Still/Ocean surfaces are rendered, as in the detailed adapter.
Exactly flat wet-cell rectangles are merged; holes and non-flat surfaces remain.
Nearby tiles lead, followed by likely coastal tiles and then remaining inland
tiles. WDL samples at/below sea level are only read-order hints: they never
create water or modify authored masks.

Optional reads yield in one-millisecond sector-work slices at background task
priority where supported, with a timer fallback. They defer between sectors
when required foreground asset reads queue, retaining one serialized extraction
buffer. Optional scenery and far minimaps share background priority rather than
indefinitely starving water. There is no per-file 50 ms delay; one later
post-physics parse/upload and one pending cache write remain the bounds.
Deferrals are counted and retried, not shown as corrupt assets. Real source or
parse errors remain visible and retryable. Mode/focus changes reorder unresolved
work without rescanning completed tiles; source replacement cancels publication
from the old stream. Startup and physics never await completion of the water map.

The fixed **64 MiB** cache holds all **1301 wet tiles / 50,326,920 bytes
(48.0 MiB)** of authored water in the tested installation; boundary backing adds
32,424 bytes, for **50,359,344 bytes** total. The 404 dry tiles need no GPU geometry.
This is not a process-memory limit: the one source file (maximum 64 MiB),
Rust parsing and upload copies, main-thread/driver storage and up to eight
overlapping detailed-water tiles are additional. Detailed admission suppresses
the corresponding authored distant water atomically; eviction reveals it again.
Visual boundary backing remains visible across that transition, sharing the same
bounded GPU buffer rather than duplicating it.
Other installations exceeding the cache retain nearer water and report the
capacity limit rather than claiming full coverage.

Coverage is progressive on a fresh installation/browser profile. Compact
validated liquid geometry (including exact empty/dry tiles) is stored under
`liquids:2:<install fingerprint>:<region>:<x>:<y>` in the existing IndexedDB
object store. Reloads reuse it without ADT extraction. Saves and handling
records are separate and unchanged. Cache damage or unavailable persistence
produces an explicit notice and falls back to authoritative Data reads.
The cache version must change when the liquid meshing format changes.
A full uncached scan returns
2,111,901,065 decompressed ADT bytes for this installation. Aggregate archive
range-read counters also include minimaps, scenery, terrain and deferred reads;
they are not water-only compressed-byte counts. Coarse land silhouettes remain,
and unscanned far water can still
show exposed seabed until its authored data arrives.

### Shared shoreline water shader

Terrain MCLQ and WMO MLIQ Still/Ocean surfaces share the same shallow-to-deep
colour ramp, Fresnel/sky reflection, filtered moving normals and a narrow,
animated foam band. The ramp is **authored opacity/colour information, not
physical depth in yards**. The surface stays opaque to imply depth without
adding seabed geometry, refraction or a scene-colour/depth render target.
Foam gently advances/recedes in the shader; there are no displaced waves,
shoreline simulation or new collision/physics surfaces.

One original procedural 128-square normal texture, including all eight mip
levels, costs **87,380 GPU bytes**. Explicit texture gradients and a
160--1,500-yard detail fade replace the old directional sine stripes. Wave
coordinates retain their phase across floating-origin changes. The existing
64 MiB far-water, scene triangle and scene byte budgets remain enforced.
Authored shoreline colour/foam fades to deep water over 350--700 yards;
far water retains its compact geometry and existing cache format. Preserving
every distant ramp exceeded the water cap after about 150 tiles, so that
approach was rejected rather than sacrificing complete distant coverage.

Stormwind canals previously lacked browser geometry: their water is in WMO
groups, not terrain MCLQ. Those groups now append visual-only opaque batches
through the existing scene loader and budget. `Stormwind_099.wmo` has 52 wet
cells, 36 holes and 108 liquid vertices; its collision export is unchanged.
`Stormwind_000.wmo` has no water and gains no batch. Inland terrain water,
including Crystal Lake (`Azeroth_32_49`), uses the same shader. Lava/slime,
authored dry holes outside the approved exterior exception, and unavailable
or not-yet-loaded water are not filled speculatively.

**WMO water is rideable.** Still/ocean WMO liquid (Stormwind canals) is also exported as a
separate water-surface triangle set (`water_vertices`/`water_indices`, never solid collision)
and fed to the physics through `set_scene_water`. The surface rule matches ADT water
(`max(ground, water)`, loaded tiles only, strict saves unchanged). A canal probe sank to the
bed before (y 88.9) and now rides the surface (y 98.5).

With a separately started isolated server on port 4183 and `WOW_DATA` set,
`node browser\water-smoke.mjs` checks actual Edge shader execution, captures
lake/coast/canal/high-ocean views and asserts that canal batches reach the
shared shader. It records only ready-world screenshots and numeric evidence
under ignored `browser\test-results`; it never records the loading artwork.

**Approved exterior-boundary exception.** A reproduced 25-yard slit in
`Kalimdor_44_37`, MCNK `(15,2)`, also occurs on `31fd878`. Each MCLQ row is
`[1,15,15,15,15,15,15,1]`: six authored-dry cells between ocean cells. The
MCNK base is -503.434 yards, but its dry-strip MCVT offsets put the terrain
exactly at sea level, not deep underwater. A visual backing now fills only
eligible dry cells; it never modifies MCLQ masks, terrain or collision/physics.

Eligibility requires an Ocean MCNK without terrain holes, flat sea-level
MCLQ vertices, only Ocean/dry cell kinds, and a fully wet outward edge next
to an absent-WDT tile in the verified exterior-ocean geometry. Normally every
terrain vertex in the chunk must be more than 32 yards below sea level.
The narrowly authorized exception also permits a dry cell whose four corners
and center are at/below sea level within **0.01 yard**, bounded on both sides
along a row or column by ocean cells, with a wet-cell path from at least one
of those bounds to the exterior. Inland/non-exterior cells, lakes, above-sea
terrain and unbounded shallow dry areas do not qualify. Adjacent accepted dry
cells are compacted into rectangles without overlapping authored wet cells.
The native parser and physics retain the original dry coverage.

Isolated Edge captures confirm that the former sky-through slit has backing,
both at altitude and after detailed tile admission; 232 JavaScript tests include
the real cell's synthetic flag/height pattern and negative coverage. Complete
coast/rebase/offline checks retain all 1705 records within 64 MiB, with a
7.3 ms maximum uncached water parse/backing stage. Cold coverage still took
104.9 seconds from source open; cached offline coverage took 26.9 seconds and
1705 cache hits. Neither is instant first-load coastal coverage.

The `ocean-backing` both-order 150/300 gate against `31fd878` covers about
585 yards / 6.10 active seconds, with source-focus preparation, fresh contexts
and uncontrolled OS cache:

| Measurement (forward / reverse) | Current |
| --- | --- |
| Active handler p99 | **5.8 / 4.6 ms** (baseline 27.6 / 23.9) |
| Moving freezes over 50 ms | **0 / 0** |
| Collision selection maximum, including preparation | 15.9 / 15.6 ms |
| Terrain admission maximum during active segment | 9.9 / 13.1 ms |
| Active handler maximum | 23.1 / 22.2 ms |

There were no current-run terrain/object loading holds. The p99 gate passes,
but not every task fits 20 ms: cumulative background visual slices reached
23.3/30.4 ms and geometry slices 28.3/12.6 ms through the segment. This is not
universal hitch-free acceptance. Existing procedural water stripes/moire,
unlocated tan strips and other unknown-pose slivers remain unverified.
Shell cache v30 refreshes the offline modules; prior derived-water rows are
left untouched, while save/tuning keys and records remain unchanged.

The earlier `8b0fb5f` Edge capture completed all 1705 scans in **146.4 seconds online and
148.4 seconds offline**, with 302/312 foreground deferrals and no water errors.
Aggregate archive ranges returned 4.245/4.252 GB; liquid parse wall-time maxima
were 5.7/3.9 ms. Worker Wasm high-water memory was 57.25 MiB. The instrumented
page reported about 57/82 MiB of JavaScript heap at completion, not a measured
process-memory peak or a sum including all GPU/driver allocations.

The local coast check requires complete coverage, compares both coasts at
900/120-yard heights, exercises approach/retreat and render-origin rebases, and
repeats full coverage offline with matching payload sizes and boundary samples:

```powershell
$env:BASE_URL = 'http://127.0.0.1:4183'
$env:LABEL = 'after'
node .\browser\coast-smoke.mjs
```

`test-results/coast/after/geometry.json` and adjacent screenshots are private
evidence, not assets to publish. The ignored native
`whole_continent_liquid_budget` test performs a sequential liquid-only census;
normal native tests compare representative coasts, a river mouth, Crystal Lake
and the below-sea raceway against the existing full parser.

The existing `driving-smoke.mjs` accepts `COAST_WATER=0` for a **test-only**
disabled-stream comparison; normal operation always enables the stream.
Four earlier `8b0fb5f` alternating 30-second Gold Road runs after backpressure, with video and
fresh contexts, produced:

| Measurement | Disabled runs | Enabled runs |
| --- | --- | --- |
| Moving freezes over 50 ms | 1 / 3 | 2 / 0 |
| Longest moving freeze (ms) | 61.2 / 108.4 | 55.1 / 42.5 |
| Reply interval p95 (ms) | 15.7 / 15.1 | 17.1 / 16.7 |
| Longest reply interval (ms) | 87.4 / 105.8 | 80.0 / 65.6 |
| Additional water tiles parsed while driving | 0 / 0 | 13 / 20 |

All runs covered about 1077 yards and seven waypoints with 30/30 focused samples.
The enabled stream yielded to ordinary reads 500/485 times; maximum liquid parse
time was 1.1/1.0 ms. This preserves foreground progress, at the cost of slower
water loading while driving. The roughly 1.5 ms p95 reply cost remains; these
short shared-host samples do **not** prove no regression or a strict 50 ms
maximum. The first implementation without source backpressure failed its cold
comparison (2 to 6 long freezes) and was not accepted on screenshots alone.

Nearby models use authored geometry, transforms, BLP textures, UVs, alpha cutoff,
material blending and depth. The near scene budget is **192 geometry/root resources,
192 dependent textures and 96 MiB decoded payload**. Near visuals have 768 instance
slots while the separate distant worker is active, otherwise 1024. Collision
candidates are not capped by the visual quota. These are not total browser/process
memory limits: parser temporaries, JavaScript bookkeeping, transfer/GPU copies
and driver memory are additional. Capacity/pending counters mean some content is
incomplete, not that it loaded successfully.

Detailed ground uses native ordered layer blending, authored normals, texture
coordinates, alpha masks, shadow masks and holes. Bounded texture arrays and
mipchains reuse the local BLP data. Far terrain progressively receives translated
native minimap colors in two 2048-square atlas pages (32 MiB); missing mappings
stay explicit. Material status reports textured tile residency, CPU terrain-cache
size, minimap progress and pending/error counts. Static sunlight/fog remain an approximation, not DBC time-of-day
lighting or full native water sheen.
Missing optional minimap mappings are grouped into a count with expandable
locations (18 on the tested installation), not individual resource errors.
Corrupt mapped textures and required terrain/collision failures remain explicit;
an absent map preview is not evidence of blocked physics.

The bounded distant-model adapter reuses the native geometry/material boundary
and complete authored M2 leaf batches, not Bevy's clustering/atlas implementation.
Detailed terrain residency doubles from four to **eight tiles**; distant placement
residency doubles from twelve to **24 metadata tiles**. This is not a whole-world
full-detail scene preload or a Bevy/VMaNGOS port.

`far-worker.js` owns distant ADT placement parsing, M2/WMO/BLP decoding and visual
selection. Its separate cache is bounded to **96 geometry/root resources,
96 textures, 32 MiB decoded payload and 256 visual instances**. It exports no
collision arrays or NPCs. The original worker alone owns physics, near terrain and all required collision
candidates. The serialized MPQ reader/index now belongs to `asset-worker.js`;
neither physics nor the distant worker retains a second archive index.
Required terrain/collision reads take priority over background reads, including
sector-level deferral. Flight does not wait for the parked vehicle's terrain.
Far progress or failure never declares near collision ready.

The child runs one loading step at a time on a 25 ms scheduler, with at most one
brokered source read outstanding. A step loads at most one missing metadata tile
and pumps one asset request. Encoded files have a 64 MiB guard; parsing/Wasm
temporaries are additional to decoded-cache budgets. Main and child may retain
overlapping geometry in their separately bounded caches, but do not duplicate
the archive index. There is at most one unacknowledged render publication:
retained arrays are copied once, transferred child-to-parent-to-renderer, then
uploaded. The largest observed packet was 4,952,608 bytes.

Focus and near-visible ownership messages coalesce. Source/map epochs reject
stale results; same-map distant toggles retain metadata rather than rescanning.
Producer-scoped upload receipts cannot acknowledge a replacement worker.
Construction, messaging and upload failures remain explicit and retryable;
failed far GPU uploads clear only far resources. Retry publishes a complete
snapshot, while unchanged normal snapshots are suppressed.

Models can appear out to **6000 yards**, with authored alpha cutoff, real depth,
and dither/fog fading from 3500 yards. Only the nearest 24 metadata tiles on the
active continent are retained, not every prop inside that radius. Tree/prop
models and building structures share distant admission. Inside 128 yards,
distance wins; beyond that, authored size relative to distance favors useful
silhouettes over small clutter. Bounded distinct-model discovery prevents an
already decoded repeated fence from excluding unknown trees. Inspected bounds
survive mesh eviction, prune with metadata residency, and prevent stationary
over-capacity discovery churn. Material requests retain visual priority.
Far WMO structures omit interior child doodads; near admission restores them.

Near IDs win overlap immediately, and `far:` resource keys cannot evict near
GPU resources. Conservative transformed-AABB frustum culling precedes the global
**1024 instances, two million triangles and 4096 draw calls** limits; those GPU
limits were not doubled. Oversized instances do not suppress all subsequent
smaller instances. Frustum culls and actual budget omissions are reported
separately. All near collision candidates survive visual selection.

**Historical `5c7f281` release evidence, not universal smoothness acceptance.** The earlier
same-worker implementation regressed: repeated scans/sorts dominated selections
of 12--15 thousand candidates. Exact placement/bounds reuse and bounded-prefix
selection helped but did not pass consistently. The separate-worker architecture
was explicitly selected instead of lowering scenery or the user's 150/300 speeds.

Final isolated Edge comparisons used both run orders, fresh contexts, video,
and no trace/CPU sampler. The common **6.25 seconds before solid contact** covered
575--581 yards with over 6.10 seconds active in every capture:

| Matched active-motion measurement | Forward baseline / release | Reverse baseline / release |
| --- | ---: | ---: |
| Moving stalls over 50 ms | 1 / 0 | 2 / 0 |
| Longest moving stall (ms) | 59.5 / 27.4 | 65.1 / 47.1 |
| Reply interval p95 (ms) | 20.2 / 17.1 | 20.5 / 17.0 |
| Handler p95 (ms) | 15.9 / 12.4 | 15.2 / 11.0 |
| Handler p99 (ms) | 25.1 / 27.0 | 30.7 / 22.7 |

Baseline is `07e1332` JavaScript with the current Wasm: it requests four tiles,
so does not exercise the new capacity. `WARM_SECONDS=0` still includes about
six seconds of harness focus/load preparation; this is not true first-open
onset. OS file cache and host load are uncontrolled. All full 30-second captures
had zero additional terrain/object holds, but solid stops and recovery paths
diverged after contact and are excluded from matched performance claims.
The short common interval and forward p99 increase remain limitations.
Strict high-speed/all-world hitch acceptance stays open.

Forest/city checks produced 3127/4366 changed far-scene pixels with zero
background drift, visible tree canopies and major structures, eight detailed
tiles and 24 far metadata tiles. Actual off/on transitions reused metadata and
returned to driving/collision readiness. The final roughly 20-second samples
measured:

| Resource | Forest | City |
| --- | ---: | ---: |
| Child JS used heap | 38.6 MiB | 23.2 MiB |
| Child Wasm memory | 13.6 MiB | 14.2 MiB |
| Near-worker JS used heap | 53.8 MiB | 28.1 MiB |
| Main-page JS used heap | 33.7 MiB | 57.0 MiB |
| Tracked GPU allocation peak | 204.0 MiB | 238.5 MiB |
| Edge-process GPU dedicated residency | 383.0 MiB | 440.4 MiB |
| Edge-process GPU shared residency | 98.3 MiB | 98.3 MiB |

GPU residency comes from Windows counters filtered to the isolated browser's
CDP process IDs, not unrelated applications. These are samples, not guaranteed
process peaks or hard memory limits. CDP backing storage includes buffers/Wasm;
do not add Wasm to it again. Full coastal coverage measured 238.8 MiB tracked
GPU payload and 79.4 MiB main-worker Wasm, before driver overhead. The host had
about 35 GiB free RAM and 10 GiB free RTX 3060 VRAM; that supports, but does not
alone justify, the bounded caches. Dense city materials still reach the near
192-texture and far 32 MiB/96-texture limits; complete city residency is not claimed.

**Cold coastal coverage and the tan strip remain unresolved.** Coastal priority
and the install-fingerprinted existing-store liquid cache improve loading, but
the cold four-second Tanaris view still has incomplete distant shoreline.
One/four/twelve/thirty-second samples had 1/33/136/355 wet tiles. Complete coverage
took **114.033 seconds cold and 28.603 seconds cached**: 1705 tiles, 1301 wet,
404 dry, no pending/error entries, and no final water frontier. Cold liquid
extraction returned **2,111,901,065 source bytes**, versus zero cached; aggregate
source reads were 5.431/2.184 GB including other assets. Cached loading is not
instantaneous. Background loading never waits for all 1705 ADTs before physics.
The 50,326,920-byte global water payload fits its 64 MiB budget; overlapping near
water, parse/transfer copies and driver allocations are separate. Authored
wet/dry/hole masks remain exact; no guessed below-sea flooding hides gaps.
The separately reported tan triangular strip was not reproduced at bounded
Tanaris poses and is not claimed fixed by these changes.

### Partial async-loading checkpoint `eb9ce1f` (not released)

The checkout is based on `31fd878`, including its merged Rust physics and liquid
scanner. `asset-worker.js` now owns archive extraction, near BLP decode/mip
generation, terrain camera indexing and liquid-vertex extraction. IndexedDB
operations were already asynchronous; one reusable connection now replaces
opening/closing it for every liquid record. Version changes close the connection,
failed opens remain explicit, and save/tuning keys are unchanged.

There is one source operation and one unacknowledged result at a time, with a
64-operation queue guard and a 64 MiB encoded-file guard. Required source reads
precede optional work and can cancel background extraction between sectors.
Late source results are rejected. Detail preparation keeps one active batch and
one coalesced pending tile set, preserving ordered removal/admission without
blocking physics. The main thread receives typed camera indices and liquid
vertices instead of rebuilding them. WebGPU resource creation/upload still
occurs on the main thread; terrain texture uploads retain their per-frame budget.
Near geometry decoding/admission and near selection still have synchronous
sections; making a function return a Promise does not move its CPU work.

Exact hull/camera predicates still run every frame. A conservative cached
candidate window reduces their repeated scan without removing unknown WMO roots
or changing readiness. No speed, collision, 8/24 residency or rendering budgets
were reduced.

The initial final comparison's fixed-wall-time distance assertion failed because
the reverse baseline spent 254 ms waiting for a collision asset and covered less
ground. Preserved equal-path analysis instead selects the largest common
five-yard-rounded distance ending at least 200 ms before solid contact:
**580--581 yards, 6.02--6.07 active seconds**. All four captures use the same
150/300 tuning, fresh contexts, video and no trace/CPU sampler. The approximately
six-second source-focus preparation and uncontrolled OS cache still apply.

| Equal-path result | Forward baseline / checkpoint | Reverse baseline / checkpoint |
| --- | ---: | ---: |
| Reply p95 (ms) | 15.2 / 12.7 | 20.2 / 11.5 |
| Active handler p95 (ms) | 10.2 / 10.1 | 14.5 / 9.3 |
| Active handler p99 (ms) | 22.6 / 29.4 | 30.9 / 19.0 |
| Moving stalls over 50 ms | 0 / 0 | 0 / 0 |
| Longest moving stall (ms) | 27.9 / 47.9 | 34.0 / 35.4 |
| New object holds (duration ms) | 1 (80.9) / 1 (65.8) | 1 (254) / 0 (0) |
| New terrain holds | 0 / 0 | 0 / 0 |

**Forward p99 regresses; this is not a release or loading-hitch closure.**
Remaining long active handlers contain 31--44 ms near selections and one combined
terrain admission/selection of 64 ms. The follow-up must separate/slice visual
selection while preserving immediate collision demand, then pass both orders
without a p99 regression or moving stalls over 50 ms.

The checkpoint passes 202 JavaScript and 45 Rust tests (one ignored), plus actual
forest/city and transition checks. Forest/city retain 8/24 tiles and produce
4940/3706 far-scene pixels with zero background drift. The added source worker
sampled 1.8 MiB Wasm and 0.7/11.1 MiB used JS heap, with 40.6/32.4 MiB backing
storage including its single 12.5 MiB archive index. Do not add Wasm twice.
Source/result transfer peak was 42.3 MiB, including a multi-tile prepared detail
packet; one active/pending batch and parsing copies are additional to decoded
caches. Edge GPU counters sampled 407/476 MiB dedicated plus about 98 MiB shared.
These are samples, not hard whole-process peaks.

### Near-selection checkpoint `2731640` (unreleased; gate failed)

The second local checkpoint separates immediate collision demand from a single
yieldable visual-selection draft. Candidate enumeration, prominence calculation
and material requests yield in groups of 64 using background scheduler tasks
(timer fallback). The bounded-prefix ranking itself still runs synchronously
within a background turn. Completed visuals publish atomically; resource,
source, map and near/far budget changes invalidate stale drafts. Optional scene
loads pause during a draft; required geometry continues and always overrides
older visual requests. No worker, archive index or full geometry cache is added.

Collision selection now rejects conservatively distant placements before building
exact transforms or computing distances. Its bounds include actual collision
vertices, not merely render bounds, and its horizontal window covers the collision
submission anchor and swept demand. Exact readiness predicates remain immediate,
including unknown WMO roots and restore support columns. Geometry admission,
eviction and metadata changes invalidate collision selection immediately;
texture changes and visual publications do not. The 150/300 handling, 8/24
residency, visual budgets and collision behavior are unchanged.

Terrain material buffer extraction also yields separately for vertices, indices
and masks, outside the physics request queue. One material handle can be active,
with remaining resident indices pending. Eviction/source replacement cancels
publication and frees the old handle; failed extraction stays explicit. This
does not split an individual Wasm getter, terrain admission, or GPU upload.

**Do not release this follow-up yet.** Some intermediate comparisons passed, but
subsequent source revisions/repeats did not consistently satisfy both limits.
The latest `scenery-async-material-{forward,reverse}-{before,after}` captures
against `31fd878` cover 585.2--586.2 yards and 6.08--6.11 active seconds, ending at
least 200 ms before solid contact. Settings are matched at 150/300, video on,
sound/profiling off, fresh browser contexts; OS cache remains uncontrolled.

| Latest equal-path result | Forward baseline / follow-up | Reverse baseline / follow-up |
| --- | ---: | ---: |
| Active handler p95 (ms) | 12.4 / 4.9 | 9.2 / 4.3 |
| Active handler p99 (ms) | 28.2 / **26.2** | 24.9 / 8.4 |
| Reply p95 (ms) | 18.6 / 12.1 | 15.8 / 5.8 |
| Moving stalls over 50 ms | 0 / 0 | 1 / 0 |

The explicit gate requires p99 at most **20 ms in both orders**, no p99 regression,
and no moving stalls over 50 ms. The latest forward p99 fails. Full 30-second
object-hold totals, reported separately rather than hidden in motion statistics,
are 1 (476.1 ms) / 1 (313.4 ms) forward and 1 (116.5 ms) / 0 reverse; terrain holds
are zero. Post-contact trajectories are not accepted as matched driving evidence.

Worst-case work is **not** below 20 ms: the latest matched forward run includes
62.2 ms collision selection and 25.8 ms combined terrain admission; its largest
handler is 63.3 ms. Background visual slices reached 50.4 ms over the full capture.
The newly separated material getters measured at most 7.1 ms in these matched
segments, versus an earlier unsliced 78.3 ms aggregate extraction. Terrain
admission still combines `add_tile`, placement extraction, render geometry and
seam generation. Splitting that aggregate is possible; an indivisible >20 ms
Rust call has not been established. Selection/queue tails still need work, not
another favorable rerun or a lower scenery/speed budget.

Current validation passes 217 JavaScript tests and actual forest/city and
transition checks. Forest/city retain 8/24 tiles and show 4940/3682 changed far
pixels; comparison background changes are 0/32 pixels. Used JS heaps sampled
52.8/43.6 MiB (physics), 39.3/42.9 MiB (far), and 10.0/11.2 MiB (source).
Tracked GPU allocation peaks are 225.6/266.3 MiB; isolated Edge dedicated
residency samples are 415.5/476.6 MiB plus 97.9 MiB shared. These are not total
process peaks. Evidence is under ignored `test-results/scenery/async-followup-memory`;
failed driving captures remain retained. Cold coastal onset, the tan strip and
strict all-world hitch acceptance remain open. The 4173 server process has not
been restarted, and no user page or saved state was altered.

#### Step 1: yielded terrain geometry and seams (`3fe0c3b`, local checkpoint)

After local checkpoint `2731640`, render geometry and horizon seams are extracted
one tile per background turn, rather than during terrain collision admission.
One active extraction job retains at most the eight resident tiles; pending
indices/removals coalesce. Residency changes discard an incomplete seam set and
restart against the current revision. Source replacement cancels old jobs.
Only a complete consistent batch enters the existing source-worker detail
preprocessing queue. Errors remain explicit and do not retry automatically.
`add_tile`, placement metadata and collision readiness still complete before physics.

Both-order `scenery-async-geometry-*` captures against `31fd878` cover
585.2--585.5 yards and 6.08--6.10 active seconds with the same 150/300 settings:

| Step 1 equal-path result | Forward baseline / step 1 | Reverse baseline / step 1 |
| --- | ---: | ---: |
| Active handler p99 (ms) | 20.6 / 10.0 | 19.8 / 9.5 |
| Moving stalls over 50 ms | 1 / **1** | 1 / 0 |
| Worst step-1 selection (ms) | 13.0 | 21.7 |
| Worst step-1 terrain admission (ms) | 15.2 | 10.3 |

The **combined gate still fails**: the forward moving stall is 55.7 ms.
Its 55.2 ms handler has no corresponding increase in timed selection, geometry,
admission or physics stages, so it must not be attributed to those stages
without further instrumentation. Full-capture visual selection slices peaked
at 19.9/18.3 ms; cumulative render-geometry slice maxima through the matched
endpoints were 18.9/19.8 ms. The reverse 21.7 ms synchronous selection also
remains above the requested worst-case target. Full-run object holds were
0/0 forward and 1 (254.5 ms)/0 reverse; terrain holds were zero.

Step 1 passes 221 JavaScript tests and isolated forest/city, memory and transition
checks. It was committed locally as `3fe0c3b`, with the moving-tail failure
explicitly open; it was not pushed or released.

#### Step 2: incremental collision candidates (uncommitted, bounded gate passed)

Focus, water/minimap priority, far-focus, source cancellation and telemetry now
have harness-only timing. The original 55.2 ms handler did not recur; its cause
is still unproven. The instrumented `async-focus` comparison passed handler p99
at 7.2/9.4 ms and had no moving stalls over 50 ms, but reverse collision selection
still reached 22.6 ms. That triggered the requested collision index.

Near placement descriptors now occupy conservative 128-yard horizontal cells.
Movement queries the collision-anchor and predicted-demand region instead of
enumerating every nearby tile's placements. Metadata changes reconcile only
changed memberships; geometry admission/eviction immediately relocates entries
for affected model keys. NPCs keep the original five-by-five visual neighborhood
but are excluded from the collision index.
WMO roots remain always considered, with existing group/doodad expansion and
early doodad rejection. Oversized bounds use an always-considered set rather
than unlimited cell memberships; oversized queries fall back to enumeration.
Map/source replacement clears the index. Exact readiness, support columns,
required-asset priority, 150/300 handling and 8/24 residency are unchanged.
This adds descriptor references, not another geometry/archive copy or worker.

Final `scenery-async-index-final-*` captures compare with `31fd878` in both
orders over 585.2--585.9 yards, 6.06--6.10 active seconds, ending at least 200 ms
before solid contact. Fresh contexts, video on, sound/profiling off, source-focus
preparation and uncontrolled OS cache are unchanged.

| Final equal-path result | Forward baseline / indexed | Reverse baseline / indexed |
| --- | ---: | ---: |
| Active handler p99 (ms) | 21.0 / **4.7** | 22.4 / **4.8** |
| Moving stalls over 50 ms | 0 / **0** | 0 / **0** |
| Worst indexed selection in segment (ms) | 6.4 | 15.0 |
| Worst indexed terrain admission in segment (ms) | 11.6 | 9.9 |
| Worst active indexed handler (ms) | 16.5 | 16.9 |

Both orders pass the p99/no-regression/moving-tail gate. Including source
preparation, selection maxima are 10.1/15.0 ms. Full-run indexed object and
terrain holds are zero, reported separately from the matched moving interval.
An earlier indexed revision also passed p99 at 4.6/6.2 ms, but its reverse
admission reached 21.4 ms and visual slices reached 43.8 ms; that evidence is
retained, not invalidated by the final favorable sample.

**This is not a hard all-work 20 ms guarantee.** Final background visual slices
reached 20.6 ms, pre-drive geometry extraction reached 35.4 ms, and a stationary
telemetry call took 22.8 ms. The latter was outside active-motion statistics and
does not establish the original moving tail's cause. Individual Wasm calls
remain synchronous within yielded turns; further splitting has not been proven
impossible. No release or universal loading-hitch closure is claimed.

225 JavaScript tests pass, including indexed-versus-brute collision demand,
large/rotated hulls, immediate resource changes, duplicate tile ownership, NPC
replacement, WMO groups, map reset and bounded-query fallback. Isolated
forest/city and mode/map transitions pass with actual 8/24 residency and
4940/3682 far-scene pixels (background changes 0/32). Used JS heaps sampled
44.8/33.7 MiB (physics), 47.4/43.0 MiB (far), and 4.3/7.9 MiB (source);
tracked GPU peaks were 227.4/266.7 MiB. These are samples, not process peaks
or a measurement of the index alone. Evidence remains under ignored
`test-results/scenery/async-index-memory` and the named driving captures.
The follow-up remains uncommitted; no push, 4173 restart/page action, or user
save/settings changes were made. Coastal onset and the tan strip remain open.

`scenery-smoke.mjs` records staged forest/city pixels, demand, all three worker heaps,
tracked GPU allocations and Windows GPU-process residency. Sample waits use
deadlines and record actual elapsed time so measurement overhead does not
silently extend the next loading interval. `SCENERY_CASE=coast` records cold onset,
complete source coverage and same-profile cached reload. `distant-smoke.mjs`
compares three synchronous GPU draws of a fixed scene, then tests real mode
transitions; background far loading is allowed to continue independently of
physics presentation. These harnesses refuse the protected 4173 preview.
Use a separate local server and the read-only install:

```powershell
$env:BASE_URL = 'http://127.0.0.1:4183'
$env:PANORAMA = '1'
$env:LABEL = 'scenery-check'
node .\browser\scenery-smoke.mjs
```

Terrain and opaque/cutout commands reuse bounded WebGPU render bundles without
omitting draws. Membership, material, resource or uniform-offset changes rebuild
them; transparent batches still sort back-to-front every frame. Batch paths and
pipelines are prepared once, static instance transforms retain floating-origin
precision, and each frame writes directly into the existing uniform buffer.

The worker separately negotiates `sceneInstanceUpdates`: a complete visual-priority
`instanceOrder` plus only changed `id/key/matrix/kind/distant` descriptors.
The renderer retains unchanged objects and transform caches, validates IDs before
changing resources, and drops removed instances. Region transitions resend every
descriptor; sender caches advance only after a successful post. Older full-instance
and asset-only message behavior remains supported. This changes visual transport,
not collision readiness, physics timing or presentation delay.

Collision uses **BVH-indexed authored collision triangles**, with continuous
two-sided swept hull tests (half-extents 1.1 east / 0.5 up / 1.1 south yards)
and four support probes, not foliage cards or a WDL
floor. Mesh height preserves openings and bridges that whole-building bounds
previously blocked. The collision cache uses a 120-yard radius around a stable
anchor, recentered after at most 32 yards of motion. It expands when accelerated
frame travel needs more room to cover physics and the post-step chase camera.
Its cache has a separate 200,000-triangle
safety limit and is not hidden by the visual instance budget. Per-instance BVHs
are reused, then flattened into the same tree used by physics and the camera.
The instance cache and flat tree retain two copies of collision geometry;
`state.collision[2]` reports their combined buffer bytes, not total process memory.
Building new parts additionally needs 76 temporary bytes per triangle in Wasm
(at most 14.5 MiB). The Wasm high-water counter includes these allocations.
Collision does not
wait for alpha textures. Unavailable nearby geometry is held explicitly; unresolved M2
extents use a conservative 32-yard proximity guard, not a proof of empty space.
Terrain, near-object and solid-contact hold counters are exposed in
`window.worldEvidence.state.holds`. **Retry loading** also retries failed scene
assets and the player craft. Transformed meshes and the BVH are live caches,
invalidated by scene membership; no persistent collision bake or silent collision
disablement is implemented.
High-speed tuning also checks intermediate expected ADTs, not just the sweep
endpoints. A footprint that cannot fit the eight-tile or collision budget fails
explicitly instead of crossing unverified geometry.

## Static NPCs and private data

Client Data contains appearances, **not spawn coordinates**. This installation
can serve a private companion at `runtime\browser\npc-spawns.json` through the
single `/local/npc-spawns.json` loopback URL. That ignored artifact was generated
from the user's offline 2021 world SQL snapshot and includes provenance.
The original pack contains 53,453 static overworld spawns and 5,537 resolved display definitions.
Do not commit, upload or redistribute it. See [SCENE.md](SCENE.md) for the optional
private export commands and schema.

The conservative patch-10 exporter filter produces **51,561** spawns from the
same snapshot: 1,500 explicitly disabled-event members, 389 additional
patch-ineligible-event members, one disabled spawn and two explicitly invisible
spawns are excluded. Negative event memberships and ordinary pools are retained;
pool flags zero do not mean default-off. This is not live event/pool scheduling
or aura/script visibility. Existing private packs are unchanged until re-exported.

Within 500 yards of the authored Anachronos gate location, the count falls from
186 to **137**; `Kalimdor_29_47` falls from 32 to **11**. The 49 removed AQ units
belong to events 61/65, both authored for patches 7--7, not patch 10. Eligible
post-event 86 and normal fauna remain. The SQL-derived source population was
checked against every GUID in the original pack; no live database was accessed.

The `npc-visibility` isolated both-order gate loads a separate 51,561-spawn,
5,434-display candidate without replacing the served private pack. At the common
585-yard segment (over six active seconds), handler p99 is **3.3/4.6 ms**
(baseline 10.6/3.5), moving >50 ms tails **0/0**, worst active selection
**6.7/8.9 ms**, and active terrain admission **6.6/1.4 ms**, with no readiness
holds. This meets the 20 ms target; it is not a claimed performance speedup.

Without that companion the app explicitly reports no NPC population. NPCs are
visual-only, static bind-pose appearances, not live server entities. They never
enter collision candidates, hull sweeps, camera obstruction or readiness waits,
even when their model has an authored hull. Static world props sharing that model
remain solid. Equipment, complete
humanoid customization, animation, event/pool scheduling, quests and combat are
not implemented. Baked humanoid bodies omit unresolved hair/cape batches rather
than drawing fake opaque cards.

The `npc-collision-final` isolated both-order gate against `ab7c899` covers
585--587 yards and at least six active seconds at unchanged 150/300 tuning.
Handler p99 is **4.7/4.4 ms** (baseline 11.3/6.5), with no moving >50 ms tails
or terrain/object holds in the candidate runs. Selection including preparation
still reaches 8.1/27.9 ms, active terrain admission 10.5/10.4 ms, and geometry
slices 28.2/22.0 ms: this is a p99 pass, not a hard all-work 20 ms guarantee.
114 focused tests cover visual NPC residency, shared-model static solids,
collision-index exclusion and pose readiness during pending optional reads.

## Day / night

The **Night (N)** setting (default day, kept in `localStorage` and the save's settings) picks the day or night zone-music variants (previously night was chosen from the machine clock) and grades scene/terrain colours, fog, the clear colour and the water shader's sky reflection through one existing uniform slot (`forward.w`), eased over about a second. It is analytic only: no new passes or art.

### Game sky (runtime, in memory)

`sky.js` reads `Light.dbc`, `LightParams.dbc`, `LightSkybox.dbc` and `LightIntBand.dbc` from your Data folder at runtime (a background read that yields to loading; nothing is cached, persisted or shipped). Layouts are validated against vanilla 1.12 and rejected otherwise. Per map, the lights covering the camera are blended by falloff (the map's global light takes the remainder) and each colour band is interpolated over the 2880 half-minute day. Bands used: 1 ambient→grade tint, 2–6 sky gradient (top, middle, two bands, horizon), 7 fog, 9 sun, 10/11 cloud. `LightIntBand` band 0 ("global diffuse") holds implausible values in this client, so it is unused. Day/night now selects noon (1440) or midnight (0) and the time always advances forward (through dusk or dawn) over about two seconds. The sky is one fullscreen gradient draw in the existing pass; fog, the clear colour, terrain/scene tint and the water reflection use the sampled colours. Our clouds and maelstrom are tinted with the game's cloud band and fogged with its fog band. Without the DBCs, or on maps other than Azeroth/Kalimdor, the previous procedural sky remains. At night the game's own `Environments\Stars\Stars.m2` dome (loaded in the background, textures decoded in memory) is drawn after the sky gradient with no depth write, following the camera, spinning about a tilted axis with the time of day and fading in towards midnight. **Moons are procedural:** this 1.12 `Stars.m2` contains stars only (no moon geometry or textures exist in the data), so the sky shader draws two analytic discs, a large pale one and a smaller green-blue one, on slow orbits with a soft phase, faded in with the night (no art).

### Position-based sun

Lighting follows where the camera is on the globe, not the global clock. `local-sun.js` turns the one inertial sun (`sunInertial`) into the sun at the eye (`localSunAt`: east, up, south) and `solarTime(sun)` into the Light.dbc clock reading that sun corresponds to (720 sunrise, 1440 noon, 2160 sunset). The renderer uses that local time for daylight, the game-sky lookup, sky-dome night/stars, and the local sun for terrain, water, globe and cloud shading; far fragments on the bent globe already derive their own night from the sun vector (`localNight`). The clock/HUD time is the time at the chart origin (the mid-ocean longitude, lat 0): flying west moves into earlier local time (the sun climbs), flying east into later (it sinks), a full day per planet circumference. Audio/music night cues and the HUD stay on the clock.

## Checks and evidence

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-web'
$env:WOW_DATA = 'C:\path\to\your\install\Data'
$env:BENILLA_REQUIRE_DATA = '1'
Push-Location .\client
try { cargo test --release -j 2 -p flats-racer-web } finally { Pop-Location }
npm --prefix .\browser test
# With the local preview running and Playwright installed:
node .\browser\overworld-smoke.mjs
node .\browser\distant-smoke.mjs
node .\browser\feel-smoke.mjs
node .\browser\sound-smoke.mjs # Defaults to isolated http://127.0.0.1:4183; BASE_URL overrides it
node .\browser\viewport-smoke.mjs # Same isolated-server default
node .\browser\audio-smoke.mjs
node .\browser\performance-smoke.mjs
```

If Playwright is missing, run `npm ci --prefix .\browser`; tests use installed
Edge (`channel: msedge`), not a downloaded browser. The real-browser check uses
actual directory-backed File objects, drives using keyboard input, visits both
maps and reloads saves offline. It does **not** automate the trusted OS directory
picker dialog. Evidence/screenshots stay ignored in `browser\test-results`.
Run Rust commands from `client` so its pinned toolchain applies; passing
`--manifest-path` from the repository root alone does not select that toolchain.

For sustained driving, run the isolated test server without another benchmark
using the GPU, then run both sound states sequentially:

```powershell
$env:WORLD_URL = 'http://127.0.0.1:4183/?test' # Your isolated server
$env:DRIVE_SECONDS = '180'
$env:WARM_SECONDS = '15'
$env:YAW = '0'
$env:WAYPOINTS = '[[0,-250],[-350,-400],[-550,-150],[-350,-150]]'
$env:MAX_MOVING_FREEZE_MS = '' # Set '50' for the optional strict maximum-gap gate
$env:VIDEO = ''
$env:PROFILE = ''
$env:PRESENTATION = 'confirmed'
$env:INPUT_PULSES = ''
$env:SOUND = ''
$env:RUN_LABEL = 'continuity-silent'
node .\browser\driving-smoke.mjs
$env:SOUND = '1'
$env:RUN_LABEL = 'continuity-sound'
node .\browser\driving-smoke.mjs
```

This uses the standard-controller input path to steer and physically reverse
around obstacles, not teleport between test points. It records raw response and
drawn poses, physical holds, simulation steps, discarded time, and p99/max gaps.
Long waypoint runs require over 90% moving time; stopped-car FPS cannot pass.
The optional freeze limit deliberately fails a run with longer moving-pose
freezes. Service workers are disabled only in this profiling context so they
cannot bypass worker instrumentation; offline functionality is checked separately.
`SOUND`, `VIDEO` and `PROFILE` enable their feature only when exactly `1`.
`PROFILE=1` additionally saves main/worker CPU profiles. Every run records actual
canvas dimensions/DPR, browser scheduling flags, document focus/visibility samples
and lifecycle events. Each has a fresh browser/worker and the declared warmup;
the operating-system file cache is **uncontrolled**, not claimed cold.

At source checkpoint `2dee228`, the controlled 180-second captures on headless
Edge 155, 1206 x 534 pixels, DPR 1 produced:

| Sound | Moving seconds / yards | Drawn-pose p99 / max | Moving freezes over 50 ms | Client time discarded |
| --- | --- | --- | --- | --- |
| Off | 177.8 / 5614 | 20.6 / 69.9 ms | 10 | 0 ms |
| On | 178.9 / 5968 | 20.5 / 100.1 ms | 10 | 11.2 ms |

Both used 15-second warmup, raw main/worker tracing, no video or CPU profiler,
and passed the live input/step/transport instrumentation checks. All 180 samples
per run were visible and focused, with no focus/visibility transitions during
capture; the browser's actual launch flags disabled background throttling.
Headless runs have no OS foreground window. No user tab was focused or reloaded.
Navigation used the same waypoint controller but followed different physical
trajectories (eight versus three reverse recoveries); this is not an identical
trajectory or proof that sound caused the maximum-gap difference.
Evidence is in `test-results/driving/integrated-{silent,sound}-controlled`.

These runs reproduce the faster regime, **not a complete fix for catching**:
they exceed the optional 50 ms maximum gate, and do not explain the earlier
unchanged-source run with 655 moving freezes, 384 ms maximum and 4.56 seconds of
discarded time. That failing trace remains retained. Those captures used raw
fixed-step presentation, which repeats poses between physics ticks.

The subsequent camera-allocation fix (`dfa2b2f`) replaces the temporary growing
JavaScript positions array with exact typed storage, preserving every land
triangle and spatial bucket while excluding water as before. In matched peer
180-second captures, ADT-admission return delay p50/p95 fell from 8.4/17.9 ms to
5.3/7.8 ms. Moving freezes over 50 ms fell from 11 to 6, but maximum gap was
71.2/73.0 ms: this is **not a maximum-tail fix**. Both discarded zero time;
physical trajectories differed. The integrated 103-test suite and actual Edge
controls/audio/camera/save/offline check pass with shell cache v16.

### Confirmed-pose presentation

Driving now targets a fixed 30 ms history of confirmed physics poses, with no
prediction or extrapolation. Camera and craft use the same presented pose;
physics, audio and HUD remain authoritative. Holds, reset/restore, source/mode
changes, time reversal and real global-pose discontinuities invalidate the history.
Ordinary floating-origin changes now retain it: positions in this queue are global,
and the renderer subtracts the latest origin afterward. A newer authoritative
hold stops buffered motion immediately. Without a bracket, drawing holds the
latest confirmed pose rather than accumulating more delay.

The historical 180-second capture below predates that origin-only correction.
It compared the actual presented pose with the current
raw client pose at every draw, under identical scheduling:

| Measure | Raw | Presented |
| --- | --- | --- |
| Repeated moving draws | 5070 | 171 |
| Changed-pose interval p99 | 20.9 ms | 10.0 ms |
| Moving freezes over 50 ms | 11 | 2 |
| Maximum moving freeze | 117.4 ms | 90.3 ms |

This is a 96.6% reduction in repeated moving draws, **not elimination of every
stall**. The optional strict 50 ms maximum gate failed and its trace is retained.
The run covered 5866 yards with 178.67 seconds moving, six physical reverse
recoveries, 180.27 seconds simulated and zero client-discarded time. All 23 draws
reporting a hold exactly matched the raw position/yaw; nine rebases occurred.
All 180 document samples were visible/focused, at 1206 x 534 pixels and DPR 1,
with sound/video/profiling off. CPU was 52% in the pre-run snapshot; this does not
explain historical slow runs.

Corrected six-pulse controls measured 13.1-21.4 ms additional input-to-changed-pose
draw latency, with zero discarded time. Each pulse had to start at rest without
a hold and produce a complete onset inside its own one-second throttle window;
later movement cannot satisfy a missed pulse. This is draw timing, not physical
monitor scan-out. Reproduce those controls after the environment setup above:

```powershell
$env:WAYPOINTS = ''
$env:DRIVE_SECONDS = '30'
$env:INPUT_PULSES = '1'
$env:SOUND = ''
foreach ($mode in @('raw', 'confirmed')) {
  $env:PRESENTATION = $mode
  $env:RUN_LABEL = "latency-$mode"
  node .\browser\driving-smoke.mjs
}
```

The peer evidence folders are `idle-input-raw`, `idle-input-confirmed` and
`idle-sustained-confirmed` under its ignored `browser/test-results/driving`.
Final integrated validation passes 109 JavaScript tests and the actual Edge
controls/audio/camera/save/offline check with shell cache v17. A separate
sound-enabled six-pulse capture measured 13.8-21.2 ms added delay, reduced repeated
moving draws from 225 to 1, and discarded no time; all 30 samples stayed
visible/focused. The harness checks the added-delay bound against 30 ms plus the
actual onset draw interval. Its retained evidence is
`test-results/driving/integrated-confirmed-sound-pulses`.
The earlier slow/fallback traces remain retained too: a 30 ms presentation buffer
does not fix worker starvation or guarantee smooth motion under sustained load.

The audio check installs the current offline shell in an isolated browser
context, disconnects the network, and captures the cached production graph using Edge's
`OfflineAudioContext` with deterministic idle, acceleration, cruise, boost,
release, water, airborne, landing, braking, collision hold, pause and mute inputs.
It checks output level, stereo energy, spectral bands, discontinuities and
envelope-update cost, and saves an original stereo WAV under `test-results/audio`.
It also exercises a real-time `AudioContext`: activation, inactive-view fade,
mute/suspend, resume with the same three voices, and explicit context cleanup.
This is captured signal evidence, **not a listening audition** or a substitute
for the integrated real-time driving check.
The captured 28-second sequence peaks at 0.133 full scale; idle/cruise/boost/held
RMS is 0.030/0.035/0.050/0.030, with silence after pause/mute fades. Measured
envelope/parameter updates are p99 0.1 ms, max 0.3 ms at browser timer resolution;
initial one-time graph/buffer creation takes about 17-22 ms across repeats.
The real-time lifecycle capture measures p99/max update cost of 0.2 ms.
These are isolated CPU captures,
not an end-to-end driving-continuity measurement.

The separate `sound-smoke.mjs` exercises normal `/` onboarding with actual Sound,
Resume and canvas clicks, without an autoplay bypass or browser mute flag.
Its retained before/after capture reproduces settings-focus silence (RMS 0)
and an enabled-but-suspended context that ignored clicks. After recovery changes,
settings-focus output is 0.033 RMS and a canvas click resumes the same three
voices. It also checks failed/pending resume retries, flight pause, explicit
mute, loading a muted save and saved on/off preferences across reloads.
Suspension/failure injection never manually starts a context. Headless tab
activation did not change document focus/visibility: that failed precondition
is retained, and the focus-handler check is explicitly **injected blur/focus
events**, not an OS-focus test. Analyser samples can remain stale while suspended;
nonzero samples alone do not establish output. No subjective listening or
user-device/per-tab mute check is claimed.
Integrated validation passes 114 JavaScript tests and the Edge sound/feel/offline
checks with shell cache v18. Onboarding evidence is retained under
`test-results/sound-onboarding/{before,after}`. The sound run's CPU snapshot was
85%; these functional checks are not a performance comparison.

The distant check compares actual screenshots with models enabled/disabled at
1400-yard camera altitude on both continents; it asserts visible changed pixels,
real cutout batches, unchanged terrain residency and no distant collision holds.
It freezes presentation time and settles asset events before comparison so moving
water and progressive texture uploads cannot masquerade as model pixels.
The feel check exercises native/legacy inputs, the actual Web Audio output graph,
synthetic standard-gamepad values through the browser frame path, tuning validation,
write-failure preservation and offline reload. It also requires eight textured
tiles and the authored Stand craft, verifies the craft survives disabling scenery,
and checks that flight hides it and driving restores it. It does not claim a
physical gamepad or subjective listening test.

The named performance routes are internal test paths through the same continuous
world, not levels or selectable play modes. Passing a p95 cadence check does not
rule out visible repeated-pose freezes; sustained continuity also needs long-run
freeze, p99/max and elapsed-simulation-time evidence.

The performance check runs seven 40-second keyboard routes with scenery and
distant terrain enabled. It records the actual canvas dimensions/DPR, frame and
fresh-pose cadence, worker round trips, input-to-render timing and hold episodes.
The clear raceway, coastal circuit and city routes must each sustain movement for
at least 30 seconds and travel more than 250 yards. Their minimum rolling render
rate and fresh-pose rate must reach 30 Hz, with p95 moving frame/pose intervals no
greater than 33.3 ms; high render FPS alone cannot pass. Input timing ends at the
first changed-pose draw, not physical monitor scanout. `WORLD_URL` overrides the
default local URL and `RUN_LABEL` selects the ignored evidence filename.
Changed-pose draw cadence must meet the same rate/p95 gate, so multiple worker
responses between renders cannot masquerade as visible motion updates.

The earlier `bcb4c8f` physics-first checkpoint passed response, render and drawn-pose gates on Edge 155 /
NVIDIA Ampere at 1366 x 668 rendered pixels and DPR 1, with full scenery:

| Sustained route | Moving seconds / yards | Changed-pose draws/s | p95 drawn-pose interval | Minimum rolling render FPS |
| --- | --- | --- | --- | --- |
| Clear raceway | 39.6 / 1216 | 109.8 | 14.1 ms | 138 |
| Coastal circuit | 40.0 / 689 | 118.4 | 14.0 ms | 138 |
| Stormwind | 40.0 / 1392 | 84.7 | 28.5 ms | 137 |

The circuit crosses a real ADT boundary. City and circuit have zero terrain,
object or solid holds. The clear route records 21 ms of brief solid contacts;
the other routes eventually encounter real obstacles and are not sustained-motion
proofs. Durotar's short 11.8-second moving segment still has a 71.3 ms drawn-pose
p95, so this is not a claim of smooth motion everywhere. City p99/max drawn-pose
intervals are 76.6/145.4 ms, and the clear route has a 188 ms outlier.
City first-W to changed-pose draw is 55.2 ms. Full-run Wasm high-water is
71.4 MiB; sampled combined
collision buffers peak at 12.7 MiB. Local evidence is
`test-results/performance/integrated-final-visible.json`; the preceding
`integrated-physics-first.json` run also passes, with city drawn-pose p95 28.5 ms.
The drawn-pose gate
matters: coalesced responses can arrive between renders, so their cadence alone
is not a complete visible-motion proof.

The client keeps one in-flight simulation request and one coalesced latest-input
sample. Already accumulated unsent time drains on the reply instead of waiting
for another display frame; the existing 0.1-second catch-up cap remains. Pose/mode
transitions and pauses discard pending input, and old-world replies cannot drain
into a replacement world. This advances real simulation, not interpolated poses.
Resource-only scene events retain unchanged instances and local render caches.
Membership/transform changes use the negotiated scene protocol described above.
Required collision selection, snapshots, BVH updates and camera data stay ahead
of physics; optional visual packing/publication and job starts follow the real
pose response within the same serialized queue. Publication failure immediately
surfaces an error and blocks further physics until explicit retry. Legacy clients
retain full instance lists and synchronous publication errors.

Admitted detailed terrain supplies scene placements from its resident Rust
`TileMesh`, rather than parsing the same ADT again for scene admission. Required
terrain/collision readiness remains before physics. Terrain material construction
is visual-only work after the pose reply; removing a tile invalidates its pending
material work. These changes preserve authored placement data and collision geometry.

New admissions now defer optional material construction until a subsequent
non-admitting frame has advanced catch-up physics (or is flying/object-held).
One 25 ms fallback task, serialized behind queued requests, finishes near materials
when input stops. The FIFO holds at most eight resident tiles. Eviction/source
changes cancel stale callbacks; texture continuation stops on completion/error,
and failed preparation requires explicit retry. Required terrain, scene selection,
collision and model-readiness pumps are unchanged.

### Remaining scene-transfer and terrain hitches

The ordered-scene optimization's matched 45-second cold-start captures reduced
scene-post total time **613 to 54.3 ms**, p99 **5.6 to 0.3 ms**, and maximum
**24.7 to 2.8 ms**. Descriptors fell from 335390 to 1932, while 331054 ordered IDs
were still sent. Both runs covered about 1605 yards without discarded time/errors.
Presented freezes over 50 ms stayed **2 versus 2**; maximum was 76.2/66.8 ms.
This establishes a transport-cost reduction, **not fewer overall cold-run freezes**.

The subsequent unprofiled 180-second run covered 6010 yards, with 179.2 seconds
moving, but had **15 presented freezes over 50 ms, maximum 117.9 ms, and 57.4 ms
client-discarded time**. It failed the strict gate and was worse than the prior
180-second capture. No cause is inferred from CPU snapshots (66%, 63%, 53%);
sound/video were off, and the operating-system file cache was uncontrolled.
Headless Edge 155 rendered at 1206 x 534 CSS/backing pixels, DPR 1; all 45/45/180
samples were focused/visible with no recorded transitions (not an OS-focus check).
The short runs used profiling with no warmup; sustained used no profiler and
15 seconds of warmup. All used confirmed 30 ms presentation and fresh contexts.
All 29 held draws matched raw poses; ten rebases and four physical reversals
occurred, with no runtime errors or worker-discarded time.
Thirteen tails overlap terrain admission/visual work; the largest overlaps a
134.6 ms worker handler (77.9 ms terrain, 56 ms scene including a 38 ms snapshot).
Two pre-handler waits remain unexplained. Traces/profiles are retained in the
peer's `ordered-scene-{before,after,sustained}` evidence folders; no tuning loop
followed. `SCENE_UPDATES=0` is a harness-only same-source comparison switch.

The later material-scheduling comparison used two new 180-second captures on the
same integrated source (`MATERIAL_SCHEDULING=0` disables only the candidate in the
harness). Presented freezes over 50 ms fell **8 to 1**, maximum **81.7 to 59 ms**,
p99 **12.5 to 10 ms**, and repeated moving draws **366 to 195**. Raw freezes fell
24 to 13; neither run discarded client/worker time or reported a runtime error.
All 16 baseline material preparations occurred on admitting frames; all 22
candidate preparations followed exactly one later frame with 3-7 catch-up ticks.
Admission-to-next-handler wait median fell 16.7 to 2.2 ms (maximum 41 to 30.6 ms).
Both near-material queues drained, with no tile failures/new terrain errors and
the same 18 known missing-minimap notices.

This still **fails the strict 50 ms gate**: the remaining 59 ms gap overlaps
initial synchronous admission, not the deferred material tail. Paths differed
(5611/6001 yards, 10/4 reverse recoveries, 16/22 admissions), and launch CPU
snapshots were 79%/100%; these are limits on causal comparison, not explanations.
All 33/22 held draws exactly matched raw poses. Both runs used headless Edge
155.0.4283.45, 1280 x 800 browser viewport, 1206 x 534 CSS/backing canvas, DPR 1,
15-second warmup, confirmed presentation and ordered scene updates; sound/video/
profiling were off. All 180 samples per run were focused/visible without recorded
transitions. Browser/worker contexts were fresh; OS cache was uncontrolled.
Evidence remains in the peer's `material-catchup-{before,after}` folders alongside
the older, worse retained traces. No Rust/Wasm or collision-policy change is made.
Integration passes 124 JavaScript tests plus the Edge controls/audio/material/
save/offline check with shell cache v19; that functional check is not another
performance comparison.

### High-speed physics and readiness corrections

The existing 120 Hz authoritative tick now divides long horizontal travel into
distance-bounded support steps (maximum 64 per tick), rather than interpreting a
smooth rise greater than 0.6 yards per tick as a wall. Solid sweeps, grounded
hole guards, missing tiles and whole-tick rollback remain enforced. Upward support
feed-forward is capped to the admitted rise per substep; negative descent
feed-forward is unchanged. This is a targeted physics correction, not a claim
that every tuned trajectory is identical to the old implementation.
Floor-height corrections are swept separately before positional commit, so they
cannot push a previously clear hull through newly admitted authored collision.
Only mesh surfaces at or below the queried body center count as support; a clear
ceiling must not become a floor. Endpoint support uses the proposed body height
so upward motion can still reach a higher bridge deck.

Pending authored collision now uses both horizontal and vertical frame excursion
bounds, including hop/downward velocity, support-floor corrections and f32
rounding allowance. The same cylinder drives readiness and retained requests.
Its circumsphere must fit the 850-yard scene coverage; extreme unsupported
combinations fail before advancing physics. Selection refreshes before motion
can carry that live cylinder outside its previous coverage sphere.

After rebuilding Wasm, `node browser\pose-smoke.mjs` runs actual Rust telemetry
through the production client and worker queue. It checks 250/500-yard-per-second
origin-only rebases at ordinary and billion-yard offsets, plus a high-hop descent
onto a previously pending roof: no ticks may run before collision arrives, and
the loaded roof must stop the descent. It also checks restoration and real motion
beneath a newly admitted low ceiling without unloading it. These isolated checks do not establish
full-world frame-rate or loading-latency guarantees. There is still no remote
game server in this browser path; the retained queue is the local simulation worker.

### Terrain admission and scene allocation corrections

Packed 4-bit terrain alpha now writes RGBA pairs directly and fixes border rows
and columns once per layer. The completed mask buffer is moved instead of copied
(4 MiB of mask copies avoided per full tile). Scene selection reuses each fresh
request object and a constant priority table; placement/bounds transforms avoid
temporary callback and corner arrays without changing arithmetic order.
Collision demand, culling ranges, request priority and residency policy are unchanged.

Native regressions compare the packed decoder with the previous per-texel path,
including channels, edge correction, offsets and truncated data. JavaScript
regressions require exact matrix and bounds equality, not approximate geometry.
For an actual-Wasm comparison, save the previous `browser\pkg` separately before
rebuilding, set `WOW_DATA`, then run:

```powershell
node browser\admission-smoke.mjs browser\test-results\admission-before-performance-843621e
```

This checks eight real ADTs across both continents, with 32 alternating admissions
per build. Geometry, placements, material vertices/indices, masks and paths must
have identical SHA-256 digests. Timings cover Rust `add_tile` and its material
stage, not browser uploads or end-to-end frame latency. Private assets remain in
memory; baseline builds and evidence remain local and ignored.

The local `843621e` baseline versus combined `6e01ee3` build passed all stream
digests. With 32 samples per build and uncontrolled OS caching:

| Rust stage (ms) | Baseline | Optimized |
| --- | ---: | ---: |
| `add_tile` p50 | 16.69 | 5.18 |
| `add_tile` p95 | 23.00 | 12.77 |
| Material preparation p50 | 14.24 | 3.03 |
| Material preparation p95 | 18.16 | 5.40 |

The combined checkpoint passes 48 native tests, 145 JavaScript tests, actual-Wasm
roof/rebase/ceiling checks and the actual Edge cockpit/reverse/offline check with
shell cache v24. Local admission evidence is
`test-results/admission-performance-6e01ee3.json`.

Two actual Edge Gold Road runs completed 180 seconds at **default 36/50 yd/s**,
not the 250/500 high-speed target. The final `83a03d3` production
tree is identical to `6e01ee3`; the earlier `e7307f8` run already had the packed-mask
optimization but preceded the ceiling and scalar-transform fixes. Both used
1280x800, DPR 1, fresh browser/worker contexts, video on, sound/profiling off and
180/180 focused seconds; OS cache was uncontrolled.

| Road-run measurement | Earlier | Final |
| --- | ---: | ---: |
| Distance (yards) | 5223.86 | 5186.65 |
| True waypoints / recovery skips | 29 / 16 | 29 / 16 |
| ADT admissions / rebases | 20 / 16 | 20 / 16 |
| Moving freezes over 50 ms | 9 | 6 |
| Worst moving freeze (ms) | 106.2 | 135.1 |
| Client time discarded (seconds) | 0.0112 | 0.0363 |

Fewer freezes did **not** improve the worst tail. The final run also recorded one
12.9 ms unsupported-surface hold. Because the ceiling physics changed between
runs, these are not an isolated timing comparison of the scalar transforms.
They establish sustained ordinary road navigation, not hitch-free rendering or
strict 50 ms/high-speed acceptance. Scene-update work remains a measured tail.

### Cold spawn and mode transitions

Cold spawn uses the active hover height (at least the collision floor clearance),
not a fixed suspension offset. Persisted handling is applied before an unsaved
spawn is reinitialized and revealed; a valid saved pose is restored unchanged.
Switching fly/drive discards unsent time from the previous mode.

With matching Wasm, an isolated server on 4185 and `WOW_DATA` set,
`node browser\startup-smoke.mjs` captures from before opening the source: fresh
spawn, first driving/fly-to-drive, saved reload, and hover-30 startup/reload.
It records authoritative/presented poses, camera/clipping, input backlog and
physics steps, with no warmup. Browser storage is isolated; service workers are
disabled so instrumentation also covers reloads. Private traces/video remain
under ignored `browser\test-results\startup`. This is an onset regression, not
a sustained-driving stall gate.

[ASSETS.md](ASSETS.md) documents the bounded MPQ reader, corruption semantics,
77-file native/Node/Edge parity and the whole-install codec census. All 2,389,542
compressed sectors in this installation used supported zlib; other installations
may require codecs that currently fail explicitly.

Native Bevy render phases, moving-transport timetables, animation and a server
simulation are not ported. Coarse/detailed seams remain visible. Exact native
cockpit seating requires a selected rider's head height and animated attachment
frame; a mount attachment is not a substitute for that missing rider data.

## Clouds

A procedural cumulus slab drawn as one extra camera-following quad in a second, colour-only pass after the scene (no new render targets, textures or art). Each fragment marches eight jittered steps (`NS` in `clouds.js`) through a 520 yd thick layer (a spherical shell at true planet radius at every altitude, no flat variant) centred at 0.8 x 1971 yd (1577 yd; 1971 was measured from terrain tile bounds near Hyjal, not the exact summit). Density is analytic value noise whose column height follows the noise (flat dark bases, puffy lit tops), graded by the daylight uniform. The pass samples the scene depth texture (`textureLoad`, same projection as the terrain shader) and clips each ray march at the nearest terrain/scenery/craft distance with a 350 yd soft fade, replacing the earlier plane-depth test whose bias and 24-bit quantisation could not occlude reliably at range. Alpha-blended water without depth writes is not in that depth, so clouds still draw over it from above. Gate, checkpoint, label and beacon props are alpha/additive with no depth writes, so they draw in their own depth-tested pass right after the clouds (before particles) instead of being painted over by them; the limit is that such a prop is never hidden by a nearer cloud, e.g. seen from above the layer. Lighting is cheap and analytic (no extra density taps): the sun direction comes from the Light.dbc clock (`sunDirection`: east at 6:00, overhead at noon, west at 18:00), cloud tops brighten and undersides take the Light.dbc `cloud2` colour, a forward-scatter silver lining shows on thin edges when looking toward the sun, and the sun band tints the lit side towards sunset. `browser/race-gates-clouds.mjs` captures the sky, gate, inside/above-layer, sunward and sunset views on demand. Vanilla 1.12 has no Maelstrom, so the vortex is **synthetic**: its centre is registered from the user's world map, 43% of the way across the ocean gap and 35%/40% down the Kalimdor/Eastern Kingdoms tile rows (averaged; the two continents are laid out provisionally), see `maelstromCentre` in `browser/clouds.js`. A clear eye, dense eye wall and three spiral arms rotate counter-clockwise as on the map; `MAELSTROM` holds the radii, arm count, pitch and spin. The Clouds setting (default on) is in Controls & settings.

**Cloud quality (Esc, Graphics; default Auto, saved as `racer.cloudQuality` once you pick).** *Auto* (unset) uses High when WebGPU and the High pipeline build, else Standard; if frames average over 30 ms for 3 s while Auto is on, it drops to Standard for the session (an explicit High/Standard choice is never overridden; the guard is whole-frame, not sky-only, and is not re-armed until reload). *High* is WebGPU only, all procedural: `bakeCloudNoise` bakes a tiling 64^3 RG8 noise texture on the CPU on first use (about 0.5 MB), the sheet march takes 20 jittered steps instead of 8 (the existing interleaved-gradient jitter stands in for a blue-noise texture), and each step takes one light tap toward the sun (shadowed pockets, plus a forward-scatter lobe). `cloudShaderHigh` is the same shader with those pieces swapped in; Standard stays the fallback, and a failed High build falls back to it. Measured with `LAB_UNCAPPED=1 node browser/race-clouds-quality.mjs` (writes `cq-<standard|high>-<scene>.png`; frame ms is a mean rAF interval on one dev GPU, so indicative only): about +1.5 ms per frame when sky fills the view (1.7 to 3.3 ms), small when inside or above the layer. Limits: grazing rays far from the camera show step banding (horizontal streaks), there is no powder term or temporal filtering, and cost scales with sky coverage and resolution.

**Storm towers (High only).** The horizontal coverage map is unchanged, but each column's slab now grows with it (`CLOUD_TOWER`: up to +2400 yd above and +160 yd below at full storm density, scaled by a slowly drifting billow noise, `grow` in `sheetDensity`), so arms and the eye wall rise into towering cumulus while low-coverage areas keep the flat 520 yd sheet. The noise also drifts upward about 4 yd/s. The taller slab means 28 steps instead of 20. Standard has `UP=DOWN=0` and renders exactly as before. `LAB_UNCAPPED=1 node browser/race-clouds-storm.mjs` captures a side view from 13 km, a nearer view and a top-down view, Standard vs High, plus a later High frame. Cost: roughly +0.4 to +0.9 ms over Standard on the dev GPU. Limits: towers are columns of one noise slab (no overhang or anvil), and far grazing rays still show step hatching.

**Funnel:** a tapered, counter-clockwise-twisting column (`FUNNEL` in `clouds.js`: top height above the sheet, base/top radius, flare, spin, twist, fade distances) rises from the maelstrom centre far above the sheet. It is one more fullscreen ray-march draw in the same cloud pass, depth-tested against the scene depth, tinted and fogged with the game's cloud/fog colours, and faded out beyond about 170,000 yards. The column now continues down through the sheet to sea level (`FUNNEL.seaLevel`), widening into a mist skirt (`skirtRadius`).

**Whirlpool (visual only):** the ocean shader (`WHIRLPOOL` in `browser/water-shader.js`: radius, core, tilt, spin, twist, arms, pitch) rotates its normal-map coordinates about the maelstrom centre with a twist that grows inward, tilts normals into a bowl, darkens the core and adds counter-clockwise spiral foam arms, faded beyond about 30-90k yards. The centre is passed per frame, relative to the camera origin, in the free `.w` lanes of the sky uniform. The craft is not pulled by it (no drift implemented). **Dip:** the surface is also a real depression. `WHIRLPOOL_DIP={radius:2400,depth:180}` in `browser/clouds.js` is the single source; depth(r)=depth*(1-(r/radius)^2)^2, zero with zero slope at the rim. `browser/ocean-mesh.js` builds a 96x96 displaced patch at the centre plus flat quads; the worker passes the same constants to Rust `Voyage::set_whirlpool`, and open-ocean `sea_height` in `voyage.rs` subtracts the same dip, so the craft rides down into it (ADT/WMO water and all guards untouched). `FUNNEL.seaLevel` is `-depth`, so the funnel and mist skirt end at the dip bottom. Cost: one extra draw, ~9.4k vertices.

## Racing

`browser/race.js` is the pure race state machine (idle, lineup, countdown, running, finished or cancelled) with segment-versus-gate-plane detection; `browser/race.test.mjs` covers it. Tracks are JSON, positions only, render-space yards, yaw in radians with forward = (-sin yaw, -cos yaw): {id,name,mode:'p2p'|'lap',laps,start:{pos:[x,y,z],yaw},gates:[{pos,yaw,width}],breakoff?}. Gates must be crossed in order, in the forward direction, within width and 200 yd height. The default breakoff distance is the maximum pairwise distance between start and gates plus 500 yd; `breakoff` overrides it. `browser/race-flags.js` draws procedural flags (pole, checker banner, tall amber beacon; terrain-pipeline materials 5-8, no game art) beside each track start, loaded from `browser/tracks/*.json` (listed in `TRACK_FILES`). Within 70 yd of a start the prompt "Press F to start race" appears (F otherwise toggles the cockpit); F restores the craft at the start pose through the normal collision-ready path, locks throttle and steering for the 3-2-1-GO countdown, then releases. `browser/tracks/steamwheedle.json` is the hand-authored Steamwheedle Raceway course: 2 laps of 7 gates around the oval south of the spawn, authored from top-down captures and tuned by driving it with a scripted driver in Edge (about 15 s a lap, no collisions, run completes and scores). While racing, the HUD shows elapsed time, the personal best, the split delta against the best run at the last gate (green ahead, red behind), `Gate n/N` and an arrow bearing to the next gate. On the last gate the craft is released immediately and a non-blocking scoreboard (top 10, this run highlighted) shows for 15 s. Scores are stored per track in the browser's IndexedDB (`race:1:<track id>` in the same store as saves, on this device only; `validScores` treats damaged records as empty). Esc opens a Game Menu dialog (Resume, Restart race, Abandon race, Settings; the two race items show only mid-race). It blocks input and pauses the race clock and countdown (`Race.pause`/`resume`); Restart re-teleports to the start with a fresh countdown, Abandon cancels with nothing recorded. Leaving the course by more than the breakoff distance cancels the same way, with no scoreboard. Fly, Overview and the fly toggle are refused in JS while a race exists. The menu is plain styled UI; WoW UI art is not read yet. The hand-authored course follows in the next slice.


### Game Menu

Only the HUD (speed, state, boost), race HUD, prompts, status text and an `Esc - Menu` hint stay on screen. Everything else lives in the Esc Game Menu (also the controller Back button), in tabs: **Game** (Resume, Restart/Abandon race, World map, Track editor, Fly/Drive, Overview, Reset), **Options** (Graphics, Sound and Music, Camera and handling), **Controls** (key and controller reference), **Diagnostics** (live telemetry, only refreshed while its tab is open) and **Data** (Save, Load, Retry loading, Forget/choose another folder). Before a Data folder is loaded the entry panel shows the folder pickers instead. All keyboard shortcuts (N, M, T, F, F9, V, Esc) are unchanged. The entry panel (before a Data folder is loaded) and the menu share an original stone-and-gold theme drawn only in CSS with system serif fonts (no game art, no logos, no downloaded fonts; a data: image would violate the page CSP, so there is none). Handling is an inline section under Options (a `<details>`, not a modal); `save-smoke`/`feel-smoke` still drive the old dialog. After a successful finish (not cancel/abandon) `Press F to race again` shows for 10 s; F in that window restarts the same track through the normal lineup/countdown, then F reverts to the cockpit toggle. Smoke scripts must open the menu (Esc, then the tab) before clicking moved controls such as `#sound`, `#save` or `#fly`.

### Race music and countdown sounds

At lineup the zone music fades out (it stays silent through the countdown). Each count 3, 2, 1 plays the UI click `Sound\interface\iUiInterfaceButtonA.wav`; at GO the quest-accepted sound `iQuestActivate.wav` plays and a looped Battle track starts. The 1.12 Data has no Molten Core music kit, so *Battle* is the Musical Moments set `Sound\Music\Musical Moments\battle\battle01-06.mp3` (found through SoundEntries; one is picked at random and looped). Finish, cancel or abandon fades it out and zone music resumes. Cues and tracks are read from the user's Data at runtime and decoded in memory only (`MusicPlayer.loadCue/playCue`, `setBattle(on,play)`); nothing is stored and no voice recordings are used. The Esc menu has a separate **Music** checkbox (`racer.music` in localStorage, distinct from Sound and the music volume slider) that silences battle and zone music and the cues' music-side playback.

### Gates and track editor

Outside a race only each track's start flag is drawn. During a race only the next gate is drawn (amber pylons and beam; the final gate of the final lap is a checkered finish line) and that track's start flag is hidden until the race ends or is cancelled. The editor draws only the gates of the track being edited (other tracks show as start flags). **T** (or *Track editor* in the Esc menu, refused mid-race) opens the editor: the live world is rendered top-down through the overview flight camera and a transparent canvas draws the route, gates, start and heading handle (`browser/track-edit.js` is the pure model and projection, `browser/track-editor.js` the DOM glue). Tools: Add gate (G), Select/Move (V; drag a gate, drag the blue handle to turn it), Set start (S; drag to aim), Delete (Del), Ctrl+Z undo, Shift+wheel width, wheel zoom, right-drag pan. Name, mode, laps, selected-gate width and heading are editable; breakoff shows as auto. The 3D gates update live and the selected gate is amber. **Test drive** closes the editor and runs the draft (teleport, countdown) through the normal race path; **Save** stores a local override in IndexedDB (`track:1:<id>`, index `track:1:~index`) that replaces the shipped track on load; **Export JSON** downloads `<id>.json` to commit under `browser/tracks/`. **Track list and ids.** The picker lists shipped plus saved tracks and refreshes after Save/Delete; `+ New track here` starts a blank draft. A new track gets a unique id on first Save/Test/Export (`uniqueId`, never `new-track` or an existing id) and keeps it when renamed. Switching tracks with unsaved edits asks first; closing the editor keeps the draft so reopening restores it. Saved ids that shadow a shipped track show **Revert to shipped**; others show **Delete track**. **Height:** gates sit above the higher of ground and water: new gates 20 yd, adjustable 5-150 yd via *Height above ground/water* (`CLEAR_MIN/DEFAULT/MAX` in `track-edit.js`); dragging re-snaps with the same clearance, and test drives clamp stale saved heights to the current ground (`clampTrack`; points in unloaded tiles stay as saved). Test drives of a shipped id record scores under that id.

### Vehicles

`browser/vehicles.js` is the vehicle registry: `free-flight` (no races), and `podracer`, each with id, name, display stats and `skins[]` (`source`: `data` = authored model read at runtime from the user's Data, `glb` = original model shipped in `browser/vehicles/`, `procedural`, `none`). Tracks carry an optional `vehicle` (`podracer`, the only class; `validateTrack` rejects anything else, and the track editor has a Vehicle select). Race flags, the "Press F to start race" prompt and gates are only shown for tracks of the **active** vehicle (`tracksFor`); the track editor shows every track. The active vehicle and skin persist in localStorage (`racer.vehicle`, same place as the night and music settings; bad values fall back to podracer / Rocket). Switching is allowed only in the open world (`canSwitch`: not while a race is lining up, counting down or running, nor while editing). **Garage:** Esc > Game > Garage or the **G** key (J is already hop) opens a tabbed dialog (vehicle tabs, skin list, stat bars, the races for that vehicle); Use vehicle applies and saves it. Skins whose `.glb` is not installed are disabled. Choosing Free flight starts the free camera; picking any other vehicle returns to driving. Starting a race for a track of a different vehicle (e.g. editor Test drive) switches to that vehicle first. **Models:** original vehicle models live in `browser/vehicles/<skin-id>.glb` (binary glTF 2.0; embedded textures only, triangles, <=120k vertices/indices; 1 unit = 1 yard, glTF -Z is forward, +Y up). Node names `Cockpit` (seat/eye), `EngineL`/`EngineR` and empties `ExhaustL`/`ExhaustR` (flames are drawn there, longer with speed). They are fetched at runtime (`glb.js` parser, `vehicle-model.js` loader), copied into `dist/` by `build-dist.mjs` when present, and deliberately not in the service worker precache (so a missing file cannot break install; they are not available offline yet). Any load failure (404, SPA fallback, bad file) keeps the Data rocket and shows a note in Diagnostics. The rocket stays the default; no GLB skins ship now (the custom dug-racer models were removed), the loader remains for any skin that sets `model`.



**Craft shadow.** There was no shadow map or blob shadow before. `browser/shadow.js` adds one fullscreen pass after the scene (like clouds) that reads the scene depth, rebuilds each pixel's world position and darkens it where it lies under the craft along a fixed sun direction: an ellipse oriented to the craft yaw, sized from the model bounds (fallback 5x3 yd half-extents), sliding along the sun, softening and fading with height above the surface and gone beyond 500 yd. It follows any surface (terrain, water, scenery) without a ground probe and applies to every skin; settings.shadows=false disables it. The sun direction is fixed, not the time-of-day sun.

**Gate crossing.** Gates trigger on a swept segment-vs-plane test between consecutive samples (any speed or frame gap; one step can pass several gates in order, split times interpolate), forward direction only, inside the gate width and height tolerance. Teleports/respawns call `race.jump()` so they never count. The last gate of the last lap (`race.finishing`) draws the checkered banner.

**Track normalizer.** `WOW_DATA=<Data> node browser/tools/normalize-track.mjs [--write | --out f] <track.json> ...` boots the app in headless Edge on port 4183 (its own server), flies the camera over every gate so its tile loads, samples the real ground/water with the same `probe` the editor snap and `clampTrack` use, and sets each gate to `max(ground, water) + 20 yd` (the start is only raised if below the surface). It prints per-point old -> new deltas, never guesses (a gate whose tile never loads is reported and the file is not written, exit 1), leaves yaw/width/ids/order/vehicle/laps untouched, is idempotent, and writes steamwheedle-style JSON (2 spaces, CRLF, trailing newline). Dry run unless `--write`/`--out`. The pure rule is `track-normalize.js` (unit-tested).

## Star Wars Episode I: Racer data (optional, local only)

The welcome panel has an optional **Star Wars Episode I: Racer folder** row (game root, `data`, or `data\lev01`; remembered like the WoW folder under its own IndexedDB key, Firefox re-picks). Nothing from that game is shipped, committed, or uploaded; the hosted build contains only the parser code and works without the folder. `browser/swe1r/` is a clean-room reader: `block.js` (big-endian `out_*block.bin` containers), `comp.js` (the `Comp` LZ77 stream; this Steam v1.0 install has no Comp stream in any of the four blocks, so the decoder and its LSB-first bit order are UNVERIFIED against real data: they follow the docs and are covered only by a synthetic test), `image.js` (sprite/texture pixel formats, sprites are 64x32 tiles laid out row-major with rows bottom-up inside each tile), `names.js` (item names derived from the MIT-licensed `akopetsch/swe1r-assets` metadata, Copyright (c) 2024 Alexander Kopetsch; names drift from index ~230 in this install, so the CLI only trusts a name whose tag matches the file). Debug: `node browser/swe1r/cli.mjs "<...>\Star Wars Episode I Racer\data" list|sprites [outDir]` (previews default to git-ignored `runtime/swe1r`). Tests: `SWE1R_DATA="<...>\data" node --test browser/swe1r` runs the real-install cases; they skip when unset.

The Garage skin picker is a compact carousel (◀ name · n / N ▶; Left/Right arrows or A/D while the Garage is open; wraps; skips skins whose model file is missing). Order: Rocket, then SWE1R pods (the old custom dug-racer GLBs were removed; a saved dug-racer skin falls back to Rocket). Pods bank into turns: steering left lowers the left engine (render fix in craftMatrix; physics bank is negative for a left steer).

**Pod render harness.** `render-smoke-pod.mjs` (needs `SWE1R_DATA` and `WOW_DATA`, skips otherwise; Edge via Playwright; server on `PORT=4183` running) loads every podracer skin (Rocket, all SWE1R pods), parks it at the spawn with HUD/shadows/clouds/night off (test-only `worldTest.showCraft/settings`), shoots front/side/three-quarter/top/rear and writes `runtime/pod-renders/{report.json,index.html,*.png}` (git-ignored, local only). Checks: load errors, NaN/empty geometry, size in yards, blank or magenta frames, console errors, and per-skin texture stats (referenced vs. kept by the 16-texture cap, untextured meshes). The ground is the spawn terrain, not synthetic flat ground. Known pod defects (TODO): 14 of the SWE1R pods exceed the 16-texture cap; textured pods render with garbled colours (vertex colour/texture mix-up); model 254 ("Sebulba") is a 46-triangle stub, not a pod; "Jinn Reeso" (name drift) is not a pod in this install; no flames; no lighting; cockpit marker approximate.

**Attaching the Racer folder (any time, any order).** The Racer row lives on the welcome panel and moves into Esc > Data once the world runs; the Garage also shows "Attach Racer folder" while none is attached. Attaching late never reloads or resets the world: skins, the SFX toggle and the HUD toggle appear immediately, and Forget removes them (a Racer skin in use falls back to the Rocket). Wrong folders show an error and leave the current data alone; attaching again replaces it. Chromium's directory picker refuses folders under Program Files, Windows and AppData (so a Steam install is rejected, usually as a "contains system files" dialog followed by a plain cancel); the error text explains this and "Choose as files" (a `webkitdirectory` input, no blocklist) reads the folder instead. Files picked that way are copied into this browser's IndexedDB (`swe1r-cache`: the three/four `out_*block.bin` files and every `wavs\22K` wav including Voice, plus `wavs\Music`: smallest tracks first within a ~100 MB budget, so the race loops and stingers always fit), skipping files whose size and mtime are unchanged, one file per tick so driving stays smooth. On reload the Racer data restores from that cache with no picker; Forget clears the cache and the remembered handle. The cache is local to the browser profile, never uploaded, committed or shipped. The WoW Data picker has the same blocklist and now shows the same hint with "Choose folder as files" (the WoW files are too large to cache; Chromium pickers on a copied or junctioned folder keep persistence). Unit tests: `swe1r/attach.test.mjs` (a handle attach also caches the loops and stingers it plays, one per tick; `Music/<name>` falls back to the cache; state machine, error classification, cache read/write with an in-memory backend, not real IndexedDB).

**Pods as Garage skins (S2).** With the folder loaded, the Garage podracer tab gains 25 racer skins. Paired high-detail `Podd`/`MAlt` assemblies are the default in the garage, races and flight; the old lower-detail racer rendering/fallback path and quality switch are removed. `model.js` resolves child-slot replacements and the finest drawable branches; `assembly.js` registers complete native engine/cockpit instances and their connectors. `pod.js` decodes F3DEX2 geometry and up to 64 local textures with original mirror/clamp addressing. `skin.js` maps model +y forward to craft space at 1/600 yd per unit. Camera/exhaust/fan anchors and physics hit boxes are unchanged; audited radial fans animate and the existing particle system owns exhaust. Missing data reports an error and uses the ordinary default craft. These are calibrated static presentation poses, not reconstructed original-game live articulation. See [the assembly/intake audit](swe1r/intakes.md) for all 25 pods, limitations and validation commands. Skins are built in memory from your own install, never persisted or shipped, and require reattaching the folder after reload.

**Sound effects (S3).** The folder's `data\wavs\22K` (257 plain 16-bit PCM mono 22 kHz wavs; `Music\` is not used) feeds the podracer sounds, read into memory and decoded by Web Audio only: engine loop `sfx_pod_varipitch_d_loop` (playback rate follows speed and thrust), boost `sfx_pod_jet_steady_loop` (gain follows boost), countdown `sfx_start_beep`, GO `sfx_start_game`, gate `sfx_pod_switch_a` (names in `swe1r/sfx.js`). They replace the synthetic engine layers while the Sound menu's "Racer sound effects" box is ticked (shown only when the folder is attached); our synthetic sound is the fallback and the hosted build ships no audio. Per-pod engines: Anakin's pod loops `sfx_pod_ani_buzzy_b_loop` and Sebulba's `sfx_pod_seb_sdb_loop` (`POD_ENGINES`); other pods keep the generic loop. The loading screen also waits (max 15 s) for the nearest 4 terrain chunks (`loading-gate.js`), and the Maelstrom map waypoint now drops you above the tallest cloud towers (`CLOUD_TOP_DROP`). The mapping is by filename guess and unrated by ear beyond a level check; pick the folder root or its `data\` so `wavs\22K` is found. Not covered: crash/collision, hop, drift and ambient sounds.

**HUD dial (S4).** A small canvas dial replaces our speed readout while the folder is attached and the Sound menu's "Racer HUD dial" box is ticked (untick for our original HUD, which is also the hosted/no-folder default). It is drawn from spriteblock entries 28 (ring) and 29 (face), the left half of a circle each, mirrored, with a code-drawn needle (270 deg sweep to boost speed) and boost bar. Honest limits: this is an approximation, not the original layout (the spriteblock has no assembled speedometer; names in community lists drift, so swe1r/hud.js checks 64x64 dims), the gauge halves are placed by eye, our state and boost readouts stay, and no menu/countdown/lap sprites are used yet. Sprites are decoded in memory only.

**Race SFX and countdown (S5a/b).** With the folder attached, one-shots fire on edges: boost ignition (`sfx_pod_flare_fire`), airbrake on/off, obstacle contact (`sfx_crash_metal_med1`, 0.5 s cooldown) and the finish (`sfx_payoff_bell`); they follow the Sound menu's Racer-sounds box. The `Racer HUD` box also swaps the 3-2-1 countdown text for SWE1R sprites 19-21 (GO stays text; there is no GO sprite). Surface loops are not wired. Race-end stingers come from `wavs\Music`: a finish plays `m099awards2`, a cancel plays `m032wipeout2/3` (the zone/race music stops first); Music is read from the picked folder or files only, not the IndexedDB cache, so it is silent after a cache-only restore.

**Sound browser.** `node swe1r/sound-browser.mjs` (`SWE1R_DATA` set) serves http://127.0.0.1:4185/ listing all 2479 wavs (22K, 11K, Music, Voice) with durations, a text filter, play and autoplay-next; read-only, nothing copied.


**Voice lines (S5c).** `node swe1r/audition.mjs` (with `SWE1R_DATA` set) serves a local tagging page at http://127.0.0.1:4184/ for `wavs\22K\Voice`: space plays, n/p step, 1-9 assign a recent tag, prefix filter, autoplay. Tags save to git-ignored `runtime/voice-tags.json`; Export writes ids only to `swe1r/voice-map.json` (no audio). The race wires countdown-3/2/1/go, lap-new, final-lap, personal-best, finish and cancelled to a random tagged id (never the same twice running, one line at a time; silent when untagged or no folder).


**Ray-march sweep (`clouds-sweep.test.mjs`).** `cloud-march.js` mirrors the fragment shader's sheet march in pure JS; a seeded Monte Carlo (3000 cameras per tier: full world extent, -500..25000 yd, random/grazing/vertical angles, times, coverage) asserts finite in-range output, bounded change under tiny camera/angle moves, no horizon gap, no hard span-cap cut, alpha growing with march length, slab reach and noise continuity; a parity test keeps the shader expressions in sync. Found and fixed: (1) rays with |dir.y|<=.0005 inside the slab rendered nothing (a bare band at the horizon) - the slope is now clamped; (2) the 9 km span cap ended the march hard (a pop) - the last 45% of a capped march now fades out; (3) colour could exceed 1 on sun glints - clamped. Limits: the JS port uses the Standard analytic noise for High; 8 (Standard) / 28 (High) steps still alias on long grazing paths (judged on the jitter mean, not per ray); f32 GPU vs f64 JS.

**Above-layer look-down fix.** From high altitude the High tier's light tap read saturated tower tops as self-shadowed (a flat grey plateau with a hard edge to cream sheet clouds); shadowing now fades out near the top of each column (`smoothstep(.7,1,hf)`), and the span-cap tail fade scales with how much was actually cut (no pop at the cap boundary). The brown cone is the intended whirlpool funnel mesh, not a tower artefact. Remaining: the cliff between tower tops and the thin sheet is real geometry, and tops still show step dither. Repro: `node race-clouds-above.mjs <tag>` (run from `browser`); regression in `clouds-sweep.test.mjs`.

**Far sheet below a tall High slab.** The High slab spans the storm-tower range (about 1300 to 4000 yd), and the 9 km span cap ended shallow rays inside the empty tower air, so low-coverage areas lost the sheet while storm areas (which have towers) kept clouds: clouds looked culled on one side. High now caps at 40 km (coarser steps, still 28; the tail fade covers the cut). Regression: `far sheet stays visible` in `clouds-sweep.test.mjs`. Limit: far sheet steps are ~1.4 km, so distant sheet is soft.

## Crash wreck (default on; `Ctrl+Alt+K` forces one)

On the rising edge of obstacle contact (telemetry 8 = 3, "Obstacle or steep ground") with a pre-contact speed of at least the Esc menu "Crashes" slider (default 100 yd/s, 20-400; persisted in localStorage `racer.gib`/`racer.gibSpeed`), the craft is wrecked for ~2.6 s and input is ignored meanwhile; afterwards it reappears where it stopped (no respawn, race clock keeps running, 5 s cooldown). With the SWE1R folder attached and Racer sound effects on, `wipeoutBlast` plays one `sfx_explo_gas_*` plus one metal/firey crash. Details of the wreck below.

`Ctrl+Alt+K` (or `worldTest.testCrash()` with `?test`) wrecks the current craft for ~2.6 s: the front is dented, then pod, left engine and right engine become box rigid bodies that fall and bounce on the real ground/water height. Each engine is randomly tethered to the pod or loose. The sim is `flats-racer-physics/src/wreck.rs` (shared with native, cargo-tested), run by the worker in 0.5 s chunks (`wreck-start`/`wreck-run`) and replayed by the renderer. It never fires automatically and does not change race flow. Rough: no tether/spark visuals, normals not recomputed after the dent, parts split by a spatial heuristic, the real craft keeps simulating underneath.

## Weather

Precipitation cells are a deterministic field coupled to cloud density (`weather-field.js`, `weather-wgsl.js`);
about 30% of dense cloud rains. Climate per zone (`weather-climate.js`): dry zones get none, snow only in snowy zones
(falling flakes, no accumulation), Elune weatherless, Maelstrom always heavy rain except the calm eye, no precipitation
in space/orbit. Rendering: distant curtains under cloud (`weather-curtain.js`), a near-camera particle box that
envelops (`weather-particles.js`), lightning bolts/flash and delayed thunder (`weather-lightning.js`, `weather-bolt.js`),
procedural rain audio (thunder uses the WoW `ThunderClap.wav` cue at runtime, synth fallback).
Settings: Graphics > Weather checkbox and quality (auto/low/standard/high; Low is a small near box with no curtain,
auto drops tiers on slow frames). Lab hooks: `worldTest.weatherArea`, `weather`, `weatherFind`, `strike`;
screenshots via `node race-weather.mjs <distant|envelop|snow-dun-morogh|snow-winterspring|lightning|maelstrom>`.
Design and limits: `design/weather.md`.

## Public static hosting (GitHub Pages / Cloudflare Pages)

The app is static: it needs no server, and the player's own Data folder never leaves their machine.

- **Build:** run `Build.ps1` (Wasm package), then `node browser/build-dist.mjs [outDir]` (default `dist/`, git-ignored). The file list is generated from the import graph by `shell-manifest.mjs` (and stamped into `sw.js`, whose cache name is the manifest hash), plus `_headers` (Cloudflare/Netlify headers: CSP, `no-cache` for `sw.js`/`index.html`) and `.nojekyll`. Tests, smoke scripts, `server.mjs`, `runtime/`, `local/`, SQL and any game data are never copied; `build-dist.test.mjs` checks the list and that every static import is hosted.
- **Subpath:** every URL is relative (`./`), so `/vanilla-world/` works; the service worker registers at `./sw.js` and its scope is the page's directory. `.wasm` needs `application/wasm` (both hosts send it). The CSP is also set as a `<meta>` tag for hosts without header control.
- **Private NPC pack:** `/local/npc-spawns.json` is only requested on `localhost`/`127.0.0.1`. Hosted pages never ask for it, and a 404 or an HTML fallback (200) just means no creatures.
- **Deploy:** `.github/workflows/pages.yml` builds Wasm, runs the JS tests, builds `dist/` and deploys with `actions/deploy-pages` on pushes to `main`. In the repository, set Settings > Pages > Source to **GitHub Actions** once. For Cloudflare Pages, build command `node browser/build-dist.mjs dist` after the Wasm step, output directory `dist`.
- **Verified locally:** `dist/` served by a plain static server under `/vanilla-world/` (404 and SPA-fallback variants, plain and with a non-loopback host name) in Edge: entry panel, Data-folder pick, driving, service worker scope.
- **Audit notes:** tracked `browser/` files contain no game art, credentials or absolute local paths. `export-npcs.py` and `runtime/` stay local and ignored; the repository also contains the upstream VMaNGOS `server/` tree and SQL, which is separate from the hosted build.

**Boost sound.** With the Racer folder attached, Shift plays the start one-shot once per press, then a sustain loop while held (`BOOST` in `swe1r/sfx.js`). To A/B other start+loop pairs run `node browser\swe1r\sound-browser.mjs` (with `SWE1R_DATA` set) and use the Boost A/B buttons at http://127.0.0.1:4185/.

**Map.** M opens a non-modal, transparent world map over the live world: driving keys keep working, icons (Raceway, Maelstrom, Ironforge airport, and the Stormwind, Orgrimmar, Undercity and Darnassus city gates) teleport on click, M or Esc closes it.

**Pod texture cap.** The old 16-texture limit on SWE1R pods is lifted (craft payloads accept 64; pods use 16-28), so every material is textured. Remaining garbling (purple/green noise on engines and cables) is a separate decode issue, not the cap.

**Wreck velocity.** Gibbed parts inherit the craft's pre-contact velocity (30-80% per part plus 8% scatter); Ctrl+Alt+K uses the current velocity.

**Top race banner.** While racing, a curved Racer-style band at the top shows LAP n/N (left), TIME m:ss.cc (centre) and POS (right, always 1/1: there are no AI racers, slot kept for layout), with best, split delta, last/best lap and gate/arrow underneath. It is own art (SVG/CSS) for everyone: no teal-band sprites exist in the Racer data (see `hud-ground-truth.md`). Lap/finish banners now show without the Racer folder too. `hud-top-shots.mjs` (WOW_DATA) checks 4:3, 16:9 and 360 px for overlaps and writes shots to `runtime/hud-top`.

**Master volume.** Esc > Sound has a Master volume slider (default 50%, saved as `racer.masterVolume`; no saved value means 50%). It drives one shared output gain (`context.masterOut`) that engine/SFX/voice (via the WorldAudio master) and music/cues all feed, so per-channel mixes are untouched. Curve is perceptual, amplitude = v^2: 50% is 0.25 (about -12 dB, so quieter than before by default), 100% is unchanged. `master-volume-probe.mjs` checks default and persistence.

**Death lock and respawn.** While a wreck plays (`wreckLocked()`: the wreck request or the 2.6 s debris), all input is ignored (throttle, steer, boost, drift, hop, and right-mouse drive, which previously re-applied throttle/steer after the wreck zeroing) and no physics frames are sent, so the pod is frozen and hidden. When it ends the pod respawns at the same spot 10 m up (Unstuck poses), at rest, repaired and cooled (`repair` flag on `restore`; plain Unstuck still keeps health/heat). Previously nothing respawned the pod and physics kept ticking under the wreck. `wreck-lock-probe.mjs` (WOW_DATA, server on PORT) holds W+Shift+J+C+right-mouse through Ctrl+Alt+K and overheat-to-engine-death wrecks and asserts the pod does not move and respawns repaired. Impact/steep-ground gibs share the same `testCrash` path (not driven in the probe).

**Engine durability (Esc > Crashes > Durability, default on).** Two engines (left/right pod) each hold health 0-100% in the Rust State (telemetry [15] left, [16] right). Heat >= 0.9 drains 0..0.15/s (full heat kills an engine in ~6.7 s), split 60/40 so damage is asymmetric. Hitting an object or steep ground (contact 3) costs (speed-20)/(lethal-20) of the engine on alternating sides, using the pre-contact speed in **yd/s**; lethal is the Esc 'Impact speed' slider (default 100 yd/s, about 205 mph; 1 yd/s = 2.05 mph; not rescaled), and at or above it the pod still breaks apart instantly. Either engine at 0 wrecks the pod (healthTrigger). Respawn/wreck restores 100%; Unstuck keeps it. Each engine panel (own art and SWE1R sprite) is coloured from the worse of shared heat and that engine's damage (1 - health: yellow from 0.5, red from 0.8, blinking at 1), so damage shows asymmetrically. Both bottom groups (engine pair, speed dial) are ~1/6 of the viewport width (clamped 96-320 px, 14 px/safe-area margins) at the Racer ratios (engine pair 67:62 from two 27x62 panels with a 13 px gap; dial 71:59), via --hud-w for own art and layoutHud() for the sprite canvases; hud-size-shots.mjs (MODE=real|own) asserts widths/ratios/no-overlap at 4:3, 16:9 and 360 px; hud-element-shots.mjs / hud-real-shots.mjs add panel-damaged / panel-critical. Durability off: no damage and the old 'Overheating blows the pod up' behaviour. No passive repair.

**Race HUD parity and engine heat (SWE1R folder attached, under the Racer HUD box).** On-screen lap counter (`LAP n/N`), last/best lap times, and banners (lap, final lap, lap record, finish) sit in the race panel. The boost meter is re-framed as engine **heat** (there is no boost tank: boost is unlimited while held; heat rises 0.4 per 3 s of boost, so 7.5 s reaches 100%, and cools in 10 s; `HEAT_RISE_PER_SEC`/`HEAT_COOL_PER_SEC`; no saved boost setting existed so nothing to migrate; restoring a pose such as Unstuck keeps heat). A second dial (sprites 30/32) shows heat with a needle and tint; at >= 80% the ring pulses and a klaxon loop plays (`sfx_klaxon1/2/3_loop` at 80/90/97%). While venting after a hot run (heat reached 50%) `sfx_pod_coolant_spray_on` plays then `..._loop` until cold. Boost stays allowed through the warning; hitting 100% blows the pod up through the crash-gib path (same wreck and wipeout blast, 5 s cooldown). Esc > Options > Crashes > "Overheating blows the pod up" (on by default, saved as `racer.overheat`) turns the explosion off: boost stays unlimited and heat just caps at 100%. Heat, gauge, audio and explosion are SWE1R-folder-only (hosted/Rocket behaviour is unchanged). `node browser\hud-smoke.mjs` drives all of it in Edge (screenshots in `runtime\hud-shots`). Rust: `State.heat` (telemetry[6]) and `HEAT_WARN`.

**Hit flash and boost lines (Racer HUD, SWE1R folder).** A red vignette flashes for 0.45 s on an obstacle contact at >= 30 yd/s (strength by speed) and on any crash/overheat wreck; blue speed lines ramp in while Shift boost is held and fade out afterwards (`hitFlash`/`boostFx` in `swe1r/hud.js`; `hud-smoke.mjs` asserts both).


**Particles (all skins, hosted site too).** rowser/particles.js is one shared layer: a 2048-slot CPU ring buffer (oldest particle overwritten) of billboards drawn in a single instanced pass after the clouds, depth-tested read-only, with premultiplied colour so fire/plume (additive) and smoke/dust (alpha) share one blend state. Esc > Options > Graphics > Particles (Off/Low/Medium/High; scales emission, default Medium) is saved with the other settings. Kinds: plume, fire, smoke, dust, burst. Effects are synthesised, so no SWE1R folder is needed. `node browser\particles-smoke.mjs` (muted Edge) checks the pass draws and the option; screenshots go to `runtime\particle-shots`. **Thrust plumes:** every craft emits a hot blue-white to orange plume from each engine's exhaust. There is no flame data in the SWE1R pod models (the original draws engine glow as sprites we have not decoded), so emitters are derived from the mesh (rear nozzle slice of each engine group - the rearmost x-slice at least half as wide as the engine, so thin tethers/struts poking out behind do not count - else one at the tail; craft metadata `exhausts` wins). Rate and push scale with throttle, boosting makes them denser, longer and larger; particles keep the craft's velocity so they trail in the world. **Wreck and heat effects:** the pod breaking up spawns a fireball burst plus an outward smoke column; each debris part burns for 1.4 s, smokes for the whole 2.6 s wreck and puffs dust when it lands (downward speed lost in a frame); with the SWE1R folder, smoke curls off the engines from 80% heat, growing to 100% (the existing warning klaxon band). `particles-smoke.mjs` asserts the burst/fire/smoke and the heat smoke. **Plume audit (agents: rerun after any plume/emitter change).** Start the server on an isolated port (`PORT=4183 node browser\server.mjs`), set `WOW_DATA` and `SWE1R_DATA` and run `node browser\plume-audit.mjs` (muted Edge, ~13 min for Rocket + 25 pods; `ONLY=swe1r-254,rocket` reruns a few). It loads every craft, takes the renderer's real emitter points, runs `browser/plume-check.js` (engine count, emitter off the engine axis or floating behind the engine, merged emitters, left/right asymmetry, emitter buried in the hull) and writes to the git-ignored `runtime\plume-audit`: `report.json` (points, engines, flags, metrics per craft), `shots\<id>.png` (boosting, rear view), `game-N.png` (labelled 3x3 contact sheets, ⚠ = heuristic flag) and `schematic-N.png` (side/top/rear vertex scatter, body grey, engines blue/green, emitters red with plume arrows). A reviewing agent should open the sheets and judge each pod (two separate plumes from the rear of each engine nozzle, not the tether, not the cockpit). `hull-occluded` flags on engines that sit in front of wings/fins are expected noise. **Ground dust:** a grounded craft above 5 yd/s kicks up a brown dust trail from its rear that thickens and grows with speed (20 to 130 puffs/s, 170 drifting before the Particles quality multiplier, world-stationary so it trails behind); drifting (Space/C) above 25 yd/s kicks up a heavy sideways-thrown cloud. Tint is one default dirt tone and water is not detected (the renderer has no cheap ground/water query), so there is no spray yet.

**Creature skinning check.** `cargo run --release -p benilla-formats --example rig_scan` (needs WOW_DATA; optional name filter) poses every rig-eligible `Creature\*.m2` Stand/Walk at four times and lists models whose posed vertices stray from the bind bbox or stretch triangles; `rig_dump` dumps one model's bind vs pose for plotting. It found that skinned vertices with a zero authored normal (52 of 414 models, e.g. WindSerpent) were reset to bind while neighbours moved, tangling wings and necks; they now follow the skin and keep the bind normal.
**Public NPC pack (optional, not published).** See "NPC pack provenance" in SCENE.md. `python export-npcs.py <sql> runtime\browser\npc-pack.json --public` writes the trimmed pack; hosted pages request `./npc-pack.json` and fall back silently when it is absent; unit tests: `npc-pack.test.mjs`, `export-npcs.test.py`.

**Humanoid parity.** `SceneActor::decode` now applies the same baked-body filtering as the static `character\` mesh (Body slot from `skins[3]`, untextured equipment/hair cards dropped); before, the vertex counts differed so `posedAsset` silently kept the bind pose and humanoids slid. Rust test: actor stream == static mesh, and the Stand pose changes over time.
**Real SWE1R HUD pieces.** With the SWE1R folder attached the bottom HUD uses the game's own sprites (block index = community swrSprite id): engdisp3 panel (49, twin, tinted by heat stage), dial capsule (104), heat arc gradient (99, filled bottom-up by heat), lamp (101). Hosted/Rocket keep the own-art SVG. Isolated shots: `node browser\hud-real-shots.mjs` (needs SWE1R_DATA, muted Edge, output git-ignored in `runtime\hud-real-shots`; never commit them). Details and ruled-out leads: `hud-ground-truth.md`.

**Bottom HUD.** Layout ground truth: `hud-ground-truth.md`; isolated shots: `node browser\hud-element-shots.mjs` (muted Edge, `runtime\hud-element-shots`). Two clusters, nothing else at the bottom: a pair of tall engine panels bottom-left (own SVG icon; green below 50% heat, yellow 50-80%, red from 80%, blinking at 100%; no per-part damage model) and one oval speed dial bottom-right (big italic speed number, green lamp that turns red from 80% heat, and a thick heat arc down the right side over a faint track: purple, amber from 50%, red from 80%, rim/lamp blink at 100%; there is no boost bar because boost is unlimited). Heat is telemetry[6] (`hud-model.js`, warning from 80% like `sfx.js heatStage`; both engines share the one heat value). Vision review of the isolated shots against the user's reference screenshot: panels judged a match; the dial was iterated three times (oval, number style, arc, lamp) and remains a close-but-not-pixel match. Drawn in CSS/SVG (our own art, hosted-safe); with the SWE1R folder and Racer HUD on, the original sprite gauges replace them in the same corners. The old HOVER label, Boost % box and unit/direction text are gone; a small note above the dial only appears for FLIGHT/WAIT/CONTACT/NO GROUND.

**Flight instruments (right edge).** Above the speed dial, always on while a world is loaded and not part of the Racer HUD toggle: a round compass, a drum-roll altimeter and a signed climb-rate number, with no other labels or bars. The compass card turns so its gold arrow points at the north pole of the **nearest** body (Azeroth or Elune, whichever surface is closer); the cyan tick at the top is your heading, so it is correct relative to the craft/camera on the ground, in orbit and in the N/S pole charts, and shows a dot when the pole is straight overhead. The drum reads yards above that body's mean surface (5 wheels, growing to 7; units roll smoothly, higher wheels only turn on a carry). The number below is the smoothed climb rate in yd/s (+/-; tau 0.35 s, restarts on teleport or body swap). Math: compass.js (pole bearing), ltimeter.js (drum, climb), DOM in light-hud.js; tests compass.test.mjs, ltimeter.test.mjs. WoW art is optional and loaded at runtime from your Data folder by the worker (hud-art.js, nothing is bundled): the gold ring from Interface\Minimap\UI-Minimap-Border.blp (cropped, drawn to a canvas) and the Fonts\FRIZQT__.TTF digits; without them the CSS/SVG ring and the page serif stay. It sits at the right edge above the dial (offset by --hud-w), below the race board and clear of the boost bar and gate guide.

**Humanoid geosets.** `character\` NPC models render one variant per geoset group instead of every submesh (which showed the robe/skirt over the legs). `npc-pack.js addGeosets` asks `scene_character_geosets` for each humanoid display (CreatureDisplayInfoExtra equipment + ItemDisplayInfo geoset groups, robe/skirt only when chest/pants say so, otherwise trousers 1301) and stores `models[id].geosets`; the list is part of the model key. Not resolved: hair styles (CharHairGeosets), helm hide-masks, cloaks; hair/equipment cards are dropped as untextured.


**NPC animation (Esc > Options > Animate NPCs, default on).** `browser/actors.js` re-poses the Stand loop of nearby (120 yd) NPC models in the world worker with the Rust `SceneActor` rig and posts whole vertex buffers; the renderer swaps them in per (model, phase) group (3 phases, <=16 groups, <=24 models, 2 ms/tick, 8 MB). Models the rig cannot pose (e.g. humanoids with global bone tracks) stay in bind pose; `worldEvidence.state.actors` shows tick time, groups, bytes and the last failure. Smoke: `WOW_DATA=... node actors-smoke.mjs` (muted Edge, server on 4183). Phase 0 fix: the Rust actor loader rejected NPCs with 4 skin slots (baked humanoid texture) - the cap now matches the JS validator.

**NPC wandering (same toggle).** `browser/wander.js` is a pure (id, home, wall-clock) path: critters (model-path name list) always wander within 8 yd, humanoid `character\` models wander 20% of the time within 5 yd (guards/vendors cannot be told from civilians - the public pack has no creature type), everything else stands. Each 100 ms tick the worker samples terrain under the path (`world.surface`) and holds the NPC when the ground is missing/water, differs >2 yd from home or is steeper than 1.2; the renderer extrapolates the posted position by velocity and swaps it into the instance matrix (visual only, no collision, no walk clip yet so they slide in the Stand pose). Terrain-only ground: NPCs on WMO floors above carved terrain keep their authored height (`homeErr` in `worldEvidence.state.actors` shows the difference).

**NPC rigs (global tracks / parent arms).** The actor rig no longer rejects models with global-sequence bone tracks (the humanoid eyelid blink) or billboard/parent-arm bones; those bones keep their rest pose, so humanmale/humanfemale and similar now pose Stand. Near Stormwind 20 models animate and 0 fail (was 5 animating, 11-13 failing). Rust test: `human_male_rig_poses_stand_and_walk` (needs WOW_DATA).

Walking NPCs (wander phase 3): a wanderer that is moving plays its model's Walk clip (anim 4) from a separate shared pose group, at speed / (Walk moveSpeed x scale) so feet do not slide; it falls back to Stand when the model has no Walk clip or moveSpeed. Facing turns toward the path heading at WANDER.turnRate rad/s instead of snapping.

NPC motion defaults were too timid near the tracks (only critters and 20% of character\ models wandered, 16 pose groups starved most models). Now critters always wander (8 yd), character\ NPCs 50% (6 yd), every other Creature\ model 35% (5 yd), legs of 8-16 s; one pose group per nearby model is granted before extra phases, 32 groups/models. Probe: rowser/test-results/track-npc-probe.mjs (muted Edge at each bundled track start).

Unstuck: Esc menu button or U teleports the craft 10 m (10.94 yd, the world unit) straight up via the normal restore path (velocity zeroed, no wreck/gib); if that spot overlaps collision it retries at 2x then 4x. NPC animation now re-poses every 40 ms (was 100) and rotates which groups a spent 2 ms budget serves, so loops look smoother.

**Energy-binder beam (SWE1R pods only).** Ground truth from the model data: 23 of the 25 racer pods (not 260 or 268) carry the binder as one 2-triangle quad spanning the engines, textured with the 64x16 pink-arc texture 815 (alpha, no scroll or animation fields in the material or model). Racer itself animates nothing we can read from data, so the web renderer does: swe1r/pod.js tags that batch `beam` (additive, emissive), and the scene shader scrolls the texture and flickers its brightness. eam.js `beamState` maps throttle/boost/heat to brightness, heat above 60% or an engine below 60% health to a jittering arc, and an engine at 0 to a dark beam with rare sparks. Rocket, hosted and non-Racer craft get no beam. On-demand spot check (not part of plume-audit): `node browser/beam-shots.mjs [swe1r-255 swe1r-260]` writes idle/boost/overheat/damaged/dead shots to git-ignored `runtime/beam-shots`; `worldTest.beamFx({throttle,boosting,heat,health:[l,r]})` forces a state.
## Planet view / space (Phase A, fly mode only)

Rising in fly mode shows Azeroth as a sphere and then space. Camera/render only; flat physics is unchanged and driving the craft is untouched. Esc > Graphics > "Planet view (fly high)" (default on) switches it off.

- Radius `PLANET_RADIUS` = continent N-S extent (29,867 yd) / 40 degrees in radians = ~42,785 yd, so one continent spans ~40 degrees. Horizon dip is ~3.9 deg at 100 yd, ~8.6 deg at 500 yd, ~17.7 deg at 2000 yd.
- Ramps (`PLANET_RAMPS`, altitude yd): terrain/water/props bend onto the sphere 150-1500; globe fades in 100-800; sky thins, stars/sun/moons appear 2000-9000 (atmosphere is ~12% of R, ~5k); clouds fade out 3000-9000.
- Globe, stars, sun, White Lady and Blue Child (slow orbits, phase-lit) are procedural (`space.js`); land mask comes from the continent rects (manifest, or `FALLBACK_RECTS` when hosted without WoW data). No WoW art on the globe.
- Fly boost scales with altitude (up to 60x) and the ceiling is 1,000,000 yd, so 10k yd is ~4 s away.
- Limits: the cloud sheet, particles and shadow pass are not bent; the bent terrain and equirectangular globe differ by up to ~8% at the world's extremes; the old screen-space sky moons can double with the space moons mid-transition.
- Captures: `node race-space-alt.mjs <tag> [planet:0|1] [sky]` writes `runtime/gate-preview/space-<tag>-<alt>-<yaw>.png`.

### Phase A polish: position and shell clouds

- Fly speed is a continuous log law (1x to 1k yd, 40x at 1M yd); the flat (x,z) pose is the globe sub-point, so descent is radial. Above 150 yd a HUD shows altitude, speed, lat/lon and continent; the M map shows the sub-point (no ring or line on the globe). **X** looks straight down. The HUD also names the nearest map landmark.
- Fly orientation is a quaternion (`orient.js`) in space: yaw/pitch/roll deltas apply in the camera frame, so there is no pole or radial-up gimbal lock; below 800-4000 yd it blends to the ground yaw/pitch (roll levelled, pitch clamped), and yaw/pitch are re-derived from it so saves and `worldTest.focus` still work. Roll has no key binding yet.
- Clouds are spherical shells that arc with the planet and stay visible from orbit. The JS mirror (`shellExtent`) and sweep cover the shell, including a ground clip for rays that would march through the planet. Sky gradient meets the true horizon limb (`horizonDip`), the sea shelf shares the noisy land edge (no teal rectangle, seam-free noise on the sphere), and the old screen-space moons fade out as space comes in. Limits: a faint colour step remains at the level horizon at 2k (fogged bent water vs sky gradient); darker straight-edged sea tiles remain around continents at 5-20k; Standard shell steps adapt to span (coarse from orbit); the cloud coverage map is not checked for an antimeridian seam beyond one capture.
