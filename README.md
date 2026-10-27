# Azeroth Racer (vanilla-world)

A single-player browser world explorer and hover-racer over World of Warcraft 1.12 terrain
(WebGPU renderer, Rust physics and format parsers compiled to WebAssembly). The hosted site
requires WoW 1.12 data (no data shows one "WoW data folder not found" message, not a degraded world); game art and audio are never committed and are read from the
player's own local files at runtime.

- **App, docs and tests:** [browser/](browser/README.md); system diagram in
  [browser/ARCHITECTURE.md](browser/ARCHITECTURE.md).
- **Wasm crates:** [client/crates](client/crates): `flats-racer-physics`, `flats-racer-web` and the
  `benilla-*` format parsers (MPQ/BLP/DBC/ADT/WDT/WMO/M2) they use. Licensed MIT OR Apache-2.0
  (`client/LICENSE-MIT`, `client/LICENSE-APACHE`); the parsers originate from
  [samwhosung/benilla](https://github.com/samwhosung/benilla).
- **Hosting:** `.github/workflows/pages.yml` builds the wasm, runs `node --test browser` and
  publishes `browser/build-dist.mjs` output to GitHub Pages.

## Build and run

Prerequisites: Rust 1.98.1 with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` **0.2.122** (exact version; it must match the crate),
Node 20+. A fresh clone has no `browser/pkg` (git-ignored); build it first or the shell/dist tests skip and the app cannot start.

```
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.122 --locked
cd client && cargo build -p flats-racer-web --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/flats_racer_web.wasm --target web --out-dir ../browser/pkg
cd ../browser && npm install && node server.mjs      # http://127.0.0.1:4173
node --test browser                                  # unit tests (from repo root)
```

Then open the page and pick your own WoW 1.12 `Data` folder (optionally also a Star Wars Episode I: Racer `data` folder). Nothing is uploaded.
Optional local-only files (never committed): `browser/world-map-art.jpg` (painted map override), `browser/vehicles/*.glb`, a private NPC pack.
See [browser/design/clean-checkout.md](browser/design/clean-checkout.md) for what a clean checkout does and does not have.
Windows helper: `browser/Build.ps1`. See [browser/README.md](browser/README.md) for details.

## Removed material

The repository previously also contained the VMaNGOS C++ server (`server/`), the native
Benilla Bevy client crates, `runtime/`, `tools/`, root bootstrap `scripts/`, and Benilla's
docs/reference tables. None of it is used by the browser app, so it was removed.

**The last commit that still contains all of it is `3b4f139e`.** Recover anything with e.g.
`git show 3b4f139e:server/README.md` or `git checkout 3b4f139e -- server`.
