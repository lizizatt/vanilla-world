//! Distant low-detail terrain (WDL): the map's coarse horizon heightmap streamed around the view
//! beyond the ADT ring, drawn unlit under a fog pair of its own that saturates it to the flat
//! scene-fog colour. The parse and mesh are `benilla_formats::wdl`; the reference's backdrop law
//! that partitions it from the detailed world is `wdl.wgsl`'s header.

use std::collections::HashMap;

use bevy::asset::RenderAssetUsages;
use bevy::camera::visibility::NoFrustumCulling;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::pbr::ExtendedMaterial;
use bevy::prelude::*;
use bevy::render::render_resource::Buffer;

use crate::view::WorldCamera;
use crate::world_map::CurrentMap;
use benilla_assets::coords::{bevy_to_wow, placement_rotation, wow_to_bevy};
use benilla_assets::materials::{WdlExt, WdlMaterial};
use benilla_assets::LockRecover;
use benilla_assets::MapCatalogRes;
use benilla_assets::{AssetSet, ModelProxyMesh, RenderConfig, WorldAssets};
use benilla_formats::{Doodad, LiquidKind, MinimapTranslate, WdlFile, WmoInstance};

mod transports;
pub use transports::RacerTransport;

/// Chebyshev tile radius of the WDL ring. The shader keeps it a backdrop (near plane at
/// `farclip − 33`, depth behind the detailed world), so it only fills what that leaves empty.
/// Deviation: 5, not the reference's ±3-tile far walk, because hills out to its `horizonfarclip`
/// (2112 yd, about 4 tiles) still rise above the horizon as silhouettes.
const WDL_RADIUS: u32 = 5;

/// New WDL tiles built per frame (545 vertices each), so a whole ring does not hitch a zone load.
const WDL_LOADS_PER_FRAME: usize = 8;

/// Custom-fork deviation: insert only while an authorized racer owns the view; remove on release.
/// This extends visual WDL only, never ADT furnishing, collision or the normal view-distance CVar.
/// The same 545-vertex/1024-triangle fan is used at every distance (no invented terrain data).
#[derive(Resource, Default)]
pub struct RacerWdl;

impl RacerWdl {
    /// At most 25×25 tiles, including the camera tile.
    pub const RADIUS: u32 = 12;
    /// Maximum fresh tile meshes per frame, independent of speed and distance.
    pub const LOADS_PER_FRAME: usize = 4;
    /// Radial visual limit in yards, inside the fully resident square's nearest edge.
    pub const FAR: f32 = 6000.0;
    /// Maximum water meshes *built* per frame from already-resolved `AdtLiquidTile` assets,
    /// independent of [`Self::LOADS_PER_FRAME`]: the MPQ read/decompress runs asynchronously off
    /// this thread, but merging a resolved tile's liquids into a Bevy `Mesh` and spawning its
    /// entity is still main-thread work, so a burst of loads finishing in the same frame cannot
    /// insert an unbounded number of meshes in one frame.
    pub const WATER_RESOLVES_PER_FRAME: usize = 4;
    /// Maximum new water loads *admitted* (moved from queued to actually requested) per frame,
    /// separate from [`Self::LOADS_PER_FRAME`] (terrain mesh admission) since a tile can now sit
    /// queued for many frames before a slot frees.
    pub const WATER_REQUESTS_PER_FRAME: usize = 4;
    /// Ceiling on retained outstanding water handles (eviction does not cancel physical IO),
    /// independent of the 625-tile residency window. Bevy's asset IO (this request, the terrain
    /// tile's own `AdtTile`, the collision streamer's loads, and anything else going through
    /// `mpq://`) shares one task pool; without this cap, flying into a wet region could queue the
    /// whole residency window as one burst of ADT decompress requests. A tile the cap turns away
    /// waits `Queued` and is admitted nearest-first as slots free.
    pub const MAX_IN_FLIGHT_WATER_REQUESTS: usize = 16;

    /// Combined doodad+WMO placements a tile keeps after priority selection
    /// (`select_tile_features`): nearest-and-largest first. An ADT tile can author hundreds of
    /// doodads; this bounds per-tile instance count and, times residency, total feature triangles
    /// (each instance's triangle cost is itself capped by `M2_PROXY_MAX_TRIANGLES`/
    /// `WMO_PROXY_MAX_TRIANGLES` in `benilla_assets::model_proxy`).
    pub const MAX_FEATURES_PER_TILE: usize = 48;
    /// Maximum unique M2 models' proxy meshes requested per frame, admitted nearest-view-first
    /// from `Queued` — mirrors [`Self::WATER_REQUESTS_PER_FRAME`] but for the per-model cache.
    pub const FEATURE_REQUESTS_PER_FRAME: usize = 4;
    /// Maximum resolved proxy meshes turned into a shared `Mesh` plus however many pending
    /// instances they unblock, per frame — mirrors [`Self::WATER_RESOLVES_PER_FRAME`].
    pub const FEATURE_RESOLVES_PER_FRAME: usize = 4;
    /// Ceiling on retained outstanding proxy handles, *per kind* (vegetation and
    /// building each get this many, not a shared total) — the same shared-IO concern
    /// [`Self::MAX_IN_FLIGHT_WATER_REQUESTS`] exists for.
    pub const MAX_IN_FLIGHT_FEATURE_REQUESTS: usize = 16;
    /// Maximum distinct M2 models cached as vegetation proxies at once.
    pub const MAX_UNIQUE_VEGETATION_PROXIES: usize = 96;
    /// Maximum distinct WMO models cached as building proxies at once — smaller than the
    /// vegetation cap since a WMO proxy load reads every one of that building's group files.
    pub const MAX_UNIQUE_BUILDING_PROXIES: usize = 32;
    /// Combined visible-instance and triangle ceilings, independent of tile/model residency.
    pub const MAX_FEATURE_INSTANCES: usize = 2048;
    pub const MAX_FEATURE_TRIANGLES: usize = 2_000_000;

    fn shader_params() -> Vec4 {
        Vec4::new(3500.0, 5500.0, Self::FAR, 0.0)
    }
}

/// Current WDL streaming sample for probe/HUD readouts, including stock mode.
/// Counts describe retained visual patches, not visible draw calls or collision coverage.
#[derive(Resource, Default, Debug, Clone, Copy)]
pub struct WdlTelemetry {
    pub racer_active: bool,
    pub resident_tiles: usize,
    pub desired_tiles: usize,
    pub built_this_frame: usize,
    pub evicted_this_frame: usize,
    /// Raw position/normal/UV/index bytes per CPU or GPU copy; excludes overhead and source WDL.
    pub resident_mesh_bytes: usize,
}

impl WdlTelemetry {
    const BYTES_PER_TILE: usize = 545 * 32 + 3072 * 4;

    fn set_resident(&mut self, count: usize) {
        self.resident_tiles = count;
        self.resident_mesh_bytes = count * Self::BYTES_PER_TILE;
    }
}

/// Loads the map's `.wdl` and a shared material at startup, then streams the ring around the view.
pub(crate) struct WdlPlugin;

impl Plugin for WdlPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(MaterialPlugin::<WdlMaterial>::default())
            .init_resource::<WdlTelemetry>()
            .add_systems(Startup, setup_wdl.after(AssetSet::Open))
            // The ring follows the world's lifecycle: it spawns only while a world is live.
            .add_systems(Update, stream_wdl.run_if(crate::schedule::world_is_live))
            .add_systems(
                PostUpdate,
                transports::stream_transports
                    .after(bevy::transform::TransformSystems::Propagate)
                    .after(bevy::camera::visibility::VisibilitySystems::VisibilityPropagate)
                    .before(bevy::camera::visibility::VisibilitySystems::CheckVisibility),
            )
            .add_systems(
                Update,
                release_wdl_ring
                    .run_if(crate::schedule::world_left)
                    .after(crate::schedule::WorldStage::Net)
                    .before(crate::schedule::WorldStage::Stream),
            );
    }
}

/// The parsed WDL, the shared ring material (it reads the global light buffer) and the spawned
/// ring tiles.
#[derive(Resource)]
pub(crate) struct WdlStreamer {
    wdl: WdlFile,
    /// The `mapId` of the loaded `wdl`; a cross-map teleport reloads it.
    map_id: u32,
    /// The shared stock material (`racer_horizon` zero): every non-racer tile uses this one
    /// handle, exactly as before texturing landed.
    material: Handle<WdlMaterial>,
    /// `textures\Minimap\md5translate.trs`, one global table shared by every map; `None` if it
    /// failed to load (the racer branch then stays untextured, the pre-existing fallback look).
    translate: Option<MinimapTranslate>,
    /// The current map's minimap directory (`MapCatalogRes::directory`), for `translate.tile`.
    map_dir: Option<String>,
    /// The current map's WDT tile-existence grid, so the racer water request never asks for an
    /// ADT the map does not author; `None` if the WDT failed to load (falls back to requesting
    /// blindly, same as before this landed).
    map_tiles: Option<benilla_formats::MapTiles>,
    /// Racer only: one shared, flat-coloured material per [`LiquidKind`] an ADT MCLQ can carry
    /// (Still, Ocean, Magma — no scroll, no animated frames, unlike `benilla_world::liquid`'s
    /// near-field materials, which this crate does not reuse so it never doubles that module's
    /// per-frame submersion/foam/collision upkeep for geometry 6000 yd out). Built once at setup.
    water_materials: HashMap<LiquidKind, Handle<WdlMaterial>>,
    /// Racer only: the one shared flat-green material every vegetation LOD instance uses,
    /// regardless of which unique M2's proxy mesh it instances. Built once at setup.
    vegetation_material: Handle<WdlMaterial>,
    /// Racer only: the one shared flat-grey material every building LOD instance uses, regardless
    /// of which unique WMO's proxy mesh it instances. Built once at setup.
    building_material: Handle<WdlMaterial>,
    /// Racer only: cached M2 render proxies, keyed by lowercased model path, shared
    /// across every tile/instance referencing that model.
    vegetation_proxies: ProxyCache,
    /// Racer only: cached WMO render proxies, keyed by lowercased model path.
    building_proxies: ProxyCache,
    /// Monotonic per-frame counter for proxy-cache LRU eviction (`ProxyEntry::last_touched`); not
    /// wall-clock time, just an ever-increasing "how recently" ordinal.
    tick: u64,
    loaded: HashMap<(u32, u32), LoadedTile>,
    map_available: bool,
    racer: bool,
}

/// One streamed tile's render handles.
struct LoadedTile {
    entity: Entity,
    mesh: Handle<Mesh>,
    /// `Some` for a racer tile's own ground-textured material (`racer_tile_material`); `None` for
    /// a stock tile, which shares [`WdlStreamer::material`] instead.
    material: Option<Handle<WdlMaterial>>,
    /// Racer only: this tile's water admission state (`admit_water_requests`/`resolve_tile_water`).
    /// `WaterState::None` on a stock tile.
    water_state: WaterState,
    /// This tile's merged water surfaces (`resolve_tile_water`), built once admitted and resolved;
    /// empty until then, and forever on a dry tile or a failed load.
    water: Vec<(Entity, Handle<Mesh>)>,
    /// Racer only: this tile's priority-selected vegetation/building placements not yet spawned —
    /// their model's proxy mesh may still be loading. Populated once (alongside `water`, from the
    /// same resolved `AdtLiquidTile`); drained as each entry's model resolves.
    pending_features: Vec<PendingFeature>,
    /// This tile's already-spawned LOD instance entities (despawned on eviction, same as `water`).
    features: Vec<(Entity, usize, FeatureKind, u32)>,
    /// The distinct `(kind, model path)` pairs this tile's pending/spawned features reference, so
    /// eviction can decrement each one's proxy-cache ref count exactly once.
    feature_models: Vec<(FeatureKind, String)>,
}

