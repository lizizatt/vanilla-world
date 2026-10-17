# Nearby authored scene contract

`scene-stream.js` runs in the asset worker with the same `source.read(gamePath)` as
terrain. It reuses the pure Rust ADT, M2, WMO and BLP adapters through `scene.rs`;
there is no Bevy dependency and no bundled game art.

Call `setTile("mapId:x:y", bytes)` once per resident ADT (maximum four), and
`removeTile(key)` when its terrain leaves. Each frame/job cycle calls
`update(mapId, [sourceX, sourceY, sourceZ])`, then `await pump()`. A pump admits at
most two file reads/decodes, serially; WMO roots and individual groups are separate
jobs. `clear()` invalidates pending completion and releases retained Wasm roots.

`snapshot()` returns `instances`, `assets` and `textures` Maps, bounded error
history, population status and cache counters. Hard limits are 128 cached resources,
96 MiB accounted decoded payload, 1,024 closest scene instances and 850 yards.
`capacityBlocked`/`pending` mean content is incomplete, not successfully loaded.
The byte count includes conservative root memory accounting but excludes parser
temporaries, JavaScript bookkeeping and the separately owned main-thread/GPU copy.
Individual files are capped at 64 MiB; model/group meshes at 200,000 triangles;
BLPs at 2,048 pixels per side. Never preload continent-wide models.

## Renderer and collision boundary

Instance `matrix` is **column-major model-to-world in raw WoW coordinates**:
X north, Y west, Z up. ADT rotations use the native placement law including tilted
models; MODD child quaternions compose with the parent. Deduplication keys are
map/kind/authored unique ID; WMO group/doodad children retain their parent identity.
Source-space `bounds` include rotation and uniform scale. Apply the same matrix
to drawing and collision. After subtracting source-world origin, the renderer's
Y-up basis is `(-y,z,-x)`; normalize the transformed normal. Do not reapply ADT
rotation or model scale.

Each asset has `Float32Array vertices` with stride 12:
position3, normal3, UV2, color4; `Uint32Array indices`; and material `batches`
with `firstIndex`, `indexCount`, texture path, cutoff, blend, double-sidedness,
wrap modes, emissive and depth-write flags. Draw indexed with base vertex zero.
Textures are actual decoded BLP RGBA8, gamma encoded, including authored alpha.
Cutout assets are withheld until their real texture is available: no solid-card
fallback or collision-only tree rendering. Alpha-test cutoff is 224/255, with
opaque depth writes; `alpha`, `add`, `mod` and `mod2x` name distinct blend equations.

`collisionVertices`/`collisionIndices` are model-local authored M2 hulls (usually
trunks, **not** foliage) or WMO walking faces excluding DETAIL. They are a collision
input seam, not a physics implementation. Renderer integration must use swept
contacts and distinguish missing collision assets from clear space. Empty M2 hulls
are valid non-solid models. Source vertices are not collision AABB boxes.

Worker buffers must stay attached for reuse/collision. Copy and transfer each newly
visible asset/texture once; release main-thread/GPU copies when absent from the
current snapshot. Main-thread memory has its own budget.

## Private static NPC companion

Client Data contains display/model definitions, not server spawn positions.
`setPopulation(pack)` accepts version 1 JSON with `provenance.source`,
`provenance.redistribution: "private-local-only"`, `models` keyed by display ID
(`path`, `scale`, `skins`: three creature variations plus optional baked body),
and `spawns` (`id`, `entry`, `map`: 0/1, `displayId`, source `position`,
source-Z `orientation` radians, `scale`). Validation is atomic; duplicate or
corrupt spawns fail. A chunk index makes only nearby instances eligible.

The optional offline tooling is `export-npcs.py <local SQL snapshot> <private.json>`
then the Rust `resolve_npcs` example with arguments
`<Data directory> <private.json> <private resolved.json>`.
Neither needs a running database. Output files are create-new only. Keep every
output outside git (or in ignored runtime storage); never distribute these rows or
client-derived model definitions. The provisioned brotalnia/database snapshot has
no verified redistribution license. Its digest and limitations travel with the pack.
The integration may serve one explicitly configured private loopback companion URL;
absent packs must show an honest no-population status.

NPCs are static authored snapshot placements, not live server entities. Snapshot
export chooses the first authored template/display alternative and patch 10, not
event/pool scheduling. All models currently use bind pose; equipment, humanoid
hair/geoset customization, skeletal animation, billboarding, quests and combat are
not implemented. The baked body texture is retained where available.

Focused checks: `node --test browser\scene-stream.test.mjs` and
`cargo test --manifest-path client\Cargo.toml -p flats-racer-web --test scene`.
Set `WOW_DATA` and `BENILLA_REQUIRE_DATA=1` for the real both-continent placements,
complete Elwynn pine/alpha and Goldshire inn checks.
