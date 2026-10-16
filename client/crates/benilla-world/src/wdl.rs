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

use crate::view::WorldCamera;
use crate::world_map::CurrentMap;
use benilla_assets::LockRecover;
use benilla_assets::MapCatalogRes;
use benilla_assets::coords::{bevy_to_wow, wow_to_bevy};
use benilla_assets::materials::{WdlExt, WdlMaterial};
use benilla_assets::{AssetSet, RenderConfig, WorldAssets};
use benilla_formats::WdlFile;

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
    material: Handle<WdlMaterial>,
    loaded: HashMap<(u32, u32), (Entity, Handle<Mesh>)>,
    map_available: bool,
    racer: bool,
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
        },
    });
    commands.insert_resource(WdlStreamer {
        wdl,
        map_id: 0,
        material,
        loaded: HashMap::new(),
        map_available: true,
        racer: false,
    });
}

fn stream_wdl(
    mut commands: Commands,
    streamer: Option<ResMut<WdlStreamer>>,
    assets: Option<ResMut<WorldAssets>>,
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
    // All four are absent without client data. `Option`, not `Res`: a missing `Res` fails
    // validation, which panics the client, and a build run from the wrong folder gets here.
    let (Some(mut streamer), Some(assets), Some(current_map), Some(map_catalog)) =
        (streamer, assets, current_map, map_catalog)
    else {
        return;
    };
    // The focus's map: the picked character's during world entry, so the ring is never built for
    // the map being left.
    let map_id = focus.map(Some(current_map.0));
    telemetry.set_resident(streamer.loaded.len());
    let racer = racer.is_some();
    if racer != streamer.racer {
        if let Some(material) = materials.get_mut(&streamer.material) {
            material.extension.racer_horizon = if racer {
                RacerWdl::shader_params()
            } else {
                Vec4::ZERO
            };
        }
        for (entity, _) in streamer.loaded.values() {
            if racer {
                commands.entity(*entity).insert(NoFrustumCulling);
            } else {
                commands.entity(*entity).remove::<NoFrustumCulling>();
            }
        }
        streamer.racer = racer;
    }

    // Cross-map teleport: reload the new map's `.wdl` and drop the old ring.
    if map_id != streamer.map_id {
        telemetry.evicted_this_frame = streamer.loaded.len();
        release_tiles(&mut commands, &mut meshes, &mut streamer.loaded);
        telemetry.set_resident(0);
        streamer.map_available = false;
        streamer.map_id = map_id;
        if let Some(dir) = map_catalog.0.directory(map_id) {
            match WdlFile::load(&mut assets.chain.lock_recover(), dir) {
                Ok(wdl) => {
                    streamer.wdl = wdl;
                    streamer.map_available = true;
                }
                Err(e) => warn!("WDL unavailable for map {map_id} ({dir}): {e:#}"),
            }
        } else {
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
        if let Some((e, mesh)) = streamer.loaded.remove(&coords) {
            telemetry.evicted_this_frame += 1;
            commands.entity(e).despawn();
            meshes.remove(mesh.id());
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
        // A constant normal and zero UV satisfy the `StandardMaterial` pipeline; the shader reads
        // neither.
        let n = positions.len();
        let mut mesh = Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        );
        mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, positions);
        mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 1.0, 0.0]; n]);
        mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; n]);
        mesh.insert_indices(Indices::U32(tile.indices));
        let mesh = meshes.add(mesh);
        let mut entity = commands.spawn((
            Mesh3d(mesh.clone()),
            MeshMaterial3d(streamer.material.clone()),
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
        streamer.loaded.insert(coords, (e, mesh));
        telemetry.built_this_frame += 1;
    }
    telemetry.set_resident(streamer.loaded.len());
}

/// Leaving the world drops the ring; the parsed `.wdl` stays for `height_under`.
fn release_wdl_ring(
    mut commands: Commands,
    streamer: Option<ResMut<WdlStreamer>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut telemetry: ResMut<WdlTelemetry>,
) {
    *telemetry = WdlTelemetry::default();
    let Some(mut streamer) = streamer else { return };
    telemetry.evicted_this_frame = streamer.loaded.len();
    release_tiles(&mut commands, &mut meshes, &mut streamer.loaded);
}

fn release_tiles(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    loaded: &mut HashMap<(u32, u32), (Entity, Handle<Mesh>)>,
) {
    for (_, (entity, mesh)) in loaded.drain() {
        commands.entity(entity).despawn();
        meshes.remove(mesh.id());
    }
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
    loaded: &HashMap<(u32, u32), (Entity, Handle<Mesh>)>,
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
        let loaded = HashMap::from([((32, 32), (Entity::PLACEHOLDER, Handle::default()))]);
        let missing = missing_tiles(desired, &loaded, RacerWdl::LOADS_PER_FRAME);
        assert_eq!(missing.len(), 4);
        assert!(
            missing
                .iter()
                .all(|&(x, y)| x.abs_diff(32) + y.abs_diff(32) == 1)
        );
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
        let mut world = World::new();
        let mut loaded = HashMap::new();
        for _ in 0..1000 {
            let handle = meshes.add(Mesh::new(
                PrimitiveTopology::TriangleList,
                RenderAssetUsages::default(),
            ));
            let entity = world.spawn_empty().id();
            loaded.insert((32, 32), (entity, handle));
            assert_eq!(meshes.len(), 1);
            release_tiles(&mut world.commands(), &mut meshes, &mut loaded);
            world.flush();
            assert!(meshes.is_empty());
            assert!(loaded.is_empty());
            assert!(world.get_entity(entity).is_err());
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