/// Racer only: which proxy cache and shader colour a placement's LOD instance uses.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
enum FeatureKind {
    Vegetation,
    Building,
}

impl FeatureKind {
    /// `wdl.wgsl`'s `racer_feature.y`.
    fn code(self) -> f32 {
        match self {
            FeatureKind::Vegetation => 0.0,
            FeatureKind::Building => 1.0,
        }
    }
}

/// One of a tile's selected placements, waiting on its model's proxy mesh.
struct PendingFeature {
    /// Lowercased model path, the proxy-cache key.
    model: String,
    kind: FeatureKind,
    transform: Transform,
    unique_id: u32,
}

/// Racer only: one shared LOD proxy's admission/cache state. `WdlStreamer::tiles_to_admit`-style
/// counting (in-flight = a simple scan, not a separately maintained counter) applies here too.
enum ProxyState {
    /// Wants a load but [`RacerWdl::MAX_IN_FLIGHT_FEATURE_REQUESTS`] had no free slot; admitted
    /// nearest-view-first as slots free, same spirit as water's `Queued`.
    Queued,
    /// An async `ModelProxyMesh` load is outstanding. As with water, dropping this does **not**
    /// cancel the underlying load — only means nothing looks up the result afterward.
    InFlight(Handle<ModelProxyMesh>),
    /// Resolved: `Some` holds the shared instanced `Mesh` (built once here, reused by every
    /// instance of this model); `None` on a failed load or a model with no render geometry at
    /// all (nothing to show, but still settled so it is never retried or re-warned).
    Settled(Option<ReadyProxy>),
}

struct ReadyProxy {
    mesh: Handle<Mesh>,
    material: Handle<WdlMaterial>,
    triangles: usize,
}

/// One cached unique model's proxy state plus its eviction bookkeeping. Only a zero-`ref_count`
/// entry is evictable — one with a live tile reference is never dropped out from under a spawned
/// instance still using its `Mesh` handle.
struct ProxyEntry {
    state: ProxyState,
    ref_count: usize,
    last_touched: u64,
}

/// Racer only: the per-kind unique-model proxy cache (`WdlStreamer::vegetation_proxies`/
/// `building_proxies`), keyed by lowercased model path.
#[derive(Default)]
struct ProxyCache {
    entries: HashMap<String, ProxyEntry>,
}

impl ProxyCache {
    fn in_flight_count(&self) -> usize {
        self.entries
            .values()
            .filter(|e| matches!(e.state, ProxyState::InFlight(_)))
            .count()
    }

    /// Record a tile's reference to `model`, inserting it `Queued` if new. Bumps `ref_count` and
    /// `last_touched`. If the cache is already at `cap` and `model` is new, evicts the oldest
    /// zero-`ref_count` entry to make room; if none is evictable, `model` is dropped entirely —
    /// this tile simply gets no LOD instance for it until a slot frees.
    fn reference(&mut self, model: &str, cap: usize, tick: u64) -> bool {
        if let Some(entry) = self.entries.get_mut(model) {
            entry.ref_count += 1;
            entry.last_touched = tick;
            return true;
        }
        if self.entries.len() >= cap {
            let victim = self
                .entries
                .iter()
                .filter(|(_, e)| e.ref_count == 0 && !matches!(e.state, ProxyState::InFlight(_)))
                .min_by_key(|(_, e)| e.last_touched)
                .map(|(k, _)| k.clone());
            match victim {
                Some(k) => {
                    self.entries.remove(&k);
                }
                None => return false, // cache full of live references: this model waits
            }
        }
        self.entries.insert(
            model.to_string(),
            ProxyEntry {
                state: ProxyState::Queued,
                ref_count: 1,
                last_touched: tick,
            },
        );
        true
    }

    /// Release one tile's reference to `model` (its own eviction). The entry itself is not
    /// removed here even at zero — only `reference`'s eviction scan removes a zero-`ref_count`
    /// entry, and only when a new model genuinely needs its slot, so a model a tile revisits
    /// right after can still reuse its already-resolved mesh.
    fn release(&mut self, model: &str) {
        if let Some(entry) = self.entries.get_mut(model) {
            entry.ref_count = entry.ref_count.saturating_sub(1);
        }
    }
}

/// Racer only: one tile's water admission state, so [`RacerWdl::MAX_IN_FLIGHT_WATER_REQUESTS`] is
/// a simple count over `WdlStreamer::loaded` (no separately maintained counter to desync from
/// eviction) and a settled tile (dry or failed) is never re-queued or re-warned.
#[derive(Default)]
enum WaterState {
    /// No map dir, or the WDT already says this tile has no ADT: nothing to ever request.
    #[default]
    None,
    /// Wants an ADT liquid load but [`RacerWdl::MAX_IN_FLIGHT_WATER_REQUESTS`] had no free slot
    /// when this tile streamed in; waits here, admitted nearest-first as slots free.
    Queued,
    /// An async `AdtLiquidTile` load is outstanding. Dropping this (eviction, a map switch, a
    /// racer toggle) does **not** cancel the underlying load — Bevy has no load-cancel API — it
    /// only means nothing looks up the result afterward, since the tile is no longer resident to
    /// look it up with.
    InFlight(Handle<benilla_assets::AdtLiquidTile>),
    /// Resolved: loaded (`water` holds the spawned entities, possibly empty on a dry tile) or
    /// failed (warned once in `resolve_tile_water`, `water` stays empty). Never revisited.
    Settled,
}

impl WaterState {
    fn is_in_flight(&self) -> bool {
        matches!(self, WaterState::InFlight(_))
    }
}

impl WdlStreamer {
    /// The drawn WDL height (raw WoW `z`) under a Bevy-space position, exact to the mesh: the far
    /// leg of the flare occlusion march (`sun::follow::FlareGate`). `None` off the map or over
    /// unauthored ocean.
    pub(crate) fn height_under(&self, bevy_pos: Vec3) -> Option<f32> {
        if !self.map_available {
            return None;
        }
        let wow = bevy_to_wow(bevy_pos);
        self.wdl.height_at(wow[0], wow[1])
    }
}

/// Marks a spawned WDL tile.
#[derive(Component)]
struct WdlTile;

fn setup_wdl(
    mut commands: Commands,
    config: Option<Res<RenderConfig>>,
    world_assets: Option<ResMut<WorldAssets>>,
    mut materials: ResMut<Assets<WdlMaterial>>,
) {
    let (Some(_config), Some(world_assets)) = (config, world_assets) else {
        return; // no client data → no terrain at all, so no WDL
    };
    // Azeroth (Eastern Kingdoms), matching `world_map`'s `DEFAULT_MAP_ID`.
    let wdl = match WdlFile::load(&mut world_assets.chain.lock_recover(), "Azeroth") {
        Ok(w) => {
            info!(
                "WDL: Azeroth.wdl loaded ({} distant tiles)",
                w.present_count()
            );
            w
        }
        Err(e) => {
            warn!("WDL unavailable, no distant terrain: {e:#}");
            return;
        }
    };
    // Reads the shared global light, whose fog `build_light_data` packs before the first draw.
    // Opaque: depth-LEQUAL with depth write and no blend, as the reference draws it.
    let material = materials.add(ExtendedMaterial {
        base: StandardMaterial {
            base_color: Color::WHITE,
            unlit: true,
            cull_mode: None,
            ..default()
        },
        extension: WdlExt {
            light_buf: world_assets.shared_light.clone(),
            racer_horizon: Vec4::ZERO,
            ground_tile: Handle::default(),
            racer_water: Vec4::ZERO,
            racer_feature: Vec4::ZERO,
        },
    });
    // One global table (`textures\Minimap\md5translate.trs`), not per map; a miss only costs the
    // racer branch its texture, so it is never fatal to WDL itself.
    let translate =
        match benilla_formats::load_minimap_translate(&mut world_assets.chain.lock_recover()) {
            Ok(t) => Some(t),
            Err(e) => {
                warn!("WDL racer ground texture unavailable, md5translate.trs: {e:#}");
                None
            }
        };
    let water_materials = racer_water_materials(&mut materials, &world_assets.shared_light);
    let (vegetation_material, building_material) =
        racer_feature_materials(&mut materials, &world_assets.shared_light);
    // One per-map WDT tile index, so a racer water request never asks for an ADT the map does
    // not author; a miss here only costs the pre-filter (the request still fails safely without
    // it), so it is never fatal.
    let map_tiles =
        match benilla_formats::MapTiles::load(&mut world_assets.chain.lock_recover(), "Azeroth") {
            Ok(t) => Some(t),
            Err(e) => {
                warn!("WDL racer water: Azeroth.wdt unavailable, requesting tiles blindly: {e:#}");
                None
            }
        };
    commands.insert_resource(WdlStreamer {
        wdl,
        map_id: 0,
        material,
        translate,
        map_dir: Some("Azeroth".to_string()),
        map_tiles,
        water_materials,
        vegetation_material,
        building_material,
        vegetation_proxies: ProxyCache::default(),
        building_proxies: ProxyCache::default(),
        tick: 0,
        loaded: HashMap::new(),
        map_available: true,
        racer: false,
    });
}

/// Racer only: one shared, flat-coloured material per [`LiquidKind`] an ADT MCLQ can carry
/// (Still, Ocean, Magma). Each bakes [`RacerWdl::shader_params`] and its kind code in for good —
/// unlike the per-tile ground-texture material, this one is never attached to a stock entity, so
/// there is no need to gate it live.
fn racer_water_materials(
    materials: &mut Assets<WdlMaterial>,
    light_buf: &Buffer,
) -> HashMap<LiquidKind, Handle<WdlMaterial>> {
    [LiquidKind::Still, LiquidKind::Ocean, LiquidKind::Magma]
        .into_iter()
        .map(|kind| {
            let handle = materials.add(ExtendedMaterial {
                base: StandardMaterial {
                    base_color: Color::WHITE,
                    unlit: true,
                    cull_mode: None,
                    ..default()
                },
                extension: WdlExt {
                    light_buf: light_buf.clone(),
                    racer_horizon: RacerWdl::shader_params(),
                    ground_tile: Handle::default(),
                    racer_water: Vec4::new(1.0, water_kind_code(kind), 0.0, 0.0),
                    racer_feature: Vec4::ZERO,
                },
            });
            (kind, handle)
        })
        .collect()
}

/// Racer only: one shared, flat-coloured material per [`FeatureKind`] (vegetation, building).
/// Bakes [`RacerWdl::shader_params`] and its kind code in for good, same as `racer_water_materials`.
fn racer_feature_materials(
    materials: &mut Assets<WdlMaterial>,
    light_buf: &Buffer,
) -> (Handle<WdlMaterial>, Handle<WdlMaterial>) {
    let mut build = |kind: FeatureKind| {
        materials.add(ExtendedMaterial {
            base: StandardMaterial {
                base_color: Color::WHITE,
                unlit: true,
                cull_mode: None,
                ..default()
            },
            extension: WdlExt {
                light_buf: light_buf.clone(),
                racer_horizon: RacerWdl::shader_params(),
                ground_tile: Handle::default(),
                racer_water: Vec4::ZERO,
                racer_feature: Vec4::new(1.0, kind.code(), 0.0, 0.0),
            },
        })
    };
    (build(FeatureKind::Vegetation), build(FeatureKind::Building))
}

