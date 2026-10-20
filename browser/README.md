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

## Run locally

Use a current hardware-accelerated Edge or Chrome. From the repository root:

```powershell
.\browser\Build.ps1
node .\browser\server.mjs
```

Open **http://127.0.0.1:4173** and select the **Data** directory in your own Classic
1.12 installation. The browser reads the local MPQ patch chain directly. No
exported terrain pack, login, upload or whole-archive copy into Wasm is needed.
The native directory picker remembers a handle; a later session may require
**Reconnect Data** to grant read permission again. **Choose folder as files**
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
| Drive | W thrust, S reverse, A/D steer, X brake, Space/J hop, Shift boost, Ctrl/C drift, F cockpit, V look behind, F9 reset |
| Standard controller | Left stick steer, RT thrust minus LT reverse, RB boost, LB drift, A hop, right stick look/click cockpit, D-pad chase zoom, Y reset, Start drive/fly |
| Chase camera | Right-drag or arrow-key orbit, wheel zoom; vehicle-relative position with local distance/vertical damping |
| Free flight | W/S forward/back, A/D strafe, Q/E altitude, arrows look, Shift fast |
| World overview | Frames both complete coarse continents |
| Return to vehicle | Returns to the parked hovercraft; does not teleport it to the flight camera |

Click the view to capture keyboard input. Flight is deliberately collision-free.
**Save** stores the parked vehicle, flight camera, mode and display
settings. **Load** restores them; **Reset** recovers without
overwriting a saved pose until you explicitly save.
Display switches do not disable collision.
**Controls & settings** keeps the existing **Space key** choice: hop (default) or
brake (legacy saves); J always hops. **S reverses and X brakes in both profiles**,
matching the controller's signed throttle without applying brake to reverse.
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
boost reserve. The visible **Sound** control enables an original low twin-engine
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
cruise/boost **150/300 yd/s**, thrust/extra boost thrust **50/50**, braking 30,
drag 0.25, turn rate 2.2, turn response 10, grip 8, drift grip 1.5, drift turn
multiplier 1.3, hover height **3 yd**, spring 90, damping 18, gravity 24, hop speed
7, air control 0.9 and chase damping **0.5 s**. Fresh Rust worlds and Restore
defaults agree. Existing saved handling overrides remain authoritative; Reset
retains active handling. Shared native-client physics defaults are unchanged.
Historical performance measurements below used the former 36/50 yd/s defaults,
not these new speed caps.

### Elevated obstacle clearance

The support-edge guard previously stopped any per-probe rise of 0.6 yards,
even when the obstacle was well below an elevated vehicle. It now permits
such a rise only below the entire swept hull's **0.5-yard half-height**.
Real mesh/bounds collisions, protruding terrain, missing geometry, unsupported
holes, floor correction and the independent presentation timeline are unchanged.

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
they are not water-only compressed-byte counts. The existing approximate water
shader and coarse land silhouettes remain, and unscanned far water can still
show exposed seabed until its authored data arrives.

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
It contains 53,453 static overworld spawns and 5,537 resolved display definitions.
Do not commit, upload or redistribute it. See [SCENE.md](SCENE.md) for the optional
private export commands and schema.

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
smooth rise greater than 0.6 yards per tick as a wall. Solid sweeps, unsupported
holes, missing tiles and whole-tick rollback remain enforced. Upward support
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
