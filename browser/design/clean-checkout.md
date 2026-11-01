# Clean-checkout audit

Scenario: a stranger clones the repo or opens the GitHub Pages build, has none of our local artifacts, and supplies their own WoW 1.12 `Data`
folder (and optionally Star Wars Episode I: Racer `data`). Read from origin/main after 36c14603 + this commit. Effort: S < 1h, M < 1 day, L > 1 day.

## Findings

| # | Sev | What breaks / degrades / leaks | Status / fix | Effort |
|---|-----|--------------------------------|--------------|--------|
| 1 | **High** | `world-map-art.jpg` (git-ignored, WoW-derived painting) was in `RUNTIME_ASSETS`, so `shellManifest()`/`build-dist` threw "world-map-art.jpg is missing" on any clean checkout. The Pages workflow could never have succeeded without it. | **Fixed**: removed from `RUNTIME_ASSETS`; `server.mjs` serves it as an optional local file; never published. Test: `shell-manifest.test.mjs`. | S |
| 2 | **High** | Map panel with the painting absent: the worker preferred the single `World`/`Cosmic` DBC image, but the panel only draws per-continent images (`imageRects`), so a user with that DBC row saw green schematic rectangles and "Loading map art..." instead of real map art. | **Fixed**: `WorldMapService` now requests per-continent tiles (`Interface\WorldMap\<Continent>\*.blp` from the user's Data). The painting stays an optional override. | S |
| 3 | Med | Map without the painting has no Elune/Maelstrom art and no continent-gap fill; body buttons are stacked bottom-right. The painted frame fit (`ART_FIT`) only applies to the painting. | Open. Proposal below (runtime-generated map). | M |
| 4 | Med | `node --test browser` fails on a clean checkout before the wasm build: `shell-manifest` / `build-dist` tests need `pkg/flats_racer_web_bg.wasm`. | **Fixed**: those tests skip with a "run Build.ps1" reason when pkg is absent (CI builds pkg first, so they run there). | S |
| 5 | Med | Root README quick start omitted the toolchain, the exact `wasm-bindgen-cli 0.2.122` pin and the first-run steps. `Build.ps1` is Windows-only and expects `target-web\tools\bin\wasm-bindgen.exe`. | **Fixed** README. The cargo/wasm-bindgen commands are cross-platform; Build.ps1 remains a convenience. | S |
| 6 | Med | No top-level `LICENSE`. `client/LICENSE-MIT|APACHE` cover the crates only; browser JS has no stated licence, so forks have no grant. | Open: owner must choose a licence (not decided here). | S (owner) |
| 7 | Low | Attribution: SWE1R format knowledge is noted in `swe1r/block.js` ("OpenSWE1R/swe1r-re, akopetsch/swe1r-assets, MIT; no code copied"), benilla in the root README. No NOTICE file lists them. | Open: add `NOTICE.md` listing benilla (MIT/Apache) and the two MIT references. | S |
| 8 | Low | Tracked stray screenshots `browser/browser/test-results/plane1.png|plane2.png` (procedural plane, not game art, wrong directory so not ignored). | **Fixed**: removed. | S |
| 9 | Low | `README` quick start still names port 4173 (server default); fine for users, agents must use their own port. | Noted. | - |
| 10 | Info | History contains `browser/world-map-art.jpg` (c9934ca0 and later add) and, from before the prune, the VMaNGOS `server/` tree (SQL, `libmySQL.dll`). Left alone by decision; no history rewrite. | Listed only. | - |

## What the app does without each local artifact

| Artifact | Present on clean clone? | Without it |
|---|---|---|
| `browser/pkg/*` (wasm) | No (git-ignored) | Server returns 404 for pkg; app fails to start. Must build (README). CI builds it. |
| WoW `Data` | User supplied (file picker / directory handle in IndexedDB) | One "WoW data folder not found" message; wrong folder / missing DBC/ADT/BLP produce typed `AssetError`s shown by the loader (see `asset-source.js`). |
| SWE1R `data` | Optional | Racer HUD, sfx, skins, voices off; procedural audio fallback; HUD rows hidden. |
| `world-map-art.jpg` | No | Fixed above: map uses the user's own Data continent art plus schematic rects. |
| `runtime/browser/*` (npc-spawns, npc-pack) | No | `server.mjs` 404s (optional); Pages publishes only the de-identified `npc-pack.public.json` when `INCLUDE_NPC_PACK=1`. Population simply absent. |
| `browser/vehicles/*.glb` | Tracked (`gnome-car`, `gnome-tower`) | Original generated models; extra local `.glb` files are optional. |
| Golden poses (`golden-poses.json`) | Tracked (coordinates only) | n/a |
| WebGPU / IndexedDB | Browser-dependent | WebGPU: `world-renderer.js` throws "WebGPU is unavailable..." which the loader shows. IndexedDB failure (incognito/blocked): `AssetError('STORAGE')`; the folder must be re-picked each load. |

## Tracked-asset scan (rule: no WoW/Racer art, audio or derived data)

Tracked binary files at this commit: none after removing the two plane PNGs. `npc-pack.public.json` is trimmed positions + display ids (format
`npc-trimmed-v1`, guarded by `build-dist.mjs`); `swe1r/voice-map.json` is 71 bytes of names. History-only: item 10.

## Optional archive.org data source (off)

Set `ARCHIVE_DATA_SOURCE=1` when running `server.mjs` or `build-dist.mjs` to add a download-from-archive.org button; unset it (the default) and none of that code, UI or network access exists in the build. Details, findings and risks: [data-hosting-research.md](data-hosting-research.md#archive-org-option-spike-off-by-default).

## Hosting privacy

Pages serves static JS/wasm only (`_headers` CSP, `build-dist.mjs` refuses `local/`, `runtime/`, tests, smokes). Game data is read through
`showDirectoryPicker`/`<input webkitdirectory>` into workers and IndexedDB handles; there is no upload endpoint. Service worker precaches only the generated shell.

## Map proposal (finding 3, not implemented)

The Data already carries `Interface\WorldMap\<Continent>\*.blp` (now used) and the app renders terrain from WDL. To drop the painted jpg completely:
1. Draw each continent from the stitched Data tiles (done) and the Maelstrom/ocean gap as a vector fill from `manifest.ocean`.
2. Draw the frame, compass and Elune as an original procedural SVG/canvas illustration (no game art), positioned by `ELUNE_ART`-style constants expressed as map fractions.
3. Keep `world-map-art.jpg` as a local override only (already loaded first when present).
Risk: icon placement currently uses the painting-specific fitted chart (`worldArt`); without the painting `mapFrame`/`toMap` is used (exact for Data tiles).