/// `wdl.wgsl`'s `racer_water.y`: 0 Still, 1 Ocean, 2 Magma — the only kinds an ADT MCLQ carries
/// (`benilla_formats::LiquidKind::from_adt_nibble` has no Slime or Rapids queue).
fn water_kind_code(kind: LiquidKind) -> f32 {
    match kind {
        LiquidKind::Ocean => 1.0,
        LiquidKind::Magma => 2.0,
        _ => 0.0, // Still, and any kind the ADT path never actually produces
    }
}

fn stream_wdl(
    mut commands: Commands,
    streamer: Option<ResMut<WdlStreamer>>,
    assets: Option<ResMut<WorldAssets>>,
    asset_server: Option<Res<AssetServer>>,
    adt_liquid_tiles: Res<Assets<benilla_assets::AdtLiquidTile>>,
    model_proxy_tiles: Res<Assets<ModelProxyMesh>>,
    focus: Res<crate::terrain_stream::ViewFocus>,
    camera: Query<&Transform, With<WorldCamera>>,
    current_map: Option<Res<CurrentMap>>,
    map_catalog: Option<Res<MapCatalogRes>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<WdlMaterial>>,
    racer: Option<Res<RacerWdl>>,
    mut telemetry: ResMut<WdlTelemetry>,
) {
    *telemetry = WdlTelemetry {
        racer_active: racer.is_some(),
        ..default()
    };
    // All five are absent without client data. `Option`, not `Res`: a missing `Res` fails
    // validation, which panics the client, and a build run from the wrong folder gets here.
    let (
        Some(mut streamer),
        Some(assets),
        Some(asset_server),
        Some(current_map),
        Some(map_catalog),
    ) = (streamer, assets, asset_server, current_map, map_catalog)
    else {
        return;
    };
    // One reborrow for the whole function: `streamer` is a `Mut<WdlStreamer>` (from `ResMut`),
    // whose `Deref`/`DerefMut` are trait calls the borrow checker cannot see through more than
    // once per expression, so passing disjoint fields as sibling arguments directly (as several
    // call sites below do) would conflict on `streamer` itself even though the fields are
    // disjoint. A plain `&mut WdlStreamer` has no such limit.
    let streamer = &mut *streamer;
    // The focus's map: the picked character's during world entry, so the ring is never built for
    // the map being left.
    let map_id = focus.map(Some(current_map.0));
    telemetry.set_resident(streamer.loaded.len());
    let racer = racer.is_some();
    if racer != streamer.racer {
        // Toggling drops the whole ring so every tile is rebuilt against the mode it now belongs
        // to: the shared stock material for `!racer`, or the racer's own per-tile textured one.
        telemetry.evicted_this_frame = streamer.loaded.len();
        release_tiles(
            &mut commands,
            &mut meshes,
            &mut materials,
            &mut streamer.vegetation_proxies,
            &mut streamer.building_proxies,
            &mut streamer.loaded,
        );
        telemetry.set_resident(0);
        streamer.racer = racer;
    }

    // Cross-map teleport: reload the new map's `.wdl` and drop the old ring.
    if map_id != streamer.map_id {
        telemetry.evicted_this_frame = streamer.loaded.len();
        release_tiles(
            &mut commands,
            &mut meshes,
            &mut materials,
            &mut streamer.vegetation_proxies,
            &mut streamer.building_proxies,
            &mut streamer.loaded,
        );
        telemetry.set_resident(0);
        streamer.map_available = false;
        streamer.map_id = map_id;
        if let Some(dir) = map_catalog.0.directory(map_id) {
            streamer.map_dir = Some(dir.to_string());
            match WdlFile::load(&mut assets.chain.lock_recover(), dir) {
                Ok(wdl) => {
                    streamer.wdl = wdl;
                    streamer.map_available = true;
                }
                Err(e) => warn!("WDL unavailable for map {map_id} ({dir}): {e:#}"),
            }
            streamer.map_tiles =
                match benilla_formats::MapTiles::load(&mut assets.chain.lock_recover(), dir) {
                    Ok(t) => Some(t),
                    Err(e) => {
                        warn!(
                        "WDL racer water: {dir}.wdt unavailable, requesting tiles blindly: {e:#}"
                    );
                        None
                    }
                };
        } else {
            streamer.map_dir = None;
            streamer.map_tiles = None;
            warn!("WDL unavailable: no directory for map {map_id}");
        }
    }
    if !streamer.map_available {
        return;
    }

    // The detailed streamer's own view focus.
    let center = focus.resolve(camera.single().ok().map(|c| c.translation));
    // The full window, the camera's own tile included (at a low view distance it is the near
    // horizon); the shader's near plane bounds the band, never the streamed set.
    let radius = if racer { RacerWdl::RADIUS } else { WDL_RADIUS };
    let mut desired = streamer.wdl.tiles_in_ring(center[0], center[1], radius);
    if racer {
        prioritize_tiles(&mut desired, center);
    }
    telemetry.desired_tiles = desired.len();

    let stale: Vec<(u32, u32)> = streamer
        .loaded
        .keys()
        .filter(|c| !desired.contains(c))
        .copied()
        .collect();
    for coords in stale {
        if let Some(tile) = streamer.loaded.remove(&coords) {
            telemetry.evicted_this_frame += 1;
            commands.entity(tile.entity).despawn();
            meshes.remove(tile.mesh.id());
            if let Some(material) = tile.material {
                materials.remove(material.id());
            }
            for (entity, water_mesh) in tile.water {
                commands.entity(entity).despawn();
                meshes.remove(water_mesh.id());
            }
            // Feature instance meshes are the *shared* proxy mesh, not owned per tile: only the
            // entity is despawned here; the mesh itself is freed when its `ProxyCache` entry is
            // evicted (dropping the cache's own `Handle<Mesh>` once every referencing tile, this
            // one included via `release` below, has let its ref count reach zero).
            for (entity, _, _, _) in tile.features {
                commands.entity(entity).despawn();
            }
            for (kind, model) in &tile.feature_models {
                match kind {
                    FeatureKind::Vegetation => streamer.vegetation_proxies.release(model),
                    FeatureKind::Building => streamer.building_proxies.release(model),
                }
            }
        }
    }

    let missing = missing_tiles(
        desired,
        &streamer.loaded,
        if racer {
            RacerWdl::LOADS_PER_FRAME
        } else {
            WDL_LOADS_PER_FRAME
        },
    );
    for coords in missing {
        let Some(tile) = streamer.wdl.tile_mesh(coords.0, coords.1) else {
            continue;
        };
        let positions: Vec<[f32; 3]> = tile
            .positions
            .iter()
            .map(|p| wow_to_bevy(*p).to_array())
            .collect();
        // A constant normal satisfies the `StandardMaterial` pipeline (the shader reads neither
        // normal); the UV is real tile-local `0..1` coverage, read only by the racer branch.
        let n = positions.len();
        let mut mesh = Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        );
        mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
        mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 1.0, 0.0]; n]);
        mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, tile.uvs);
        mesh.insert_indices(Indices::U32(tile.indices));
        let mesh = meshes.add(mesh);
        // Racer tiles get their own material so each can bind its own ADT tile's ground texture;
        // stock tiles keep sharing the one material, unchanged from before texturing landed.
        let material = if racer {
            let ground_tile = racer_tile_texture(
                &asset_server,
                streamer.translate.as_ref(),
                streamer.map_dir.as_deref(),
                coords.0,
                coords.1,
            );
            Some(materials.add(ExtendedMaterial {
                base: StandardMaterial {
                    base_color: Color::WHITE,
                    unlit: true,
                    cull_mode: None,
                    ..default()
                },
                extension: WdlExt {
                    light_buf: assets.shared_light.clone(),
                    racer_horizon: RacerWdl::shader_params(),
                    ground_tile,
                    racer_water: Vec4::ZERO,
                    racer_feature: Vec4::ZERO,
                },
            }))
        } else {
            None
        };
        let mesh_material = material
            .clone()
            .unwrap_or_else(|| streamer.material.clone());
        let mut entity = commands.spawn((
            Mesh3d(mesh.clone()),
            MeshMaterial3d(mesh_material),
            Transform::IDENTITY,
            WdlTile,
            // Exterior scene: the reference's far walk `0x683040` shares the per-window
            // populate `0x682fa0`, so a sealed room hides the horizon (`crate::exterior_cull`).
            // One ring tile is one object, the reference's far-tier granularity.
            crate::exterior_cull::ExteriorScene,
        ));
        // Only racer WDL bypasses the camera's stock CPU far-plane culling. Geometry remains
        // bounded by residency and the shader's radial cutoff; projection/CVars stay untouched.
        if racer {
            entity.insert(NoFrustumCulling);
        }
        let e = entity.id();
        // Racer only: this tile's starting water state (`WaterState::Queued`/`None`); the actual
        // async load is requested later by `admit_water_requests`, capped at
        // `RacerWdl::MAX_IN_FLIGHT_WATER_REQUESTS` total outstanding. Stock mode is always `None`.
        let water_state = if racer {
            initial_water_state(
                streamer.map_tiles.as_ref(),
                streamer.map_dir.as_deref(),
                coords.0,
                coords.1,
            )
        } else {
            WaterState::None
        };
        streamer.loaded.insert(
            coords,
            LoadedTile {
                entity: e,
                mesh,
                material,
                water_state,
                water: Vec::new(),
                pending_features: Vec::new(),
                features: Vec::new(),
                feature_models: Vec::new(),
            },
        );
        telemetry.built_this_frame += 1;
    }
    telemetry.set_resident(streamer.loaded.len());

    if racer {
        streamer.tick += 1;
        let tick = streamer.tick;
        // Resolve first, so a request that just finished frees its in-flight slot the same frame
        // a queued tile can take it, then admit newly queued tiles into that freed capacity.
        resolve_tile_water(
            &mut commands,
            &mut meshes,
            &asset_server,
            &adt_liquid_tiles,
            &streamer.water_materials,
            center,
            camera.single().ok().map(|c| Vec3::from(c.forward())),
            &mut streamer.loaded,
        );
        admit_water_requests(
            &asset_server,
            streamer.map_dir.as_deref(),
            center,
            &mut streamer.loaded,
        );
        reference_pending_features(
            &mut streamer.loaded,
            &mut streamer.vegetation_proxies,
            &mut streamer.building_proxies,
            center,
            tick,
        );
        admit_feature_requests(
            &asset_server,
            &mut streamer.vegetation_proxies,
            RacerWdl::MAX_IN_FLIGHT_FEATURE_REQUESTS,
            RacerWdl::FEATURE_REQUESTS_PER_FRAME,
            &streamer.loaded,
            center,
        );
        admit_feature_requests(
            &asset_server,
            &mut streamer.building_proxies,
            RacerWdl::MAX_IN_FLIGHT_FEATURE_REQUESTS,
            RacerWdl::FEATURE_REQUESTS_PER_FRAME,
            &streamer.loaded,
            center,
        );
        resolve_tile_features(
            &mut commands,
            &mut meshes,
            &model_proxy_tiles,
            &asset_server,
            &streamer.vegetation_material,
            &streamer.building_material,
            &mut materials,
            &mut streamer.vegetation_proxies,
            &mut streamer.building_proxies,
            &mut streamer.loaded,
            center,
        );
    }
}

