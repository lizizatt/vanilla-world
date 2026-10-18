# Vanilla World in your browser

A local, single-player **world explorer**, using this repository's Rust racer
physics and ADT/WDT/WDL/M2/WMO/BLP parsers through WebAssembly. This is an alternate
WebGPU rendering adapter, **not a Bevy/VMaNGOS port or a completed singleplayer RPG**.
It does not connect to or modify the native server, database or account system.

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

## Explore

You start on actual raceway terrain in `Kalimdor_39_43.adt`, in Thousand Needles.
The spawn height comes from the ADT, not a guessed sea-level floor.

| Mode | Controls |
|---|---|
| Drive | W thrust, S reverse, A/D steer, X brake, Space/J hop, Shift boost, Ctrl/C drift, V look behind, F9 reset |
| Standard controller | Left stick steer, RT thrust minus LT reverse, RB boost, LB drift, A hop, right stick orbit, D-pad zoom, Y reset, Start drive/fly |
| Chase camera | Right-drag or arrow-key orbit, wheel zoom; 0.5-second position filter by default |
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
Gamepad inputs use standard browser mappings,
deadzone rescaling and press edges; disconnect, lost focus and editing controls
clear thrust instead of leaving a stuck accelerator. Flight retains keyboard
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
fullscreen or reserving space for panels. Controls and instruments have transparent
backgrounds with text shadows and thin control outlines. Unused overlay space and
the HUD pass pointer input through to the world; interactive controls remain
focusable. Expanded help/settings scroll within a bounded overlay. Handling stays
modal and holds the brakes, with a transparent backdrop.
The existing renderer follows live canvas size/aspect and caps backing DPR at 2.
For example, a 1280 x 800 content viewport now draws 1280 x 800 at DPR 1, rather
than the old 1206 x 534 inset canvas. Earlier smaller-canvas performance results
below are **not full-viewport FPS guarantees**.
The viewport check covers the observed app content size (676 x 1315), 1280 x 800,
360 x 640 and 640 x 360, plus DPR 2.5 capped to 2. It checks live projection aspect,
zero page overflow, HUD/unused-overlay pointer pass-through, orbit, keyboard focus
and unchanged scene pixels underneath transparent overlay backgrounds.
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

**Handling** edits the 17 existing Rust physics parameters plus camera
smoothing seconds. Rust validates the complete set; successful writes persist in
a separate per-install tuning record without overwriting the saved vehicle pose.
Failed storage leaves active handling unchanged. There are no gameplay upper
ceilings, but values must fit finite f32 physical domains, and extreme combinations
can fail simulation explicitly. Brakes are held while the editor is open.
Camera zoom is separately limited to 0-50 yards. Desired and filtered chase paths
are clipped against loaded ground and the shared collision BVH; filtered lag cannot
escape that 50-yard camera query window. This is not a world draw-distance limit.

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
**four** are resident: all support/swept-query tiles are pinned before eviction,
including four-way corners. Prefetch is lower priority. An expected but missing,
corrupt or still-loading ADT blocks driving; it never becomes substitute ocean.
Only successfully parsed WDT absence connected to the map exterior can add
exterior ocean, and contradictory WDL land remains unavailable for driving.
WDL supplies no collision. Below-sea land, including the raceway, is retained.
Authored MCLQ supplies detailed inland water.

Loaded ADTs replace their WDL patches atomically. Edge strips bridge coarse/detailed
height differences visually, not physically. Both use real projected depth;
coarse terrain can still produce visibly angular cliffs and shorelines.

Nearby models use authored geometry, transforms, BLP textures, UVs, alpha cutoff,
material blending and depth. The scene budget is **96 geometry/root resources,
192 dependent textures, 96 MiB decoded payload and 1024 instances**. These are not
total browser/process memory limits: parser temporaries, JavaScript bookkeeping,
main-thread/GPU copies and driver memory are additional. Capacity/pending counters
mean some farther content is incomplete, not that it loaded successfully.

Detailed ground uses native ordered layer blending, authored normals, texture
coordinates, alpha masks, shadow masks and holes. Bounded texture arrays and
mipchains reuse the local BLP data. Far terrain progressively receives translated
native minimap colors in two 2048-square atlas pages (32 MiB); missing mappings
stay explicit. Material status reports textured tile residency, CPU terrain-cache
size, minimap progress and pending/error counts. Static sunlight/fog remain an approximation, not DBC time-of-day
lighting or full native water sheen.

The bounded distant-model port reuses the native strict geometry/material
boundary and complete authored M2 leaf batches rather than copying Bevy's
clustering/atlas implementation. Up to **12 separate visual metadata tiles**
retain placements, not terrain meshes, sharing the same 96 MiB asset cache.
Models can be visible out to **6000 yards**, with authored alpha cutoff, real
depth, and dither/fog fading from 3500 yards. The nearest metadata tiles and
active continent are selected; this is not exhaustive residency of every prop
inside that radius. Near requests win, and dense near content can defer far
content. Distant metadata supplies neither NPCs nor collision.

Only one distant ADT read is outstanding, started at most twice a second after
current collision requirements are ready; late results for an evicted selection
are discarded. Existing near placements are reused without another archive read.
Combined model drawing retains a nearest-first prefix capped at **two million
triangles and 4096 draw calls**; any omitted instances are reported in Diagnostics.
Terrain and opaque/cutout commands reuse bounded WebGPU render bundles without
omitting draws. Membership, material, resource or uniform-offset changes rebuild
them; transparent batches still sort back-to-front every frame. Batch paths and
pipelines are prepared once, static instance transforms retain floating-origin
precision, and each frame writes directly into the existing uniform buffer.

The worker separately negotiates `sceneInstanceUpdates`: a complete nearest-first
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
endpoints. A footprint that cannot fit the four-tile or collision budget fails
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
static bind-pose appearances, not live server entities. Equipment, complete
humanoid customization, animation, event/pool scheduling, quests and combat are
not implemented. Baked humanoid bodies omit unresolved hair/cape batches rather
than drawing fake opaque cards.

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
changes and rebases immediately invalidate the history. A newer authoritative
hold stops buffered motion immediately. Without a bracket, drawing holds the
latest confirmed pose rather than accumulating more delay.

The final 180-second capture compared the actual presented pose with the current
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
write-failure preservation and offline reload. It also requires four textured
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
when input stops. The FIFO holds at most four resident tiles. Eviction/source
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

[ASSETS.md](ASSETS.md) documents the bounded MPQ reader, corruption semantics,
77-file native/Node/Edge parity and the whole-install codec census. All 2,389,542
compressed sectors in this installation used supported zlib; other installations
may require codecs that currently fail explicitly.

Native Bevy render phases, moving-transport timetables, animation and a server
simulation are not ported. Coarse/detailed seams remain visible. Exact native
cockpit seating requires a selected rider's head height and animated attachment
frame; a mount attachment is not a substitute for that missing rider data.
