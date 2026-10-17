# Local browser racer MVP

An **alternate WebGPU rendering adapter**, not a port of Bevy or VMaNGOS.
`flats-racer-web` compiles the repository's existing `flats-racer-physics` and
`benilla-formats` (including the ADT parser, triangle mesher and terrain height
queries) to Wasm. JavaScript owns browser input, rendering and IndexedDB only;
it does not reimplement racer dynamics. The native client/server are unchanged.

The default scene is explicitly **synthetic flat ground**. Importing a private
vanilla ADT replaces it with that tile's actual height geometry. The cyan racer
is an original geometric marker, not an imported mount.

## Build and launch on Windows

Prerequisites: the client's pinned Rust 1.98.1 toolchain, native MSVC build
tools (for the binding generator/native tests), Node.js, and current Edge or
Chrome with WebGPU/hardware acceleration. No login, database, account secrets,
server bootstrap, or public hosting is needed.

From the repository root, install these only if missing:

```powershell
rustup target add wasm32-unknown-unknown --toolchain 1.98.1
cargo +1.98.1 install wasm-bindgen-cli --version 0.2.122 --locked --jobs 2 --root .\target-web\tools --target-dir .\target-web\tools-build
```

Build, then run the loopback-only static server:

```powershell
.\browser\Build.ps1
node .\browser\server.mjs
```

Open **http://127.0.0.1:4173**. Click the view to give it keyboard focus.
W/S or up/down accelerate/reverse; A/D or left/right steer; Space brakes;
Shift boosts; C drifts; J hops. Focus loss clears held keys; background time
does not accumulate physics catch-up. Dynamics advance at 120 Hz, independently
of drawing; stalls discard time beyond 100 ms per frame.

All Cargo output goes into this worktree's ignored `target-web`, never the
native client's `target-racer`. The generated web package is ignored too.
Do not run multiple Cargo builds concurrently on a shared development host.

## Import actual terrain privately

Use the existing read-only patch-chain extractor. This example reads the
Shimmering Flats tile `Kalimdor_39_43.adt` from your own install, writing only
to this checkout's ignored runtime directory:

```powershell
New-Item -ItemType Directory -Force .\runtime\browser | Out-Null
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-web'
Push-Location .\client
cargo run --release -j 2 -p benilla-formats --bin mpqx -- 'C:\path\to\your\install\Data' 'World\Maps\Kalimdor\Kalimdor_39_43.adt' '..\runtime\browser\Kalimdor_39_43.adt'
Pop-Location
```

Choose that file with **Import local .adt**. A complete tile (256 terrain
chunks), finite geometry, and a safe spawn are required; input is capped at
16 MiB. The shared mesher preserves the original four-triangle cell fans and
terrain holes. Rendering adds procedural shading/grid lines, not original
textures. Geometry is rebased to local Y-up coordinates.

**Never commit, upload or redistribute the tile, game assets, or imported-world
screenshots.** The static server deliberately serves only the application shell,
not runtime data, source files, node_modules or arbitrary paths. Import reads the
selected file in the browser; it does not POST it anywhere.

## Saves and offline use

**Save locally** stores the current terrain bytes and pose together in one
IndexedDB transaction. Reload or **Load save** restores both. A save is a parked
pose: momentum, jump timers and boost depletion reset, rather than resuming a
moving vehicle. Reset does not overwrite the saved record.

The service worker caches the application shell after the first successful
online visit. Wait for **Offline shell ready**; subsequent reloads at the same
origin can run offline, including the imported terrain if saved. No CDN is
used. Offline means a previously installed local web app, not opening the HTML
directly with `file:`. Saves/cache belong to this browser profile and origin;
clearing site data removes them and browser eviction is possible. They are not
encrypted backups. After changing a build, clear this origin's site cache to
refresh the offline shell (export/reimport your original tile as needed).

## Reproducible checks

From the repository root:

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-web'
Push-Location .\client
cargo fmt -p flats-racer-web -- --check
cargo test --release -j 2 -p flats-racer-web -p flats-racer-physics
cargo clippy --release -j 2 -p flats-racer-web --target wasm32-unknown-unknown -- -D warnings
Pop-Location
Push-Location .\browser
npm ci --no-audit --no-fund
$env:ADT_FILE = '..\runtime\browser\Kalimdor_39_43.adt'
npm test
Pop-Location
```

Leave the local server running for `npm test`. Playwright uses the installed
Microsoft Edge (`channel: msedge`), not a separately downloaded browser.
Set `HEADED=1` if this host disallows WebGPU in headless mode. Missing GPU
support is an explicit failure, not a fallback to a fake renderer.

The smoke test starts in a fresh browser context, proves both terrain and racer
pixels in the middle of the canvas, drives using real keyboard events, checks
displacement/steering/boost/braking/hopping, reloads parked saves offline, and verifies
invalid ADT import leaves the current simulation usable. With `ADT_FILE` it
repeats those checks for the imported terrain. Without it, the report explicitly
marks imported terrain untested. Evidence and private screenshots stay in ignored
`browser\test-results\<tile-name>` (or `synthetic`). Unit tests cover boundary
holds and atomic validation.

## Deliberate boundary

This is one finite terrain tile, not full world streaming. Collision is
conservative terrain-only support/contact: tile edges, holes, impassable chunks
and abrupt rises hold the racer. It is not the native swept Avian collider;
no WMO/M2 buildings, props, liquids, textured materials, sky system, mount model,
audio, Lua or native HUD are ported. A camera can intersect steep terrain.

**Embedded simulation achieved:** existing Rust hover-racer dynamics running
locally in Wasm. **Not achieved:** C++ VMaNGOS in Wasm, packet-queue transport,
account/login replacement, world-database packaging, characters, NPC AI, combat,
quests or singleplayer RPG saves. Those require a separate server/runtime port;
this client-side racer does not demonstrate them. No native platform behavior
or server configuration is changed.