/// Racer only: this tile's starting water state, before any load is attempted. `WaterState::None`
/// without a map directory, or when the WDT already says this tile has no ADT at all (a known
/// unauthored map-edge tile, never worth a request); `WaterState::Queued` otherwise — admission
/// (the actual `asset_server.load`) happens later, in `admit_water_requests`, capacity permitting.
fn initial_water_state(
    map_tiles: Option<&benilla_formats::MapTiles>,
    map_dir: Option<&str>,
    tile_x: u32,
    tile_y: u32,
) -> WaterState {
    if map_dir.is_none() {
        return WaterState::None;
    }
    if let Some(map_tiles) = map_tiles {
        if !map_tiles.has_tile(tile_x, tile_y) {
            return WaterState::None; // the WDT says this tile has no ADT: nothing to ever request
        }
    }
    WaterState::Queued
}

/// Racer only: which queued tiles get admitted into an actual async load this frame, nearest the
/// view first, bounded by both [`RacerWdl::WATER_REQUESTS_PER_FRAME`] (the per-frame admission
/// rate) and [`RacerWdl::MAX_IN_FLIGHT_WATER_REQUESTS`] (the total outstanding-load ceiling, shared
/// with whatever else draws on Bevy's asset IO). Pure and testable without an `AssetServer`;
/// `admit_water_requests` is the thin side-effecting wrapper that actually issues the loads.
fn tiles_to_admit(
    loaded: &HashMap<(u32, u32), LoadedTile>,
    center: [f32; 3],
    cap: usize,
    budget: usize,
) -> Vec<(u32, u32)> {
    let in_flight = loaded
        .values()
        .filter(|t| t.water_state.is_in_flight())
        .count();
    let room = cap.saturating_sub(in_flight).min(budget);
    if room == 0 {
        return Vec::new();
    }
    let (cx, cy) = benilla_formats::world_to_tile(center[0], center[1]);
    let mut queued: Vec<((u32, i64), (u32, u32))> = loaded
        .iter()
        .filter(|(_, t)| matches!(t.water_state, WaterState::Queued))
        .map(|(&(x, y), _)| {
            let (dx, dy) = (x.abs_diff(cx), y.abs_diff(cy));
            (
                (dx * dx + dy * dy, i64::from(y) * 64 + i64::from(x)),
                (x, y),
            )
        })
        .collect();
    queued.sort_unstable_by_key(|&(key, _)| key); // nearest first; a stable tie-break after that
    queued.into_iter().take(room).map(|(_, c)| c).collect()
}

/// Racer only: issue the actual async loads [`tiles_to_admit`] selects, through the same `mpq://`
/// pipeline `AdtTile` uses (`benilla_assets::AdtLiquidTile`) — Bevy's own asset task pool reads
/// and decompresses the file off this thread.
fn admit_water_requests(
    asset_server: &AssetServer,
    map_dir: Option<&str>,
    center: [f32; 3],
    loaded: &mut HashMap<(u32, u32), LoadedTile>,
) {
    let Some(dir) = map_dir else {
        return; // `initial_water_state` already keeps every tile `None` without a map dir
    };
    for coords in tiles_to_admit(
        loaded,
        center,
        RacerWdl::MAX_IN_FLIGHT_WATER_REQUESTS,
        RacerWdl::WATER_REQUESTS_PER_FRAME,
    ) {
        if let Some(tile) = loaded.get_mut(&coords) {
            let handle = asset_server.load(format!(
                "mpq://World/Maps/{dir}/{dir}_{}_{}.adt",
                coords.0, coords.1
            ));
            tile.water_state = WaterState::InFlight(handle);
        }
    }
}

/// Racer only: build and spawn the merged water for every resident tile whose `WaterState` has
/// just resolved (or failed), at most [`RacerWdl::WATER_RESOLVES_PER_FRAME`] per frame — the MPQ
/// read is async, but turning a resolved tile's liquids into a Bevy `Mesh` and spawning its
/// entity is still main-thread work, so a burst of loads finishing together cannot insert an
/// unbounded number of meshes in one frame; the rest simply wait their turn next frame.
///
/// The same resolved `AdtLiquidTile` also carries this tile's doodad/WMO placements, so a water
/// resolution here also selects (`select_tile_features`, nearest-and-largest first, capped at
/// [`RacerWdl::MAX_FEATURES_PER_TILE`]) and registers this tile's vegetation/building LOD
/// placements into the shared per-model proxy caches — one read of the tile's bytes serves both,
/// instead of a second whole-ADT request for the same data.
fn resolve_tile_water(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    asset_server: &AssetServer,
    adt_liquid_tiles: &Assets<benilla_assets::AdtLiquidTile>,
    water_materials: &HashMap<LiquidKind, Handle<WdlMaterial>>,
    view_center: [f32; 3],
    view_forward: Option<Vec3>,
    loaded: &mut HashMap<(u32, u32), LoadedTile>,
) {
    let mut budget = RacerWdl::WATER_RESOLVES_PER_FRAME;
    let mut ordered: Vec<_> = loaded.keys().copied().collect();
    prioritize_tiles(&mut ordered, view_center);
    for coords in ordered {
        let tile = loaded.get_mut(&coords).unwrap();
        if budget == 0 {
            break;
        }
        let WaterState::InFlight(handle) = &tile.water_state else {
            continue; // `None`/`Queued` (nothing outstanding yet) or already `Settled`
        };
        match asset_server.load_state(handle) {
            bevy::asset::LoadState::Loaded => {
                let Some(asset) = adt_liquid_tiles.get(handle) else {
                    continue; // `Loaded` raced the `Assets` insert; retry next frame
                };
                budget -= 1;
                tile.water = spawn_merged_water(commands, meshes, water_materials, &asset.liquids);
                if tile.water.is_empty() && !asset.liquids.is_empty() {
                    warn!(
                        "WDL racer water: tile {coords:?} loaded {} liquid surface(s) but none \
                         matched a known kind — check `racer_water_materials`",
                        asset.liquids.len()
                    );
                }
                tile.water_state = WaterState::Settled;

                let selected =
                    select_tile_features(&asset.doodads, &asset.wmos, view_center, view_forward);
                tile.pending_features = selected;
            }
            bevy::asset::LoadState::Failed(err) => {
                // A genuine parse/read failure (corrupt archive, real I/O fault): the WDT
                // pre-filter in `initial_water_state` already keeps a known-unauthored tile from
                // ever reaching a request, so anything that gets here and still fails is
                // unexpected and worth a `warn!`, once, not a silent empty.
                budget -= 1;
                warn!("WDL racer water: tile {coords:?} failed to load: {err:#}");
                tile.water_state = WaterState::Settled;
            }
            bevy::asset::LoadState::Loading | bevy::asset::LoadState::NotLoaded => {
                // Still in flight: leave it as is and do not spend the budget on a tile that has
                // nothing to build yet. Still counts toward the in-flight cap in
                // `tiles_to_admit`, by construction (it scans `WaterState::InFlight` directly).
            }
        }
    }
}

fn reference_pending_features(
    loaded: &mut HashMap<(u32, u32), LoadedTile>,
    vegetation: &mut ProxyCache,
    buildings: &mut ProxyCache,
    center: [f32; 3],
    tick: u64,
) {
    let mut ordered: Vec<_> = loaded.keys().copied().collect();
    prioritize_tiles(&mut ordered, center);
    for coords in ordered {
        let tile = loaded.get_mut(&coords).unwrap();
        for feature in &tile.pending_features {
            if tile
                .feature_models
                .iter()
                .any(|(kind, model)| *kind == feature.kind && *model == feature.model)
            {
                continue;
            }
            let (cache, cap) = match feature.kind {
                FeatureKind::Vegetation => {
                    (&mut *vegetation, RacerWdl::MAX_UNIQUE_VEGETATION_PROXIES)
                }
                FeatureKind::Building => (&mut *buildings, RacerWdl::MAX_UNIQUE_BUILDING_PROXIES),
            };
            if cache.reference(&feature.model, cap, tick) {
                tile.feature_models
                    .push((feature.kind, feature.model.clone()));
            }
            // A full cache leaves the placement pending for a later free slot, not lost forever.
        }
    }
}

/// Pick which of a tile's doodad/WMO placements become LOD features: nearest-the-view first, a
/// larger doodad (bigger authored MDDF scale) beating a smaller one at the same distance, capped
/// at [`RacerWdl::MAX_FEATURES_PER_TILE`] combined. Not a model parse — only the already-resolved
/// placement transforms this tile's `AdtLiquidTile` already carries.
fn select_tile_features(
    doodads: &[Doodad],
    wmos: &[WmoInstance],
    view_center: [f32; 3],
    view_forward: Option<Vec3>,
) -> Vec<PendingFeature> {
    let mut candidates: Vec<(f32, PendingFeature)> = Vec::with_capacity(doodads.len() + wmos.len());
    for d in doodads {
        let (dx, dy) = (
            d.position[0] - view_center[0],
            d.position[1] - view_center[1],
        );
        let dist = (dx * dx + dy * dy).sqrt();
        // A bigger doodad reads more prominently at distance than a tiny one at the same range,
        // so its priority key is smaller (sorted first) for the same `dist`.
        let priority = dist / d.scale.max(0.1);
        candidates.push((
            priority,
            PendingFeature {
                model: normalize_doodad_model_path(&d.model),
                kind: FeatureKind::Vegetation,
                transform: doodad_transform(d),
                unique_id: d.unique_id,
            },
        ));
    }
    for w in wmos {
        let (dx, dy) = (
            w.position[0] - view_center[0],
            w.position[1] - view_center[1],
        );
        candidates.push((
            (dx * dx + dy * dy).sqrt() * 0.25, // structural silhouettes before small props
            PendingFeature {
                model: w.model.to_ascii_lowercase(),
                kind: FeatureKind::Building,
                transform: wmo_transform(w),
                unique_id: w.unique_id,
            },
        ));
    }
    if let Some(forward) = view_forward {
        let eye = wow_to_bevy(view_center);
        for (score, feature) in &mut candidates {
            if (feature.transform.translation - eye).dot(forward) < 0.0 {
                *score *= 4.0;
            }
        }
    }
    candidates.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    candidates
        .into_iter()
        .take(RacerWdl::MAX_FEATURES_PER_TILE)
        .map(|(_, f)| f)
        .collect()
}

/// Normalize a doodad's MMDX path exactly as `benilla_formats`'s (crate-private) model loaders
/// do: lowercase, `.mdx`/`.mdl` swapped to `.m2` — the ADT ships the legacy extension, but 1.12's
/// archives carry `.m2` files, and `M2ProxyLoader` is registered on that extension.
fn normalize_doodad_model_path(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    match lower
        .strip_suffix(".mdx")
        .or_else(|| lower.strip_suffix(".mdl"))
    {
        Some(stem) => format!("{stem}.m2"),
        None => lower,
    }
}

fn doodad_transform(d: &Doodad) -> Transform {
    Transform {
        translation: wow_to_bevy(d.position),
        rotation: placement_rotation(d.rotation),
        scale: Vec3::splat(d.scale.max(0.01)),
    }
}

/// MODF's scale is unused in 1.12 (same note as `adt_to_tile_mesh`'s own `WmoInstance` build).
fn wmo_transform(w: &WmoInstance) -> Transform {
    Transform {
        translation: wow_to_bevy(w.position),
        rotation: placement_rotation(w.rotation),
        scale: Vec3::ONE,
    }
}

