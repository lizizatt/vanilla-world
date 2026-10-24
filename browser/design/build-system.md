# Design: build system

Status: recommendation (no code changed). Inputs: `sw.js` FILES list, `server.mjs`, `build-dist.mjs` and test, `Build.ps1`, `package.json`, `.github/workflows/pages.yml`, about 60 smoke scripts.

## Recommendation: stay bundler-free, generate the manifest
1. Generate the shell manifest from the import graph (`index.html`, static and dynamic `import()`, worker URLs, CSS, JSON, wasm bindings) plus a small explicit runtime-asset registry; fail closed on missing files and on forbidden names (`local/`, tests, smokes). `server.mjs`, `build-dist.mjs` and `sw.js` all consume that one manifest, replacing the hand-edited FILES list and the manual `racer-shell-vNNN` bump (cache name = manifest hash).
2. Content-hash published assets in `dist` only; keep HTML and `sw.js` no-cache.
3. One `package.json` surface: `build:wasm`, `build:manifest`, `build:dist`, `test`, `smoke`, `ci`. `Build.ps1` becomes a thin wrapper.
4. Move smokes to `browser/smoke/` with a shared Playwright harness (port 4183 convention, Edge, `--mute-audio`, cleanup, error collection).
5. CI: cache cargo registry/target and the wasm-bindgen binary keyed on `Cargo.lock` + toolchain + bindgen version.

## Rejected: adopt esbuild/Vite
Gives hashing, minification and one dependency graph, but adds a second graph and transform layer, source-map/debug friction, worker-module compatibility work, and a build step in the dev loop, while HTTP/2 makes unbundled modules cheap. Hashing and manifest generation deliver the cache-correctness benefit without it. Revisit if first-load request count or payload becomes a measured problem.

## Migration
1. Manifest generator + test asserting it equals the current FILES list (parity), no behaviour change.
2. Switch server/build-dist/sw to the manifest; delete manual FILES and bump rule.
3. npm scripts; wrap Build.ps1.
4. Move smokes behind the shared harness incrementally (cap per PR).
5. CI caching.
6. Hash assets in dist.

## Risks
Dynamic URLs the parser can't see (keep explicit registry, fail closed); stale caches during hash cutover; moving smokes breaks paths in docs.

## Success
Zero missing precache files, unchanged test/smoke counts, offline shell works, lower CI build time, no manual cache-version edits.
