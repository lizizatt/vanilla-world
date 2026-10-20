# Nearby authored scene contract

`scene-stream.js` runs in the near world worker with the same `source.read(gamePath)` as
terrain. It reuses the pure Rust ADT, M2, WMO and BLP adapters through `scene.rs`;
there is no Bevy dependency and no bundled game art.

The browser yields through `prepareTile("mapId:x:y", bytes, metadata)` before
`commitTile(key, prepared)`, publishing the finished placement index together
with Rust terrain residency. A changed placement revision invalidates preparation.
`setTile(key, bytes)` remains the synchronous interface for other callers.
Near residency is limited to eight ADTs; call
`removeTile(key)` when its terrain leaves. Each frame/job cycle calls
`update(mapId, [sourceX, sourceY, sourceZ])`, then `await pump()`. A pump admits at
most two file reads/decodes, serially; WMO roots and individual groups are separate
jobs. `clear()` invalidates pending completion and releases retained Wasm roots.

`setDistantTile(key, bytes)` / `removeDistantTile(key)` manage a separate maximum of
24 visual metadata tiles in the dedicated far worker. Only their parsed placements
remain resident, not terrain meshes. Their full authored M2/WMO batches and real
alpha textures use a separate 32 MiB, 96-model/96-texture cache out to 6,000 yards.
`instance.distant` identifies these visual
instances; near copies win authored-ID deduplication. Near requests precede distant
requests, so saturated near residency may defer distant content. Distant metadata
never creates NPCs, collision instances, or unresolved collision holds. The caller
must separately bound metadata ADT IO and enforce combined near/far draw budgets
(the integration uses two million triangles) and distance fog.

Far-only selection prefers known visible bounds and budgets complete known
resource dependencies while retaining unknown-model discovery. `budgetOmitted`
counts ordinary optional capacity omissions. Camera turns reprioritize work
without changing the nearest 24-tile set; neither view ranking nor draw culling
changes near collision candidates.

`snapshot()` returns `instances`, `assets` and `textures` Maps, bounded error
history, population status and cache counters. Near hard limits are 192 geometry/root
resources plus 192 dependent textures, 96 MiB shared accounted decoded payload,
1,024 closest scene instances and 850 yards. Texture dependencies do not consume
geometry slots; nearest requests win, with texture-first ties and protected owners.
Unresolved geometry within 32 yards takes precedence over textures and farther
scenery, with WMO roots before groups before M2s. Loaded hulls remain usable while
their visual texture dependencies catch up.
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
`collisionInstances` includes loaded hulls even while rendering waits for alpha;
their buffers are in `assets`. `unresolvedCollision` identifies unloaded/failed
geometry with status, bounds and `boundsKnown`. WMO roots retain authored MODF
world AABBs even before their model is read; these are not transformed again.
WMO groups have known transformed boxes; unknown M2 bounds are only placement points, **not** certified empty
space. The physics integration must conservatively gate nearby unresolved points
and known boxes, not freeze for every far `pending` resource. These bounds do not
prove an unparsed model's true extent.
NPC spawn instances are visual-only and never enter collision or unresolved
collision demand; a static world placement sharing their model is unaffected.

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
Unresolved hair/cape material batches are omitted from a baked-body NPC, with
`omittedCharacterBatches`/`appearance: "baked-body-only"` metadata, rather than making
the whole NPC disappear or drawing opaque substitute cards.

Focused checks: `node --test browser\scene-stream.test.mjs` and
`cargo test --manifest-path client\Cargo.toml -p flats-racer-web scene::tests`.
Set `WOW_DATA` and `BENILLA_REQUIRE_DATA=1` for the real both-continent placements,
complete Elwynn pine/alpha and Goldshire inn checks.
After building the Wasm exports, `node browser\scene-smoke.mjs` checks real MPQ
reads and scene admission in an Edge worker at the raceway and Stormwind.
Optional `NPC_SPAWNS` points to a private companion for that check. This is not a
substitute for the integrated renderer's GPU and collision acceptance.