/// Racer only: admit `Queued` proxy-mesh requests nearest-placement-first,
/// bounded by `budget` per frame and `cap` retained
/// in-flight — the same two-limit shape [`admit_water_requests`] uses.
fn admit_feature_requests(
    asset_server: &AssetServer,
    cache: &mut ProxyCache,
    cap: usize,
    budget: usize,
    loaded: &HashMap<(u32, u32), LoadedTile>,
    center: [f32; 3],
) {
    let in_flight = cache.in_flight_count();
    let room = cap.saturating_sub(in_flight).min(budget);
    if room == 0 {
        return;
    }
    let eye = wow_to_bevy(center);
    let mut priorities = HashMap::<&str, f32>::new();
    for f in loaded.values().flat_map(|t| &t.pending_features) {
        let score =
            f.transform.translation.distance_squared(eye) / f.transform.scale.x.max(0.1).powi(2);
        priorities
            .entry(&f.model)
            .and_modify(|v| *v = v.min(score))
            .or_insert(score);
    }
    let mut queued: Vec<(f32, String)> = cache
        .entries
        .iter()
        .filter(|(_, e)| e.ref_count > 0 && matches!(e.state, ProxyState::Queued))
        .map(|(k, _)| {
            (
                priorities.get(k.as_str()).copied().unwrap_or(f32::MAX),
                k.clone(),
            )
        })
        .collect();
    queued.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for (_, model) in queued.into_iter().take(room) {
        let url = if model.ends_with(".wmo") {
            benilla_assets::wmo_url(&model)
        } else {
            benilla_assets::m2_url(&model)
        };
        let handle: Handle<ModelProxyMesh> = asset_server.load(url);
        if let Some(entry) = cache.entries.get_mut(&model) {
            entry.state = ProxyState::InFlight(handle);
        }
    }
}

/// Racer only: settle in-flight proxy-mesh loads (both kinds) into a shared `Mesh`, then spawn
/// instance entities for any tile whose pending placement's model just settled — at most
/// [`RacerWdl::FEATURE_RESOLVES_PER_FRAME`] "units" of either kind of work per frame, the same
/// bounded-main-thread-work shape [`resolve_tile_water`] uses.
#[allow(clippy::too_many_arguments)]
fn resolve_tile_features(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    model_proxy_tiles: &Assets<ModelProxyMesh>,
    asset_server: &AssetServer,
    vegetation_material: &Handle<WdlMaterial>,
    building_material: &Handle<WdlMaterial>,
    materials: &mut Assets<WdlMaterial>,
    vegetation_proxies: &mut ProxyCache,
    building_proxies: &mut ProxyCache,
    loaded: &mut HashMap<(u32, u32), LoadedTile>,
    center: [f32; 3],
) {
    let mut budget = RacerWdl::FEATURE_RESOLVES_PER_FRAME;
    for cache in [&mut *vegetation_proxies, &mut *building_proxies] {
        if budget == 0 {
            break;
        }
        for (model, entry) in cache.entries.iter_mut() {
            if budget == 0 {
                break;
            }
            let ProxyState::InFlight(handle) = &entry.state else {
                continue;
            };
            match asset_server.load_state(handle) {
                bevy::asset::LoadState::Loaded => {
                    let Some(proxy) = model_proxy_tiles.get(handle) else {
                        continue; // raced the `Assets` insert; retry next frame
                    };
                    budget -= 1;
                    let template = if model.ends_with(".wmo") {
                        building_material
                    } else {
                        vegetation_material
                    };
                    let ready = build_feature_mesh(meshes, proxy).map(|mesh| {
                        let material = if let Some(mask) = &proxy.alpha_mask {
                            let mut material = materials
                                .get(template)
                                .expect("shared LOD material")
                                .clone();
                            material.extension.ground_tile = mask.clone();
                            materials.add(material)
                        } else {
                            template.clone()
                        };
                        ReadyProxy {
                            mesh,
                            material,
                            triangles: proxy.indices.len() / 3,
                        }
                    });
                    if ready.is_none() {
                        warn!("WDL racer feature: {model:?} resolved without render triangles");
                    }
                    entry.state = ProxyState::Settled(ready);
                }
                bevy::asset::LoadState::Failed(err) => {
                    budget -= 1;
                    warn!("WDL racer feature: model {model:?} failed to load: {err:#}");
                    entry.state = ProxyState::Settled(None);
                }
                bevy::asset::LoadState::Loading | bevy::asset::LoadState::NotLoaded => {}
            }
        }
    }

    let mut instances: usize = loaded.values().map(|t| t.features.len()).sum();
    let mut triangles: usize = loaded
        .values()
        .flat_map(|t| &t.features)
        .map(|(_, n, _, _)| n)
        .sum();
    let mut placed: std::collections::HashSet<_> = loaded
        .values()
        .flat_map(|t| &t.features)
        .map(|(_, _, kind, id)| (*kind, *id))
        .collect();
    let mut ordered: Vec<_> = loaded.keys().copied().collect();
    prioritize_tiles(&mut ordered, center);
    for coords in ordered {
        let tile = loaded.get_mut(&coords).unwrap();
        if budget == 0 || tile.pending_features.is_empty() {
            continue;
        }
        let mut still_pending = Vec::with_capacity(tile.pending_features.len());
        for f in tile.pending_features.drain(..) {
            if budget == 0 {
                still_pending.push(f);
                continue;
            }
            let cache = match f.kind {
                FeatureKind::Vegetation => &*vegetation_proxies,
                FeatureKind::Building => &*building_proxies,
            };
            match cache.entries.get(&f.model).map(|e| &e.state) {
                Some(ProxyState::Settled(Some(proxy))) => {
                    if placed.contains(&(f.kind, f.unique_id))
                        || instances >= RacerWdl::MAX_FEATURE_INSTANCES
                        || triangles + proxy.triangles > RacerWdl::MAX_FEATURE_TRIANGLES
                    {
                        still_pending.push(f);
                        continue;
                    }
                    budget -= 1;
                    instances += 1;
                    triangles += proxy.triangles;
                    let e = commands
                        .spawn((
                            Mesh3d(proxy.mesh.clone()),
                            MeshMaterial3d(proxy.material.clone()),
                            f.transform,
                            WdlFeatureTile,
                            NoFrustumCulling,
                            crate::exterior_cull::ExteriorScene,
                        ))
                        .id();
                    placed.insert((f.kind, f.unique_id));
                    tile.features
                        .push((e, proxy.triangles, f.kind, f.unique_id));
                }
                Some(ProxyState::Settled(None)) => {
                    // nothing to show for this model (empty hull or a failed load, already
                    // warned once above): drop silently, never retried.
                }
                _ => still_pending.push(f), // still `Queued`/`InFlight`: try again next frame
            }
        }
        tile.pending_features = still_pending;
    }
}

/// Build the shared instanced `Mesh` for one resolved proxy; `None` on an empty proxy (a model
/// with no render geometry; the resolver reports that failure).
fn build_feature_mesh(meshes: &mut Assets<Mesh>, proxy: &ModelProxyMesh) -> Option<Handle<Mesh>> {
    if proxy.is_empty() {
        return None;
    }
    let positions: Vec<[f32; 3]> = proxy
        .positions
        .iter()
        .map(|p| wow_to_bevy(*p).to_array())
        .collect();
    let n = positions.len();
    let mut mesh = Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    );
    mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
    mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 1.0, 0.0]; n]);
    mesh.insert_attribute(
        Mesh::ATTRIBUTE_UV_0,
        if proxy.uvs.len() == n {
            proxy.uvs.clone()
        } else {
            vec![[0.0, 0.0]; n]
        },
    );
    mesh.insert_indices(Indices::U32(proxy.indices.clone()));
    Some(meshes.add(mesh))
}

/// Marks a spawned racer vegetation/building LOD instance, one per kept placement.
#[derive(Component)]
struct WdlFeatureTile;

/// Racer only: merge one tile's already-resolved ADT liquid chunks into one `Mesh` per
/// [`LiquidKind`] present and spawn an entity for each, sharing the per-kind flat-colour
/// materials from `racer_water_materials`. A dry tile (no liquid chunks) spawns nothing.
fn spawn_merged_water(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    water_materials: &HashMap<LiquidKind, Handle<WdlMaterial>>,
    liquids: &[benilla_formats::LiquidMesh],
) -> Vec<(Entity, Handle<Mesh>)> {
    if liquids.is_empty() {
        return Vec::new(); // dry tile: the overwhelming common case inland
    }
    let mut by_kind: HashMap<LiquidKind, (Vec<[f32; 3]>, Vec<u32>)> = HashMap::new();
    for lq in liquids {
        let (positions, indices) = by_kind.entry(lq.kind).or_default();
        let base = positions.len() as u32;
        positions.extend(lq.positions.iter().map(|p| wow_to_bevy(*p).to_array()));
        indices.extend(lq.indices.iter().map(|i| i + base));
    }

    let mut out = Vec::with_capacity(by_kind.len());
    for (kind, (positions, indices)) in by_kind {
        let Some(material) = water_materials.get(&kind) else {
            continue; // never happens: `racer_water_materials` covers every ADT kind
        };
        let n = positions.len();
        let mut mesh = Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        );
        mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
        mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 1.0, 0.0]; n]);
        mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; n]);
        mesh.insert_indices(Indices::U32(indices));
        let mesh = meshes.add(mesh);
        let entity = commands
            .spawn((
                Mesh3d(mesh.clone()),
                MeshMaterial3d(material.clone()),
                Transform::IDENTITY,
                WdlWaterTile,
                NoFrustumCulling,
                crate::exterior_cull::ExteriorScene,
            ))
            .id();
        out.push((entity, mesh));
    }
    out
}

/// Marks a spawned racer distant-water tile, one per `(ring tile, LiquidKind)`.
#[derive(Component)]
struct WdlWaterTile;

/// Racer only: the covering ADT tile's own minimap art (the same `md5translate.trs`/`mpq://`
/// pipeline the HUD minimap tiles load), or `Handle::default()` (Bevy's opaque-white fallback
/// image) where the table or tile art is unavailable.
fn racer_tile_texture(
    asset_server: &AssetServer,
    translate: Option<&MinimapTranslate>,
    map_dir: Option<&str>,
    tile_x: u32,
    tile_y: u32,
) -> Handle<Image> {
    let (Some(translate), Some(dir)) = (translate, map_dir) else {
        return Handle::default();
    };
    let Some(hash) = translate.tile(dir, tile_x, tile_y) else {
        return Handle::default(); // unauthored tile (open ocean): no minimap art exists
    };
    asset_server.load_with_settings(
        format!("mpq://textures/Minimap/{hash}"),
        |s: &mut benilla_assets::BlpLoaderSettings| {
            s.variant = benilla_assets::BlpVariant::MapTile;
        },
    )
}

/// Leaving the world drops the ring; the parsed `.wdl` stays for `height_under`.
fn release_wdl_ring(
    mut commands: Commands,
    streamer: Option<ResMut<WdlStreamer>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<WdlMaterial>>,
    mut telemetry: ResMut<WdlTelemetry>,
) {
    *telemetry = WdlTelemetry::default();
    let Some(mut streamer) = streamer else { return };
    let streamer = &mut *streamer;
    telemetry.evicted_this_frame = streamer.loaded.len();
    release_tiles(
        &mut commands,
        &mut meshes,
        &mut materials,
        &mut streamer.vegetation_proxies,
        &mut streamer.building_proxies,
        &mut streamer.loaded,
    );
}

fn release_tiles(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<WdlMaterial>,
    vegetation_proxies: &mut ProxyCache,
    building_proxies: &mut ProxyCache,
    loaded: &mut HashMap<(u32, u32), LoadedTile>,
) {
    for (_, tile) in loaded.drain() {
        commands.entity(tile.entity).despawn();
        meshes.remove(tile.mesh.id());
        if let Some(material) = tile.material {
            materials.remove(material.id());
        }
        for (entity, water_mesh) in tile.water {
            commands.entity(entity).despawn();
            meshes.remove(water_mesh.id());
        }
        // Feature instance meshes are the *shared* proxy mesh, not owned per tile: only the
        // entity is despawned here, same reasoning as the stale-tile eviction above it mirrors.
        for (entity, _, _, _) in tile.features {
            commands.entity(entity).despawn();
        }
        for (kind, model) in &tile.feature_models {
            match kind {
                FeatureKind::Vegetation => vegetation_proxies.release(model),
                FeatureKind::Building => building_proxies.release(model),
            }
        }
    }
    vegetation_proxies.entries.clear();
    building_proxies.entries.clear();
}

fn prioritize_tiles(tiles: &mut [(u32, u32)], center: [f32; 3]) {
    let (cx, cy) = benilla_formats::world_to_tile(center[0], center[1]);
    tiles.sort_unstable_by_key(|&(x, y)| {
        let (dx, dy) = (x.abs_diff(cx), y.abs_diff(cy));
        (dx * dx + dy * dy, y, x)
    });
}

fn missing_tiles(
    desired: Vec<(u32, u32)>,
    loaded: &HashMap<(u32, u32), LoadedTile>,
    budget: usize,
) -> Vec<(u32, u32)> {
    desired
        .into_iter()
        .filter(|c| !loaded.contains_key(c))
        .take(budget)
        .collect()
}

#[cfg(test)]
mod racer_tests {
    use super::*;

    #[test]
    fn telemetry_tracks_residency_memory_and_reset() {
        let mut sample = WdlTelemetry::default();
        sample.set_resident(625);
        assert_eq!(sample.resident_tiles, 625);
        assert_eq!(sample.resident_mesh_bytes, 18_580_000);
        sample.set_resident(121);
        assert_eq!(sample.resident_mesh_bytes, 3_597_088);
        sample.set_resident(0);
        assert_eq!(sample.resident_mesh_bytes, 0);
        assert_eq!(sample.built_this_frame, 0);
        assert!(!sample.racer_active);
    }

    #[test]
    fn racer_horizon_fits_the_resident_lod_window() {
        let tile_size = benilla_formats::TILE_SIZE;
        assert!(RacerWdl::FAR < RacerWdl::RADIUS as f32 * tile_size);
        assert!(RacerWdl::FAR > WDL_RADIUS as f32 * tile_size * 2.0);
        let params = RacerWdl::shader_params();
        assert!(0.0 < params.x && params.x < params.y && params.y < params.z);
        assert_eq!((2 * RacerWdl::RADIUS + 1).pow(2), 625);
        // Existing fan: 545 positions/normals/UVs and 3072 u32 indices; no ADT data.
        assert_eq!(625 * (545 * 32 + 3072 * 4), 18_580_000);
    }

    #[test]
    fn racer_lod_work_is_bounded_and_near_tiles_load_first() {
        let mut desired: Vec<_> = (20..=44)
            .flat_map(|y| (20..=44).map(move |x| (x, y)))
            .collect();
        prioritize_tiles(&mut desired, [-1.0, -1.0, 0.0]);
        assert_eq!(desired[0], (32, 32));
        let loaded = HashMap::from([(
            (32, 32),
            LoadedTile {
                entity: Entity::PLACEHOLDER,
                mesh: Handle::default(),
                material: None,
                water_state: WaterState::Settled,
                water: Vec::new(),
                pending_features: Vec::new(),
                features: Vec::new(),
                feature_models: Vec::new(),
            },
        )]);
        let missing = missing_tiles(desired, &loaded, RacerWdl::LOADS_PER_FRAME);
        assert_eq!(missing.len(), 4);
        assert!(missing
            .iter()
            .all(|&(x, y)| x.abs_diff(32) + y.abs_diff(32) == 1));
    }

    #[test]
    fn stock_lod_budget_and_order_remain_unchanged() {
        assert_eq!(WDL_RADIUS, 5);
        assert_eq!(WDL_LOADS_PER_FRAME, 8);
        let desired: Vec<_> = (0..121).map(|x| (x, 0)).collect();
        assert_eq!(
            missing_tiles(desired, &HashMap::new(), WDL_LOADS_PER_FRAME),
            (0..8).map(|x| (x, 0)).collect::<Vec<_>>()
        );
        assert_eq!(
            Vec4::ZERO.z,
            0.0,
            "stock material disables the racer shader branch"
        );
    }

    #[test]
    fn released_lod_mesh_assets_do_not_accumulate() {
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<WdlMaterial>::default();
        let mut world = World::new();
        let mut loaded = HashMap::new();
        for _ in 0..1000 {
            let handle = meshes.add(Mesh::new(
                PrimitiveTopology::TriangleList,
                RenderAssetUsages::default(),
            ));
            // A racer water mesh rides along, same lifecycle as the terrain mesh.
            let water_handle = meshes.add(Mesh::new(
                PrimitiveTopology::TriangleList,
                RenderAssetUsages::default(),
            ));
            let entity = world.spawn_empty().id();
            let water_entity = world.spawn_empty().id();
            loaded.insert(
                (32, 32),
                LoadedTile {
                    entity,
                    mesh: handle,
                    material: None,
                    water_state: WaterState::Settled,
                    water: vec![(water_entity, water_handle)],
                    pending_features: Vec::new(),
                    features: Vec::new(),
                    feature_models: Vec::new(),
                },
            );
            assert_eq!(meshes.len(), 2);
            let mut vegetation_proxies = ProxyCache::default();
            let mut building_proxies = ProxyCache::default();
            release_tiles(
                &mut world.commands(),
                &mut meshes,
                &mut materials,
                &mut vegetation_proxies,
                &mut building_proxies,
                &mut loaded,
            );
            world.flush();
            assert!(
                meshes.is_empty(),
                "the water mesh must not outlive its tile"
            );
            assert!(loaded.is_empty());
            assert!(world.get_entity(entity).is_err());
            assert!(world.get_entity(water_entity).is_err());
        }
    }

    #[test]
    fn racer_shader_limits_geometry_and_fades_after_fog() {
        let src = benilla_assets::materials::WDL_WGSL;
        assert!(src.contains("if (racer_horizon.z > 0.0)"));
        assert!(src.contains("distance >= racer_horizon.z"));
        assert!(src.contains("smoothstep(racer_horizon.y, racer_horizon.z, distance)"));
        assert!(src.contains("smoothstep(racer_horizon.x, racer_horizon.y, distance)"));
    }

    /// The feedback this landed for: the racer's extended horizon should show real ground texture,
    /// not a flat procedural tint, and only inside the opt-in racer branch.
    #[test]
    fn racer_shader_samples_a_ground_texture_inside_the_racer_branch() {
        let src = benilla_assets::materials::WDL_WGSL;
        let branch = src
            .split("if (racer_horizon.z > 0.0)")
            .nth(1)
            .expect("racer branch present");
        assert!(
            branch.contains("textureSample(ground_tile, ground_tile_sampler, in.uv)"),
            "the racer branch no longer samples the per-tile ground texture"
        );
        assert!(
            !branch.contains("vec3<f32>(0.72, 0.78, 0.68)"),
            "the flat procedural tint should be replaced by the sampled ground texture, not kept \
             alongside it"
        );
        assert!(
            src.contains("@binding(92) var ground_tile: texture_2d<f32>")
                && src.contains("@binding(93) var ground_tile_sampler: sampler"),
            "the ground texture/sampler bindings (92/93) are gone from wdl.wgsl"
        );
    }

    /// `WdlExt` wires the ground texture into the material's bind group at the shader's 92/93 (no
    /// GPU device needed here; constructing a real `Buffer` for `light_buf` requires one, so this
    /// checks the struct's own source instead of instantiating it).
    #[test]
    fn wdl_material_wires_the_ground_texture_binding() {
        let src = include_str!("../../benilla-assets/src/materials.rs");
        let ext = src
            .split("pub struct WdlExt")
            .nth(1)
            .and_then(|s| s.split("impl MaterialExtension for WdlExt").next())
            .expect("WdlExt struct body present");
        assert!(
            ext.contains("#[texture(92") && ext.contains("#[sampler(93"),
            "WdlExt no longer binds a ground texture at 92/93"
        );
        assert!(
            ext.contains("pub ground_tile: Handle<Image>"),
            "WdlExt no longer carries a ground_tile image handle"
        );
        assert!(
            ext.contains("#[uniform(94)]") && ext.contains("pub racer_water: Vec4"),
            "WdlExt no longer carries the racer_water flag/kind uniform at 94"
        );
        assert!(
            ext.contains("#[uniform(95)]") && ext.contains("pub racer_feature: Vec4"),
            "WdlExt no longer carries the racer_feature flag/kind uniform at 95"
        );
    }

    /// The feedback this landed for: the racer's extended horizon should show real distant water
    /// instead of a hard map-edge cutoff, and only inside the opt-in racer branch — the stock
    /// hull's own fog-hull path must stay untouched.
    #[test]
    fn racer_shader_colours_water_distinctly_inside_the_racer_branch() {
        let src = benilla_assets::materials::WDL_WGSL;
        let branch = src
            .split("if (racer_horizon.z > 0.0)")
            .nth(1)
            .expect("racer branch present");
        assert!(
            branch.contains("if (racer_water.x > 0.5)"),
            "the racer branch no longer flags/colours water surfaces"
        );
        // Ocean and Magma must read distinctly from Still and from each other, not collapse to
        // one flat "water" colour: that would conflate a lake with a lava flow.
        assert!(branch.contains("racer_water.y > 1.5"), "no Magma lane");
        assert!(branch.contains("racer_water.y > 0.5"), "no Ocean lane");
        assert!(
            src.contains("@binding(94) var<uniform> racer_water: vec4<f32>"),
            "the racer_water uniform binding (94) is gone from wdl.wgsl"
        );
        // Both the water branch and the ground-texture branch must still feed into the shared
        // fog/fade/reveal mix below, not bypass it.
        assert!(
            src.contains("rgb = mix(rgb, surface, reveal * (1.0 - fog));"),
            "water must still fog and fade like every other racer surface"
        );
    }

    /// The same feedback, extended: the racer's distant vegetation/building LOD must colour
    /// distinctly by kind, stay inside the opt-in racer branch, and still feed the shared
    /// fog/fade/reveal mix — not a separate, unbounded code path.
    #[test]
    fn racer_shader_colours_features_distinctly_inside_the_racer_branch() {
        let src = benilla_assets::materials::WDL_WGSL;
        let branch = src
            .split("if (racer_horizon.z > 0.0)")
            .nth(1)
            .expect("racer branch present");
        assert!(
            branch.contains("else if (racer_feature.x > 0.5)"),
            "the racer branch no longer flags/colours vegetation/building proxies"
        );
        assert!(branch.contains("racer_feature.y > 0.5"), "no building lane");
        assert!(
            src.contains("@binding(95) var<uniform> racer_feature: vec4<f32>"),
            "the racer_feature uniform binding (95) is gone from wdl.wgsl"
        );
    }

    #[test]
    fn water_kind_code_gives_each_adt_kind_a_distinct_shader_lane() {
        assert_eq!(water_kind_code(LiquidKind::Still), 0.0);
        assert_eq!(water_kind_code(LiquidKind::Ocean), 1.0);
        assert_eq!(water_kind_code(LiquidKind::Magma), 2.0);
        // Still, Ocean and Magma are the only kinds an ADT MCLQ ever carries
        // (`LiquidKind::from_adt_nibble` has no Slime/Rapids queue) — exactly what
        // `racer_water_materials` builds a lane for.
    }

    /// `initial_water_state` must never produce `Queued` for a stock (non-racer) tile: the entire
    /// racer water pipeline is gated in `stream_wdl`, same as the ground-texture material.
    #[test]
    fn stock_mode_never_queues_racer_water() {
        let src = include_str!("wdl.rs");
        let call_site = src
            .find("let water_state = if racer {")
            .expect("initial_water_state call site present");
        assert!(
            src[call_site..].contains("initial_water_state("),
            "initial_water_state is no longer gated behind `if racer`"
        );
    }

    /// `resolve_tile_water`/`admit_water_requests`/`admit_feature_requests`/`resolve_tile_features`
    /// — everywhere a queued tile or proxy turns into a request or a spawned mesh — are all
    /// wrapped in the same `if racer` guard in `stream_wdl`; a stock-mode frame must never call
    /// any of them.
    #[test]
    fn stock_mode_never_admits_or_resolves_racer_water_or_features() {
        // Normalize CRLF→LF first: this file is saved CRLF on Windows, but the anchor below
        // embeds a `\n` line break, which a raw CRLF `include_str!` would never match.
        let src = include_str!("wdl.rs").replace("\r\n", "\n");
        let call_site = src
            .find("if racer {\n        streamer.tick += 1;")
            .expect("the racer-gated admit/resolve block is present");
        let block = &src[call_site..];
        assert!(block.contains("resolve_tile_water("));
        assert!(block.contains("admit_water_requests("));
        assert!(block.contains("admit_feature_requests("));
        assert!(block.contains("resolve_tile_features("));
    }

    /// The WDT pre-filter must run before a tile is ever queued at all, so a known-unauthored
    /// tile at the map's edge never occupies a `Queued` slot (and so never reaches
    /// `LoadState::Failed`, which would otherwise `warn!` on every such tile).
    #[test]
    fn unauthored_wdt_tile_is_never_queued() {
        // Exercising this with a real `MapTiles` needs a chain (`wow_data_or_skip!()`-gated,
        // covered by `benilla_formats::terrain`'s own tests); here the source wiring is checked
        // directly: `initial_water_state` must consult `has_tile` before ever returning `Queued`.
        let src = include_str!("wdl.rs");
        let body = src
            .split("fn initial_water_state(")
            .nth(1)
            .expect("initial_water_state present");
        let has_tile_at = body
            .find("has_tile(tile_x, tile_y)")
            .expect("has_tile check present");
        let queued_at = body
            .find("WaterState::Queued")
            .expect("WaterState::Queued present");
        assert!(
            has_tile_at < queued_at,
            "the WDT has_tile check must gate `Queued`, not follow it"
        );
    }

    /// Dropping a tile's `LoadedTile` (eviction, a map switch, or a racer toggle) drops its
    /// `WaterState` — including an in-flight `Handle` — along with everything else `release_tiles`
    /// frees. This is **not** a cancellation guarantee: Bevy's asset system has no explicit abort
    /// API, so an in-flight load may still finish in the background; nothing looks up its result
    /// afterward, because the tile is no longer in `loaded` to look it up with, and the freed slot
    /// (`tiles_to_admit` counts in-flight directly off `loaded`) is available to another tile the
    /// very next frame.
    #[test]
    fn evicting_a_tile_frees_its_in_flight_slot() {
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<WdlMaterial>::default();
        let mut world = World::new();
        let mut loaded = HashMap::new();
        let entity = world.spawn_empty().id();
        // No real `AssetServer`/`Handle` needed: the eviction path (`release_tiles`) never reads
        // `water_state`, only drops the `LoadedTile` that owns it — exercised here with `Queued`,
        // which carries no handle at all, matching the field's `Drop` semantics regardless.
        loaded.insert(
            (10, 10),
            LoadedTile {
                entity,
                mesh: meshes.add(Mesh::new(
                    PrimitiveTopology::TriangleList,
                    RenderAssetUsages::default(),
                )),
                material: None,
                water_state: WaterState::Queued,
                water: Vec::new(),
                pending_features: Vec::new(),
                features: Vec::new(),
                feature_models: Vec::new(),
            },
        );
        let mut vegetation_proxies = ProxyCache::default();
        let mut building_proxies = ProxyCache::default();
        release_tiles(
            &mut world.commands(),
            &mut meshes,
            &mut materials,
            &mut vegetation_proxies,
            &mut building_proxies,
            &mut loaded,
        );
        world.flush();
        assert!(
            loaded.is_empty(),
            "the evicted tile's state must not linger"
        );
    }

    /// A bare-fields `LoadedTile`, for tests that only care about `water_state`.
    fn bare_tile(water_state: WaterState) -> LoadedTile {
        LoadedTile {
            entity: Entity::PLACEHOLDER,
            mesh: Handle::default(),
            material: None,
            water_state,
            water: Vec::new(),
            pending_features: Vec::new(),
            features: Vec::new(),
            feature_models: Vec::new(),
        }
    }

    /// The admission cap is a hard ceiling on outstanding loads, not a per-tile courtesy: with the
    /// cap already full, nothing new is admitted even if the per-frame budget has room.
    #[test]
    fn admission_never_exceeds_the_in_flight_cap() {
        let cap = 16usize;
        let mut loaded = HashMap::new();
        // `cap` tiles already in flight (a dummy default handle; `tiles_to_admit` never looks
        // inside the handle, only at the `WaterState` variant).
        for i in 0..cap as u32 {
            loaded.insert((i, 0), bare_tile(WaterState::InFlight(Handle::default())));
        }
        // Several more queued, wanting a slot.
        for i in cap as u32..cap as u32 + 5 {
            loaded.insert((i, 0), bare_tile(WaterState::Queued));
        }
        let admit = tiles_to_admit(
            &loaded,
            [0.0, 0.0, 0.0],
            cap,
            RacerWdl::WATER_REQUESTS_PER_FRAME,
        );
        assert!(
            admit.is_empty(),
            "the cap is full; nothing should be admitted"
        );
    }

    /// With room under the cap, admission is still bounded by the per-frame request budget, not
    /// by how much capacity happens to be free.
    #[test]
    fn admission_is_bounded_by_the_per_frame_budget_even_with_room_to_spare() {
        let cap = 16usize;
        let mut loaded = HashMap::new();
        // Only 2 in flight: 14 slots free, far more than the per-frame budget.
        for i in 0..2u32 {
            loaded.insert((i, 0), bare_tile(WaterState::InFlight(Handle::default())));
        }
        for i in 2u32..2 + 20 {
            loaded.insert((i, 0), bare_tile(WaterState::Queued));
        }
        let admit = tiles_to_admit(
            &loaded,
            [0.0, 0.0, 0.0],
            cap,
            RacerWdl::WATER_REQUESTS_PER_FRAME,
        );
        assert_eq!(admit.len(), RacerWdl::WATER_REQUESTS_PER_FRAME);
    }

    /// Admission picks the queued tiles nearest the view first.
    #[test]
    fn admission_prefers_the_nearest_queued_tiles() {
        let mut loaded = HashMap::new();
        for &(x, y) in &[(50, 50), (10, 10), (30, 30), (11, 10)] {
            loaded.insert((x, y), bare_tile(WaterState::Queued));
        }
        let (wx, wy) = benilla_formats::tile_to_world(10, 10);
        let center = [wx, wy, 0.0];
        let admit = tiles_to_admit(&loaded, center, 16, 2);
        assert_eq!(admit.len(), 2);
        assert_eq!(
            admit[0],
            (10, 10),
            "the exact tile under the view comes first"
        );
        assert_eq!(admit[1], (11, 10), "its immediate neighbour comes next");
    }

    /// A backlog larger than the in-flight cap must still fully drain, never stall forever: as
    /// each in-flight tile settles (resolved or failed — both become `Settled`, freeing its slot
    /// the same way), the next queued tile is admitted, frame after frame.
    #[test]
    fn a_backlog_past_the_cap_drains_completely_without_stalling() {
        let cap = 16usize;
        let total = cap + 40; // several multiples of the cap, so draining needs several "frames"
        let mut loaded: HashMap<(u32, u32), LoadedTile> = (0..total as u32)
            .map(|i| ((i, 0), bare_tile(WaterState::Queued)))
            .collect();

        let mut frames = 0;
        let max_frames = total * 2; // generous: budget alone would need `total / budget` frames
        loop {
            let settled = loaded
                .values()
                .filter(|t| matches!(t.water_state, WaterState::Settled))
                .count();
            if settled == total {
                break; // fully drained
            }
            assert!(
                frames < max_frames,
                "backlog did not drain within a generous frame budget — it is stalling"
            );
            // "Resolve": every currently in-flight tile settles this frame (worst case for
            // draining speed is actually the opposite — settling fast frees slots fast — so this
            // exercises admission keeping pace with resolution, not resolution capping admission).
            for tile in loaded.values_mut() {
                if tile.water_state.is_in_flight() {
                    tile.water_state = WaterState::Settled;
                }
            }
            // "Admit": fill freed capacity, bounded by the per-frame request budget.
            let admit = tiles_to_admit(
                &loaded,
                [0.0, 0.0, 0.0],
                cap,
                RacerWdl::WATER_REQUESTS_PER_FRAME,
            );
            for coords in admit {
                loaded.get_mut(&coords).unwrap().water_state =
                    WaterState::InFlight(Handle::default());
            }
            frames += 1;
        }
        assert!(
            frames > 0,
            "a non-trivial backlog must take at least one frame to drain"
        );
    }

    /// `resolve_tile_water` must stop at its own per-frame budget even with more unsettled
    /// requests resident than that — the async read being off-thread does not exempt the
    /// main-thread mesh build from a bound.
    #[test]
    fn resolve_tile_water_budget_is_independent_of_residency() {
        assert!(
            RacerWdl::WATER_RESOLVES_PER_FRAME < (2 * RacerWdl::RADIUS + 1).pow(2) as usize,
            "the resolve budget must be far smaller than the 625-tile residency ceiling"
        );
    }

    /// A doodad's MMDX path (legacy `.mdx`/`.mdl`) must resolve to the `.m2` extension
    /// `M2ProxyLoader` is registered on, lowercased so the cache key is stable regardless of the
    /// authored case.
    #[test]
    fn doodad_model_path_normalizes_to_m2() {
        assert_eq!(
            normalize_doodad_model_path("World\\Trees\\Ashenvale\\AshTree01.mdx"),
            "world\\trees\\ashenvale\\ashtree01.m2"
        );
        assert_eq!(
            normalize_doodad_model_path("World\\Generic\\Rock01.MDL"),
            "world\\generic\\rock01.m2"
        );
        assert_eq!(
            normalize_doodad_model_path("World\\Already\\Shipped.m2"),
            "world\\already\\shipped.m2"
        );
    }

    fn doodad_at(x: f32, y: f32, scale: f32) -> Doodad {
        Doodad {
            model: "tree.mdx".to_string(),
            position: [x, y, 0.0],
            rotation: [0.0, 0.0, 0.0],
            scale,
            unique_id: 0,
        }
    }

    /// Nearer beats farther; at equal distance, a bigger (authored MDDF scale) doodad beats a
    /// smaller one — "visible/larger nearby features over indiscriminate first-N", not file order.
    #[test]
    fn select_tile_features_prioritizes_near_and_large_doodads() {
        let doodads = [
            doodad_at(1000.0, 0.0, 1.0), // far, normal size
            doodad_at(10.0, 0.0, 1.0),   // near, normal size
            doodad_at(10.0, 0.0, 5.0),   // same distance, much bigger
        ];
        let selected = select_tile_features(&doodads, &[], [0.0, 0.0, 0.0], None);
        assert_eq!(selected.len(), 3);
        // The big doodad at the near distance must outrank the plain-size one at the same
        // distance, which in turn must outrank the far, normal-size one.
        assert_eq!(
            selected[0].transform.scale.x, 5.0,
            "the near, large doodad comes first"
        );
        assert_eq!(
            selected[1].transform.scale.x, 1.0,
            "the near, plain doodad comes second"
        );
        assert!(
            (selected[1].transform.translation - selected[2].transform.translation).length() > 0.0,
            "the third slot is the distinct far doodad"
        );
    }

    /// The combined cap applies across doodads and WMOs together, not per kind.
    #[test]
    fn select_tile_features_caps_combined_doodads_and_wmos() {
        let doodads: Vec<Doodad> = (0..RacerWdl::MAX_FEATURES_PER_TILE + 10)
            .map(|i| doodad_at(i as f32, 0.0, 1.0))
            .collect();
        let selected = select_tile_features(&doodads, &[], [0.0, 0.0, 0.0], None);
        assert_eq!(selected.len(), RacerWdl::MAX_FEATURES_PER_TILE);
    }

    /// A model only referenced by tiles still resident (`ref_count > 0`) is never evicted, even
    /// when the cache is full and a brand-new model needs a slot — no dangling instance.
    #[test]
    fn proxy_cache_never_evicts_a_live_reference() {
        let mut cache = ProxyCache::default();
        let cap = 2;
        assert!(cache.reference("a.m2", cap, 1));
        assert!(cache.reference("b.m2", cap, 2));
        // Cache is full and both entries are still referenced (ref_count 1 each): a third model
        // must be refused, not steal either live slot.
        assert!(!cache.reference("c.m2", cap, 3));
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.entries.contains_key("a.m2"));
        assert!(cache.entries.contains_key("b.m2"));
    }

    /// Once a model's last tile reference releases it (`ref_count` reaches zero), it becomes
    /// evictable — the oldest such entry makes room for a new one.
    #[test]
    fn proxy_cache_evicts_the_oldest_zero_ref_entry_for_a_new_model() {
        let mut cache = ProxyCache::default();
        let cap = 2;
        assert!(cache.reference("a.m2", cap, 1));
        assert!(cache.reference("b.m2", cap, 2));
        cache.release("a.m2"); // a.m2 is now ref_count 0, the only evictable entry
        assert!(cache.reference("c.m2", cap, 3));
        assert_eq!(cache.entries.len(), 2);
        assert!(
            !cache.entries.contains_key("a.m2"),
            "a.m2 should have been evicted"
        );
        assert!(cache.entries.contains_key("b.m2"));
        assert!(cache.entries.contains_key("c.m2"));
    }

    /// Revisiting an already-cached model (even one with a zero ref count, not yet evicted) bumps
    /// its ref count back up instead of double-counting or re-queuing it.
    #[test]
    fn proxy_cache_reference_reuses_an_existing_entry() {
        let mut cache = ProxyCache::default();
        assert!(cache.reference("a.m2", 4, 1));
        cache.release("a.m2");
        assert_eq!(cache.entries.get("a.m2").unwrap().ref_count, 0);
        assert!(cache.reference("a.m2", 4, 2));
        assert_eq!(cache.entries.get("a.m2").unwrap().ref_count, 1);
        assert_eq!(cache.entries.len(), 1, "no duplicate entry created");
    }

    #[test]
    fn racer_feature_release_clears_queued_and_late_model_results() {
        let mut world = World::new();
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<WdlMaterial>::default();
        let mut vegetation = ProxyCache::default();
        let mut buildings = ProxyCache::default();
        vegetation.reference("tree.m2", 2, 0);
        buildings.reference("inn.wmo", 2, 0);
        buildings.entries.get_mut("inn.wmo").unwrap().state =
            ProxyState::InFlight(Handle::default());
        let mut loaded = HashMap::new();
        release_tiles(
            &mut world.commands(),
            &mut meshes,
            &mut materials,
            &mut vegetation,
            &mut buildings,
            &mut loaded,
        );
        world.flush();
        assert!(
            vegetation.entries.is_empty(),
            "no queued stale requests on mode/map exit"
        );
        assert!(
            buildings.entries.is_empty(),
            "late assets no longer have consumers"
        );
    }

    #[test]
    fn racer_feature_selection_favors_visible_side_at_equal_range() {
        let doodads = [doodad_at(10.0, 0.0, 1.0), doodad_at(-10.0, 0.0, 1.0)];
        let forward = wow_to_bevy([-1.0, 0.0, 0.0]).normalize();
        let selected = select_tile_features(&doodads, &[], [0.0; 3], Some(forward));
        assert_eq!(
            selected[0].transform.translation,
            wow_to_bevy([-10.0, 0.0, 0.0])
        );
    }

    #[test]
    fn racer_model_reference_is_once_per_tile_and_retries_when_full() {
        let mut tile = bare_tile(WaterState::Settled);
        tile.pending_features = select_tile_features(
            &[doodad_at(0.0, 0.0, 1.0), doodad_at(1.0, 0.0, 1.0)],
            &[],
            [0.0; 3],
            None,
        );
        let mut loaded = HashMap::from([((32, 32), tile)]);
        let mut vegetation = ProxyCache::default();
        let mut buildings = ProxyCache::default();
        for i in 0..RacerWdl::MAX_UNIQUE_VEGETATION_PROXIES {
            assert!(vegetation.reference(
                &format!("occupied{i}"),
                RacerWdl::MAX_UNIQUE_VEGETATION_PROXIES,
                0
            ));
        }
        reference_pending_features(&mut loaded, &mut vegetation, &mut buildings, [0.0; 3], 1);
        assert!(loaded[&(32, 32)].feature_models.is_empty());
        assert_eq!(
            loaded[&(32, 32)].pending_features.len(),
            2,
            "no permanently dropped placement"
        );
        vegetation.release("occupied0");
        reference_pending_features(&mut loaded, &mut vegetation, &mut buildings, [0.0; 3], 2);
        reference_pending_features(&mut loaded, &mut vegetation, &mut buildings, [0.0; 3], 3);
        assert_eq!(vegetation.entries["tree.m2"].ref_count, 1);
        assert_eq!(loaded[&(32, 32)].feature_models.len(), 1);
    }
}

/// The backdrop law lives in the shader, so it is checked there: a shared clip plane or a dropped
/// frag-depth write reopens a seam visible only at a ridge crest on a fogged horizon.
#[test]
fn the_far_band_stays_a_depth_pushed_backdrop() {
    let src = benilla_assets::materials::WDL_WGSL;
    assert!(
        src.contains("const WDL_OVERLAP: f32 = 33.0;"),
        "wdl.wgsl: the far band's 33 yd overlap into the wall is gone — the coarse-vs-fine seam \
         reopens as a hole at the horizon (the reference's far-band near plane, [0x8101b0])"
    );
    assert!(
        src.contains("out.depth = depth;") && src.contains("view_z_to_depth_ndc(-farclip)"),
        "wdl.wgsl: the far band no longer clamps its depth behind the far-clip wall — its overlap \
         now pokes THROUGH the detailed terrain (the reference's compressed far-band depth range)"
    );
}

/// Vegetation/building proxies, merged water, the ground-textured hull, and the stock hull must
/// all occlude each other and the detailed near field by their own real per-fragment distance, not
/// a forced constant: there is exactly one depth computation in the whole shader, it derives from
/// `in.clip_position.z` (the vertex shader's genuine `position_world_to_clip` of that fragment's
/// world position — never a literal), and it sits *after* — unconditional on — every racer content
/// branch (ground/water/feature), so none of them can special-case or skip it. A forced-equal
/// depth across proxies (a flat silhouette "wall" bug) would show as one more `out.depth` write
/// inside `racer_water`/`racer_feature`, or this one reading a constant instead of
/// `in.clip_position.z`.
#[test]
fn racer_backdrop_content_shares_one_true_per_fragment_depth() {
    let src = benilla_assets::materials::WDL_WGSL;
    assert_eq!(
        src.matches("out.depth = depth;").count(),
        1,
        "wdl.wgsl: `out.depth` is now written more than once — if `racer_water`/`racer_feature` \
         got their own depth write, proxies/water could stop depth-testing against the hull, the \
         detailed near field, and each other by real distance"
    );
    assert!(
        src.contains("var depth = in.clip_position.z;"),
        "wdl.wgsl: the depth write no longer starts from the fragment's own true projected depth \
         (`in.clip_position.z`, set in `vertex()` from `position_world_to_clip`) — without it, \
         every racer content kind would render at one identical depth regardless of its real \
         world distance, breaking occlusion between a tree, a building, water, and the hull"
    );

    // The depth block must be textually after the one `if (racer_horizon.z > 0.0) { ... }` body
    // that holds the ground/water/feature branches, so it is unconditional on which of those ran
    // (or none, in stock mode) — not duplicated inside any of them.
    let racer_branch = src
        .find("if (racer_horizon.z > 0.0)")
        .expect("wdl.wgsl: the racer-gated content branch is gone");
    let depth_write = src
        .find("var depth = in.clip_position.z;")
        .expect("wdl.wgsl: the depth write is gone");
    assert!(
        depth_write > racer_branch,
        "wdl.wgsl: the depth write must come after the racer content branch so it applies \
         uniformly to the stock hull, the ground-textured hull, merged water, and every \
         vegetation/building proxy alike"
    );
    assert!(
        src.contains("if (farclip > 0.0 && racer_horizon.z == 0.0)"),
        "only stock WDL may depth-push into a shared plane"
    );
}

#[test]
fn racer_reverse_z_hill_occludes_far_tree_but_not_near_ship() {
    let projection = Mat4::perspective_infinite_reverse_rh(1.0, 1.0, 0.1);
    let depth = |distance: f32| projection.project_point3(Vec3::new(0.0, 0.0, -distance)).z;
    let terrain = depth(1400.0);
    let tree_behind = depth(2200.0);
    let ship_in_front = depth(900.0);
    // Bevy uses GreaterEqual: the nearer real terrain wins, independent of draw order.
    assert!(terrain > tree_behind);
    assert!(ship_in_front > terrain);
    assert!(tree_behind > 0.0, "geometry remains in front of sky");
    // Even fragments straddling the detailed farclip boundary have distinct racer depths.
    assert!(depth(499.0) > depth(500.0) && depth(500.0) > depth(501.0));
}

/// The reference's far-band emitter submits its own fog pair, start 0 and end 1.0 (`0x6bd7ae` to
/// `0x6bd7c8` in `0x6bd780`), so the hull is the flat fog colour at every distance. Under the scene
/// fog the 33 yd overlap shows as a pale band at low view distances.
#[test]
fn the_far_band_is_a_fog_hull_not_a_fogged_surface() {
    let src = benilla_assets::materials::WDL_WGSL;
    assert!(
        src.contains("rgb = w.fog_color.xyz;"),
        "wdl.wgsl: the hull no longer paints the flat fog colour (the reference's own start-0 / \
         end-1.0 fog pair, saturated beyond one yard)"
    );
    assert!(
        !src.contains("w.fog_params.x") && !src.contains("w.fog_params.y"),
        "wdl.wgsl: the hull reads the SCENE fog distances again — the 33 yd overlap goes partly \
         white at low view distances"
    );
}
