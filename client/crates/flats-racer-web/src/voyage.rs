//! Translation-only regions keep authored WoW geometry separate from global and local physics.
use crate::horizon::Horizon;
use benilla_formats::{
    adt_to_tile_mesh, adt_to_tile_mesh_observed, triangle_z_at, LiquidKind, TerrainBuildPhase,
    TileMesh, TileMeshBuilder,
};
use flats_racer_physics::{Input, State, Tuning, FIXED_DT, PROBE_OFFSETS};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

pub const TILE: f64 = 1600.0 / 3.0;
pub const MAX_RESIDENT: usize = 8;
const SUPPORT_TRAVEL: f64 = 0.5;
const HULL_HALF_HEIGHT: f64 = 0.5;
const SUPPORT_RISE: f32 = 0.6;
pub(crate) const FLOOR_CLEARANCE: f32 = 0.25;
const MAX_SUPPORT_SUBSTEPS: u32 = 64;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn admission_now() -> f64;
}

#[cfg(not(target_arch = "wasm32"))]
fn admission_now() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Region {
    pub id: String,
    pub map: String,
    pub tile_origin: [u32; 2],
    pub tile_count: [u32; 2],
    /// Global east/south position of the region's northwest source tile corner.
    pub placement: [f64; 2],
}

impl Region {
    pub fn bounds(&self) -> [f64; 4] {
        [
            self.placement[0],
            self.placement[1],
            self.placement[0] + f64::from(self.tile_count[0]) * TILE,
            self.placement[1] + f64::from(self.tile_count[1]) * TILE,
        ]
    }

    pub fn source(&self, global: [f64; 2]) -> [f32; 3] {
        [
            -(global[1] - self.placement[1] + (f64::from(self.tile_origin[1]) - 32.0) * TILE)
                as f32,
            -(global[0] - self.placement[0] + (f64::from(self.tile_origin[0]) - 32.0) * TILE)
                as f32,
            0.0,
        ]
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TileEntry {
    pub region: usize,
    pub x: u32,
    pub y: u32,
    pub file: String,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HorizonEntry {
    pub region: usize,
    pub file: String,
    pub bytes: usize,
    pub sha256: String,
    /// Inclusive minimum, exclusive maximum authored WDL tile coordinates.
    pub source_bounds: [u32; 4],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub label: String,
    pub regions: Vec<Region>,
    pub tiles: Vec<TileEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub horizons: Vec<HorizonEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub world_bounds: Option<[[u32; 4]; 2]>,
    /// Explicit connecting ocean only, never a fallback for missing continent data.
    pub ocean: [f64; 4],
    pub sea_level: f32,
    pub spawn: [f64; 4],
    pub destination: [f64; 2],
}

fn contains(b: [f64; 4], p: [f64; 2]) -> bool {
    p[0] >= b[0] && p[0] < b[2] && p[1] >= b[1] && p[1] < b[3]
}

impl Manifest {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(bounds) = self.world_bounds {
            if bounds
                .iter()
                .any(|b| b.iter().any(|&n| n > 64) || b[0] >= b[2] || b[1] >= b[3])
                || self.horizons.iter().enumerate().any(|(i, h)| {
                    i >= 2
                        || h.source_bounds[0] < bounds[i][0]
                        || h.source_bounds[1] < bounds[i][1]
                        || h.source_bounds[2] > bounds[i][2]
                        || h.source_bounds[3] > bounds[i][3]
                })
            {
                return Err("Invalid combined authored world bounds".into());
            }
        }
        if !matches!(self.version, 1..=3)
            || (self.version == 1 && !self.horizons.is_empty())
            || (self.version >= 2 && self.horizons.len() != 2)
            || (self.version == 3 && self.world_bounds.is_none())
            || self.regions.len() != 2
            || self.tiles.is_empty()
            || self.tiles.len() > if self.version == 3 { 8192 } else { 16 }
            || self.label.len() > 120
            || self.spawn[1].abs() > 10_000.0
            || !self.sea_level.is_finite()
            || self.sea_level.abs() > 10_000.0
            || self
                .ocean
                .iter()
                .chain(self.spawn.iter())
                .chain(self.destination.iter())
                .any(|v| !v.is_finite() || v.abs() > 1.0e12)
        {
            return Err("Unsupported or non-finite route manifest".into());
        }
        for (i, r) in self.regions.iter().enumerate() {
            if r.id.is_empty()
                || r.id.len() > 64
                || !matches!(r.map.as_str(), "Kalimdor" | "Azeroth")
                || r.tile_count.contains(&0)
                || r.tile_count
                    .iter()
                    .any(|&n| n > if self.version == 3 { 64 } else { 4 })
                || r.tile_origin
                    .iter()
                    .zip(r.tile_count)
                    .any(|(&a, n)| a >= 64 || a + n > 64)
                || r.placement
                    .iter()
                    .any(|v| !v.is_finite() || v.abs() > 1.0e12)
            {
                return Err("Invalid region dimensions or placement".into());
            }
            if self.version < 3 {
                for y in r.tile_origin[1]..r.tile_origin[1] + r.tile_count[1] {
                    for x in r.tile_origin[0]..r.tile_origin[0] + r.tile_count[0] {
                        if self
                            .tiles
                            .iter()
                            .filter(|t| t.region == i && t.x == x && t.y == y)
                            .count()
                            != 1
                        {
                            return Err("Every corridor tile must be listed exactly once".into());
                        }
                    }
                }
            }
        }
        let a = self.regions[0].bounds();
        let b = self.regions[1].bounds();
        let expected = if self.version == 1 {
            [a[2], a[1], b[0], a[3]]
        } else {
            let bounds = |i: usize| {
                let r = &self.regions[i];
                let source_bounds = self
                    .world_bounds
                    .map_or(self.horizons[i].source_bounds, |b| b[i]);
                [
                    r.placement[0]
                        + (f64::from(source_bounds[0]) - f64::from(r.tile_origin[0])) * TILE,
                    r.placement[1]
                        + (f64::from(source_bounds[1]) - f64::from(r.tile_origin[1])) * TILE,
                    r.placement[0]
                        + (f64::from(source_bounds[2]) - f64::from(r.tile_origin[0])) * TILE,
                    r.placement[1]
                        + (f64::from(source_bounds[3]) - f64::from(r.tile_origin[1])) * TILE,
                ]
            };
            let (west, east) = (bounds(0), bounds(1));
            if west[2] >= east[0] {
                return Err("Full authored continent bounds overlap".into());
            }
            [west[2], west[1].min(east[1]), east[0], west[3].max(east[3])]
        };
        if self.regions[0].id == self.regions[1].id
            || (self.version < 3
                && (a[2] >= b[0] || (a[1] - b[1]).abs() > 0.001 || (a[3] - b[3]).abs() > 0.001))
            || self
                .ocean
                .iter()
                .zip(expected)
                .any(|(v, e)| (v - e).abs() > 0.001)
            || !contains(a, [self.spawn[0], self.spawn[2]])
            || !contains(b, self.destination)
        {
            return Err("Regions must bracket one explicit ocean and valid coast endpoints".into());
        }
        let mut total = 0usize;
        let mut names = std::collections::HashSet::new();
        for (index, h) in self.horizons.iter().enumerate() {
            let r = self.regions.get(h.region).ok_or("Unknown horizon region")?;
            if h.region != index
                || h.file != format!("{}.wdl", r.map)
                || !names.insert(&h.file)
                || h.bytes == 0
                || h.bytes > 5 * 1024 * 1024
                || h.sha256.len() != 64
                || !h.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || h.source_bounds.iter().any(|&n| n > 64)
                || h.source_bounds[0] >= h.source_bounds[2]
                || h.source_bounds[1] >= h.source_bounds[3]
            {
                return Err("Invalid WDL horizon descriptor".into());
            }
            total += h.bytes;
        }
        for t in &self.tiles {
            let r = self.regions.get(t.region).ok_or("Unknown tile region")?;
            let expected = format!("{}_{}_{}.adt", r.map, t.x, t.y);
            if t.file != expected
                || !names.insert(&t.file)
                || (self.version < 3 && t.bytes == 0)
                || t.bytes > 16 * 1024 * 1024
                || (self.version < 3 && t.sha256.len() != 64)
                || !t.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || t.x < r.tile_origin[0]
                || t.x >= r.tile_origin[0] + r.tile_count[0]
                || t.y < r.tile_origin[1]
                || t.y >= r.tile_origin[1] + r.tile_count[1]
            {
                return Err("Invalid route tile descriptor".into());
            }
            total += t.bytes;
        }
        if total > 128 * 1024 * 1024 {
            return Err("Route pack exceeds 128 MiB".into());
        }
        Ok(())
    }

    pub fn tile_placement(&self, index: usize) -> [f64; 2] {
        let t = &self.tiles[index];
        let r = &self.regions[t.region];
        [
            r.placement[0] + f64::from(t.x - r.tile_origin[0]) * TILE,
            r.placement[1] + f64::from(t.y - r.tile_origin[1]) * TILE,
        ]
    }
}

/// Detailed terrain/water plus authored WMO/M2 collision surfaces.
#[derive(Clone, Copy, Debug)]
pub struct Surface {
    pub ground: Option<f32>,
    pub water: Option<f32>,
    pub solid: bool,
    /// 0 = ready, 1 = unloaded, 2 = outside pack/unsupported hole.
    pub availability: u8,
    pub region: i32,
}

impl Surface {
    fn support(self) -> Option<f32> {
        if self.availability != 0 || self.solid {
            return None;
        }
        match (self.ground, self.water) {
            (Some(g), Some(w)) => Some(g.max(w)),
            (g, w) => g.or(w),
        }
    }
    fn on_water(self) -> bool {
        self.water
            .is_some_and(|w| self.ground.is_none_or(|g| w >= g))
    }
}

#[wasm_bindgen]
pub struct Voyage {
    pub(crate) manifest: Manifest,
    pub(crate) resident: HashMap<usize, TileMesh>,
    pub(crate) horizons: HashMap<usize, Horizon>,
    pub(crate) grid: Vec<Option<usize>>,
    pub(crate) exterior: Vec<bool>,
    scene_bounds: Vec<[f64; 6]>,
    scene_mesh: CollisionTree,
    scene_parts: HashMap<u32, CollisionTree>,
    state: State,
    pub(crate) tuning: Tuning,
    origin: [f64; 2],
    rebases: u32,
    hold: u8,
    physics_stats: [u32; 8],
    profile_admission: bool,
    admission_times: std::cell::Cell<[f64; 9]>,
    tile_builder: Option<(usize, TileMeshBuilder)>,
    pub(crate) prepared_tile: Option<(usize, TileMesh)>,
}

impl Voyage {
    pub fn from_manifest(manifest: Manifest) -> Result<Self, String> {
        manifest.validate()?;
        let mut grid = vec![None; 8192];
        for (index, tile) in manifest.tiles.iter().enumerate() {
            let cell = tile.region * 4096 + tile.y as usize * 64 + tile.x as usize;
            if grid[cell].replace(index).is_some() {
                return Err("Duplicate world topology tile".into());
            }
        }
        let exterior = crate::world::exterior_cells(&grid);
        let mut world = Self {
            state: State::new(
                [0.0, manifest.spawn[1] as f32, 0.0],
                manifest.spawn[3] as f32,
            )
            .map_err(|e| e.to_string())?,
            tuning: Tuning {
                max_speed: 150.0,
                boost_max_speed: 300.0,
                acceleration: 50.0,
                boost_acceleration: 50.0,
                hover_height: 3.0,
                air_control: 0.9,
                ..Tuning::default()
            },
            origin: [manifest.spawn[0], manifest.spawn[2]],
            manifest,
            resident: HashMap::new(),
            horizons: HashMap::new(),
            grid,
            exterior,
            scene_bounds: vec![],
            scene_mesh: CollisionTree::default(),
            scene_parts: HashMap::new(),
            rebases: 0,
            hold: 1,
            physics_stats: [0; 8],
            profile_admission: false,
            admission_times: std::cell::Cell::new([0.0; 9]),
            tile_builder: None,
            prepared_tile: None,
        };
        world.rebase();
        Ok(world)
    }

    fn check_tile_input(&self, index: usize, size: usize) -> Result<(), String> {
        let entry = self.manifest.tiles.get(index).ok_or("Unknown tile")?;
        if (entry.bytes != 0 && size != entry.bytes)
            || size == 0
            || size > 16 * 1024 * 1024
            || (!self.resident.contains_key(&index) && self.resident.len() >= MAX_RESIDENT)
        {
            return Err("Tile size/resident limit rejected".into());
        }
        Ok(())
    }

    fn validate_tile(&self, index: usize, tile: &TileMesh) -> Result<(), String> {
        let entry = &self.manifest.tiles[index];
        let northwest = [
            -(f64::from(entry.y) - 32.0) * TILE,
            -(f64::from(entry.x) - 32.0) * TILE,
        ];
        let invalid = tile.chunks.len() != 256
            || tile.chunks.iter().any(|c| {
                c.positions.len() != 145
                    || c.indices.iter().any(|&i| i >= 145)
                    || c.liquids.iter().any(|liquid| {
                        liquid.indices.iter().any(|&i| {
                            liquid.positions.get(i as usize).is_none_or(|p| {
                                p.iter().any(|v| !v.is_finite() || v.abs() > 100_000.0)
                            })
                        })
                    })
                    || c.positions
                        .iter()
                        .flatten()
                        .any(|v| !v.is_finite() || v.abs() > 100_000.0)
                    || c.positions.iter().any(|p| {
                        (0..2).any(|i| {
                            f64::from(p[i]) > northwest[i] + 0.01
                                || f64::from(p[i]) < northwest[i] - TILE - 0.01
                        })
                    })
            });
        if invalid {
            return Err("Tile geometry does not match its source coordinates".into());
        }
        Ok(())
    }

    fn global(&self) -> [f64; 2] {
        [
            self.origin[0] + f64::from(self.state.position[0]),
            self.origin[1] + f64::from(self.state.position[2]),
        ]
    }

    fn rebase(&mut self) {
        if self.state.position[0].abs() > 256.0 || self.state.position[2].abs() > 256.0 {
            let p = self.global();
            self.origin = [p[0].round(), p[1].round()];
            self.state.position[0] = (p[0] - self.origin[0]) as f32;
            self.state.position[2] = (p[1] - self.origin[1]) as f32;
            self.rebases += 1;
        }
    }

    pub fn sample(&self, p: [f64; 2]) -> Surface {
        self.sample_at(p, self.state.position[1])
    }

    fn sample_at(&self, p: [f64; 2], body_y: f32) -> Surface {
        let mut result = Surface {
            ground: None,
            water: None,
            solid: false,
            availability: 2,
            region: -2,
        };
        if let Some(index) = self.locate(p) {
            let region = self.manifest.tiles[index].region;
            result.region = region as i32;
            let Some(tile) = self.resident.get(&index) else {
                result.availability = 1;
                return result;
            };
            let wow = self.manifest.regions[region].source(p);
            let fast = tile
                .chunks
                .first()
                .and_then(|c| c.positions.first())
                .and_then(|nw| {
                    let row = ((nw[0] - wow[0]) / (TILE as f32 / 16.0)).floor();
                    let col = ((nw[1] - wow[1]) / (TILE as f32 / 16.0)).floor();
                    if !(0.0..16.0).contains(&row) || !(0.0..16.0).contains(&col) {
                        return None;
                    }
                    tile.chunks
                        .get(row as usize * 16 + col as usize)
                        .filter(|c| c.area_at(wow).is_some())
                });
            for chunk in fast.map(std::slice::from_ref).unwrap_or(&tile.chunks) {
                if chunk.area_at(wow).is_none() {
                    continue;
                }
                result.solid |= chunk.impassable;
                result.ground = result.ground.or_else(|| chunk.height_at(wow));
                for liquid in &chunk.liquids {
                    if !matches!(liquid.kind, LiquidKind::Still | LiquidKind::Ocean) {
                        continue;
                    }
                    for tri in liquid.indices.as_chunks::<3>().0 {
                        if let Some(h) = triangle_z_at(
                            &tri.map(|i| liquid.positions[i as usize]),
                            wow[0],
                            wow[1],
                        ) {
                            result.water = Some(result.water.map_or(h, |old| old.max(h)));
                            break;
                        }
                    }
                }
            }
            result.availability = if result.ground.is_some() || result.water.is_some() {
                0
            } else {
                2
            };
        } else if contains(self.manifest.ocean, p) {
            result.water = Some(self.manifest.sea_level);
            result.availability = 0;
            result.region = -1;
        } else if self.manifest.version == 3 {
            if let Some(region) = self.exterior_ocean(p) {
                result.water = Some(self.manifest.sea_level);
                result.availability = 0;
                result.region = region as i32;
            }
        }
        if result.availability != 1 {
            if let Some(height) = self.scene_mesh.height(p, f64::from(body_y)) {
                result.ground = Some(
                    result
                        .ground
                        .map_or(height as f32, |g| g.max(height as f32)),
                );
                result.availability = 0;
            }
            for b in &self.scene_bounds {
                if p[0] >= b[0] && p[0] <= b[3] && p[1] >= b[2] && p[1] <= b[5] {
                    if f64::from(body_y) >= b[4] - 0.1 {
                        result.ground =
                            Some(result.ground.map_or(b[4] as f32, |g| g.max(b[4] as f32)));
                        result.availability = 0;
                    } else if f64::from(body_y) + 0.6 >= b[1] {
                        result.solid = true;
                    }
                }
            }
        }
        result
    }

    fn heights(&self, p: [f64; 2], yaw: f32) -> Result<[f32; 4], u8> {
        self.heights_at(p, yaw, self.state.position[1])
    }

    fn heights_at(&self, p: [f64; 2], yaw: f32, body_y: f32) -> Result<[f32; 4], u8> {
        let mut heights = [0.0; 4];
        for (height, surface) in heights.iter_mut().zip(self.surfaces_at(p, yaw, body_y)) {
            *height = surface
                .support()
                .ok_or(if surface.availability == 1 { 1 } else { 2 })?;
        }
        Ok(heights)
    }

    fn surfaces_at(&self, p: [f64; 2], yaw: f32, body_y: f32) -> [Surface; 4] {
        let (sin, cos) = yaw.sin_cos();
        PROBE_OFFSETS.map(|[x, _, z]| {
            self.sample_at(
                [
                    p[0] + f64::from(x * cos + z * sin),
                    p[1] + f64::from(-x * sin + z * cos),
                ],
                body_y,
            )
        })
    }

    fn motion_heights_at(
        &self,
        p: [f64; 2],
        yaw: f32,
        body_y: f32,
        airborne: bool,
    ) -> Result<[Option<f32>; 4], u8> {
        let mut heights = [None; 4];
        for (height, surface) in heights.iter_mut().zip(self.surfaces_at(p, yaw, body_y)) {
            *height = surface.support();
            if height.is_some() {
                continue;
            }
            if !airborne || surface.availability == 1 || surface.region < 0 {
                return Err(if surface.availability == 1 { 1 } else { 2 });
            }
            // Known holes have no floor; impassable terrain is not an infinite-height wall.
            if surface.solid {
                *height = Surface { solid: false, ..surface }.support();
                if height.is_none_or(|h| body_y - h <= self.tuning.support_reach()) {
                    return Err(2);
                }
            }
        }
        Ok(heights)
    }

    fn restore_pose(&mut self, pose: &[f64]) -> Result<(), String> {
        if pose.len() != 4 || pose.iter().any(|v| !v.is_finite()) {
            return Err("Save requires a finite global pose".into());
        }
        let state =
            State::new([0.0, pose[1] as f32, 0.0], pose[3] as f32).map_err(|e| e.to_string())?;
        let heights = self
            .heights_at([pose[0], pose[2]], state.yaw, state.position[1])
            .map_err(|_| "Saved location is unloaded or outside supported surfaces")?;
        let floor = heights.into_iter().fold(f32::NEG_INFINITY, f32::max) + 0.25;
        if state.position[1] < floor {
            return Err("Saved height is below the supported surface".into());
        }
        let point = [pose[0], f64::from(state.position[1]), pose[2]];
        if self.scene_mesh.swept(point, point)
            || self
                .scene_bounds
                .iter()
                .any(|b| swept_box(point, point, *b))
        {
            return Err("Saved vehicle overlaps authored collision".into());
        }
        self.origin = [pose[0], pose[2]];
        self.state = state;
        self.hold = 0;
        Ok(())
    }

    pub(crate) fn advance(&mut self, input: Input) -> Result<(), String> {
        if !input.throttle.is_finite() || !input.steer.is_finite() {
            return Err("Throttle and steer must be finite".into());
        }
        // Keep the terrain ledge guard distance-bounded instead of speed-dependent.
        let steps = (self.travel_bound(f64::from(FIXED_DT)) / SUPPORT_TRAVEL)
            .ceil()
            .max(1.0);
        if steps > f64::from(MAX_SUPPORT_SUBSTEPS) {
            return Err("Configured motion exceeds 64 support substeps per physics tick".into());
        }
        let steps = steps as u32;
        self.physics_stats[0] = self.physics_stats[0].saturating_add(1);
        self.physics_stats[7] = self.physics_stats[7].max(steps);
        let (state, origin, rebases, hold) = (self.state, self.origin, self.rebases, self.hold);
        for _ in 0..steps {
            self.physics_stats[1] = self.physics_stats[1].saturating_add(1);
            let result = self.advance_substep(input, FIXED_DT / steps as f32);
            if result.is_err() || self.hold != 0 {
                self.state = state;
                self.origin = origin;
                self.rebases = rebases;
                if result.is_err() {
                    self.hold = hold;
                } else {
                    self.state.velocity = [0.0; 3];
                }
                return result;
            }
        }
        Ok(())
    }

    fn travel_bound(&self, duration: f64) -> f64 {
        let speed = f64::from(self.state.velocity[0]).hypot(f64::from(self.state.velocity[2]));
        let thrust = (f64::from(self.tuning.acceleration)
            + f64::from(self.tuning.boost_acceleration))
            * f64::from(self.tuning.air_control).max(1.0);
        (speed + thrust * duration).min(f64::from(self.tuning.boost_max_speed)) * duration
    }

    fn advance_substep(&mut self, input: Input, dt: f32) -> Result<(), String> {
        let p = self.global();
        let before = self.state;
        let heights = match self.motion_heights_at(p, before.yaw, before.position[1], !before.grounded) {
            Ok(h) => h,
            Err(hold) => {
                self.physics_stats[if hold == 1 { 2 } else { 3 }] =
                    self.physics_stats[if hold == 1 { 2 } else { 3 }].saturating_add(1);
                self.hold = hold;
                self.state.velocity = [0.0; 3];
                return Ok(());
            }
        };
        let projected = [
            p[0] + f64::from(before.velocity[0] * dt),
            p[1] + f64::from(before.velocity[2] * dt),
        ];
        let rise = self
            .motion_heights_at(projected, before.yaw, before.position[1], !before.grounded)
            .map_or(0.0, |hs| {
                if hs.iter().all(Option::is_some) && heights.iter().all(Option::is_some) {
                    (hs.iter().flatten().sum::<f32>() - heights.iter().flatten().sum::<f32>()) / (4.0 * dt)
                } else {
                    0.0
                }
            })
            .min(SUPPORT_RISE / dt);
        self.state
            .step_with_surface_motion(
                input,
                heights.map(|h| h.and_then(|h| {
                    let distance = (before.position[1] - h).max(0.0);
                    (distance <= self.tuning.support_reach()).then_some(distance)
                })),
                rise,
                dt,
                &self.tuning,
            )
            .map_err(|e| e.to_string())?;
        let next = [
            p[0] + f64::from(self.state.velocity[0] * dt),
            p[1] + f64::from(self.state.velocity[2] * dt),
        ];
        let swept_start = [p[0], f64::from(before.position[1]), p[1]];
        let swept_end = [
            next[0],
            f64::from(before.position[1] + self.state.velocity[1] * dt),
            next[1],
        ];
        if self
            .scene_bounds
            .iter()
            .any(|b| swept_box(swept_start, swept_end, *b))
            || self.scene_mesh.swept(swept_start, swept_end)
        {
            self.physics_stats[4] = self.physics_stats[4].saturating_add(1);
            self.state = before;
            self.state.velocity = [0.0; 3];
            self.hold = 3;
            return Ok(());
        }
        match self.motion_heights_at(next, self.state.yaw, swept_end[1] as f32, !self.state.grounded) {
            Ok(hs)
                if hs
                    .iter()
                    .zip(heights)
                    .all(|(h, old)| h.is_none_or(|h| old.is_some_and(|old| h - old < SUPPORT_RISE)
                        || f64::from(h) + HULL_HALF_HEIGHT <= swept_start[1].min(swept_end[1]))) =>
            {
                let floor = hs.into_iter().flatten().fold(f32::NEG_INFINITY, f32::max) + FLOOR_CLEARANCE;
                let corrected_end = [swept_end[0], f64::from(floor), swept_end[2]];
                if swept_end[1] < corrected_end[1]
                    && (self.scene_bounds.iter().any(|b| swept_box(swept_end, corrected_end, *b))
                        || self.scene_mesh.swept(swept_end, corrected_end))
                {
                    self.physics_stats[4] = self.physics_stats[4].saturating_add(1);
                    self.state = before;
                    self.state.velocity = [0.0; 3];
                    self.hold = 3;
                    return Ok(());
                }
                for i in 0..3 {
                    self.state.position[i] += self.state.velocity[i] * dt;
                }
                if self.state.position[1] < floor {
                    self.physics_stats[6] = self.physics_stats[6].saturating_add(1);
                    self.state.position[1] = floor;
                    self.state.velocity[1] = self.state.velocity[1].max(0.0);
                }
                self.hold = 0;
                self.rebase();
            }
            result => {
                let reason = result.as_ref().err().copied().unwrap_or(3);
                let counter = if reason == 1 {
                    2
                } else if reason == 2 {
                    3
                } else {
                    5
                };
                self.physics_stats[counter] = self.physics_stats[counter].saturating_add(1);
                self.state = before;
                self.state.velocity = [0.0; 3];
                self.hold = result.err().unwrap_or(3);
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct CollisionTree {
    triangles: Vec<[[f64; 3]; 3]>,
    nodes: Vec<CollisionNode>,
}

struct CollisionNode {
    bounds: [f64; 6],
    range: std::ops::Range<usize>,
    children: Option<[usize; 2]>,
}

struct CollisionPrimitive {
    bounds: [f64; 6],
    center: [f64; 3],
}

impl CollisionTree {
    fn buffer_bytes(&self) -> usize {
        self.triangles.capacity() * std::mem::size_of::<[[f64; 3]; 3]>()
            + self.nodes.capacity() * std::mem::size_of::<CollisionNode>()
    }

    fn from_parts(parts: &mut [&Self]) -> Self {
        let mut tree = Self {
            triangles: Vec::with_capacity(parts.iter().map(|p| p.triangles.len()).sum()),
            nodes: Vec::with_capacity(
                parts.iter().map(|p| p.nodes.len()).sum::<usize>() + parts.len().saturating_sub(1),
            ),
        };
        if !parts.is_empty() {
            tree.append_parts(parts);
        }
        tree
    }

    fn append_parts(&mut self, parts: &mut [&Self]) -> usize {
        let index = self.nodes.len();
        let start = self.triangles.len();
        if parts.len() == 1 {
            let part = parts[0];
            self.triangles.extend_from_slice(&part.triangles);
            self.nodes.extend(part.nodes.iter().map(|n| CollisionNode {
                bounds: n.bounds,
                range: n.range.start + start..n.range.end + start,
                children: n.children.map(|c| c.map(|i| i + index)),
            }));
            return index;
        }
        let mut bounds = [f64::INFINITY; 6];
        bounds[3..].fill(f64::NEG_INFINITY);
        for part in parts.iter() {
            let b = part.nodes[0].bounds;
            for a in 0..3 {
                bounds[a] = bounds[a].min(b[a]);
                bounds[a + 3] = bounds[a + 3].max(b[a + 3]);
            }
        }
        self.nodes.push(CollisionNode {
            bounds,
            range: start..start,
            children: None,
        });
        let axis = (0..3)
            .max_by(|&a, &b| (bounds[a + 3] - bounds[a]).total_cmp(&(bounds[b + 3] - bounds[b])))
            .unwrap();
        let middle = parts.len() / 2;
        parts.select_nth_unstable_by(middle, |a, b| {
            let a = a.nodes[0].bounds;
            let b = b.nodes[0].bounds;
            (a[axis] + a[axis + 3]).total_cmp(&(b[axis] + b[axis + 3]))
        });
        let (left, right) = parts.split_at_mut(middle);
        let children = [self.append_parts(left), self.append_parts(right)];
        self.nodes[index].range.end = self.triangles.len();
        self.nodes[index].children = Some(children);
        index
    }

    fn new(vertices: &[f64]) -> Result<Self, &'static str> {
        if !vertices.len().is_multiple_of(9)
            || vertices.len() > 200_000 * 9
            || vertices.iter().any(|v| !v.is_finite() || v.abs() > 1e12)
        {
            return Err("Invalid or oversized authored collision payload");
        }
        let triangles = vertices
            .as_chunks::<9>()
            .0
            .iter()
            .map(|v| std::array::from_fn(|i| std::array::from_fn(|a| v[i * 3 + a])))
            .collect();
        let mut tree = Self {
            triangles,
            nodes: vec![],
        };
        let count = tree.triangles.len();
        if count > 0 {
            let primitives: Vec<_> = tree
                .triangles
                .iter()
                .map(|triangle| {
                    let mut bounds = [f64::INFINITY; 6];
                    bounds[3..].fill(f64::NEG_INFINITY);
                    for p in triangle {
                        for a in 0..3 {
                            bounds[a] = bounds[a].min(p[a]);
                            bounds[a + 3] = bounds[a + 3].max(p[a]);
                        }
                    }
                    CollisionPrimitive {
                        bounds,
                        center: std::array::from_fn(|a| triangle.iter().map(|v| v[a]).sum()),
                    }
                })
                .collect();
            let mut order: Vec<_> = (0..count).collect();
            tree.build(0..count, &mut order, &primitives);
            drop(primitives);
            // Partition small indices, then apply the resulting permutation once in place.
            for start in 0..count {
                if order[start] == usize::MAX {
                    continue;
                }
                let saved = tree.triangles[start];
                let mut at = start;
                loop {
                    let next = order[at];
                    order[at] = usize::MAX;
                    if next == start {
                        tree.triangles[at] = saved;
                        break;
                    }
                    tree.triangles[at] = tree.triangles[next];
                    at = next;
                }
            }
        }
        Ok(tree)
    }

    fn build(
        &mut self,
        range: std::ops::Range<usize>,
        order: &mut [usize],
        primitives: &[CollisionPrimitive],
    ) -> usize {
        let mut bounds = [f64::INFINITY; 6];
        bounds[3..].fill(f64::NEG_INFINITY);
        for &i in &order[range.clone()] {
            let b = primitives[i].bounds;
            for a in 0..3 {
                bounds[a] = bounds[a].min(b[a]);
                bounds[a + 3] = bounds[a + 3].max(b[a + 3]);
            }
        }
        let index = self.nodes.len();
        self.nodes.push(CollisionNode {
            bounds,
            range: range.clone(),
            children: None,
        });
        if range.len() > 8 {
            let axis = (0..3)
                .max_by(|&a, &b| {
                    (bounds[a + 3] - bounds[a]).total_cmp(&(bounds[b + 3] - bounds[b]))
                })
                .unwrap();
            let half = range.len() / 2;
            order[range.clone()].select_nth_unstable_by(half, |&a, &b| {
                primitives[a].center[axis].total_cmp(&primitives[b].center[axis])
            });
            let middle = range.start + half;
            let left = self.build(range.start..middle, order, primitives);
            let right = self.build(middle..range.end, order, primitives);
            self.nodes[index].children = Some([left, right]);
        }
        index
    }

    fn any(
        &self,
        node: usize,
        broad: &impl Fn([f64; 6]) -> bool,
        narrow: &mut impl FnMut(&[[f64; 3]; 3]) -> bool,
    ) -> bool {
        let n = &self.nodes[node];
        if !broad(n.bounds) {
            return false;
        }
        if let Some([a, b]) = n.children {
            self.any(a, broad, narrow) || self.any(b, broad, narrow)
        } else {
            self.triangles[n.range.clone()].iter().any(narrow)
        }
    }

    fn height(&self, p: [f64; 2], ceiling: f64) -> Option<f64> {
        if self.nodes.is_empty() {
            return None;
        }
        let mut height: Option<f64> = None;
        self.any(
            0,
            &|b| p[0] >= b[0] && p[0] <= b[3] && p[1] >= b[2] && p[1] <= b[5] && b[1] <= ceiling,
            &mut |tri| {
                // Translate before f32 conversion to retain precision after floating-origin rebases.
                let local = tri.map(|v| [(v[0] - p[0]) as f32, (v[2] - p[1]) as f32, v[1] as f32]);
                if let Some(h) = triangle_z_at(&local, 0.0, 0.0)
                    .map(f64::from)
                    .filter(|h| *h <= ceiling)
                {
                    height = Some(height.map_or(h, |old| old.max(h)));
                }
                false
            },
        );
        height
    }

    fn swept(&self, start: [f64; 3], end: [f64; 3]) -> bool {
        !self.nodes.is_empty()
            && self.any(0, &|b| swept_box(start, end, b), &mut |tri| {
                swept_triangle(start, end, tri)
            })
    }
}

fn swept_triangle(start: [f64; 3], end: [f64; 3], triangle: &[[f64; 3]; 3]) -> bool {
    let sub = |a: [f64; 3], b: [f64; 3]| std::array::from_fn::<_, 3, _>(|i| a[i] - b[i]);
    let cross = |a: [f64; 3], b: [f64; 3]| {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ]
    };
    let dot = |a: [f64; 3], b: [f64; 3]| (0..3).map(|i| a[i] * b[i]).sum::<f64>();
    let tri = triangle.map(|p| sub(p, start));
    let edges = [
        sub(tri[1], tri[0]),
        sub(tri[2], tri[1]),
        sub(tri[0], tri[2]),
    ];
    let normal = cross(edges[0], edges[1]);
    if dot(normal, normal) < 1e-20 {
        return false;
    }
    let basis = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let axes = basis
        .into_iter()
        .chain([normal])
        .chain(edges.into_iter().flat_map(|e| basis.map(|a| cross(e, a))));
    let motion = sub(end, start);
    let (mut enter, mut exit) = (0.0_f64, 1.0_f64);
    for axis in axes {
        if dot(axis, axis) < 1e-20 {
            continue;
        }
        let values = tri.map(|p| dot(p, axis));
        let radius = axis[0].abs() * 1.1 + axis[1].abs() * HULL_HALF_HEIGHT + axis[2].abs() * 1.1;
        let low = values.into_iter().fold(f64::INFINITY, f64::min) - radius;
        let high = values.into_iter().fold(f64::NEG_INFINITY, f64::max) + radius;
        let delta = dot(motion, axis);
        if delta.abs() < 1e-12 {
            if low > 0.0 || high < 0.0 {
                return false;
            }
        } else {
            enter = enter.max((low / delta).min(high / delta));
            exit = exit.min((low / delta).max(high / delta));
            if enter > exit {
                return false;
            }
        }
    }
    true
}

fn swept_box(start: [f64; 3], end: [f64; 3], bounds: [f64; 6]) -> bool {
    if start[1].min(end[1]) - HULL_HALF_HEIGHT >= bounds[4] {
        return false;
    }
    let mut enter: f64 = 0.0;
    let mut exit: f64 = 1.0;
    for axis in 0..3 {
        let margin = if axis == 1 { HULL_HALF_HEIGHT } else { 1.1 };
        let low = bounds[axis] - margin;
        let high = bounds[axis + 3] + margin;
        let delta = end[axis] - start[axis];
        if delta.abs() < 1e-12 {
            if start[axis] < low || start[axis] > high {
                return false;
            }
        } else {
            let a = (low - start[axis]) / delta;
            let b = (high - start[axis]) / delta;
            enter = enter.max(a.min(b));
            exit = exit.min(a.max(b));
            if enter > exit {
                return false;
            }
        }
    }
    true
}

#[wasm_bindgen]
impl Voyage {
    pub fn tuning(&self) -> Vec<f32> {
        let t = &self.tuning;
        vec![
            t.max_speed,
            t.boost_max_speed,
            t.acceleration,
            t.boost_acceleration,
            t.braking,
            t.drag,
            t.turn_rate,
            t.turn_response,
            t.grip,
            t.drift_grip,
            t.drift_turn_multiplier,
            t.hover_height,
            t.spring,
            t.damping,
            t.gravity,
            t.hop_speed,
            t.air_control,
        ]
    }

    pub fn validate_tuning(&self, values: &[f32]) -> Result<(), JsValue> {
        Self::parse_tuning(values)
            .map(|_| ())
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn set_tuning(&mut self, values: &[f32]) -> Result<(), JsValue> {
        self.tuning = Self::parse_tuning(values).map_err(|e| JsValue::from_str(&e))?;
        Ok(())
    }

    /// Conservative travel during the worker's maximum 0.1-second batch, including new thrust.
    pub fn frame_sweep_distance(&self) -> f64 {
        self.travel_bound(f64::from(FIXED_DT) * 12.0)
    }

    /// Vertical collision demand only; horizontal terrain residency uses frame_sweep_distance.
    pub fn frame_vertical_sweep_distance(&self) -> f64 {
        let base_duration = f64::from(FIXED_DT) * 12.0;
        let roundoff = 8.0 * f64::from(f32::EPSILON);
        let max_error = roundoff * 12.0 * f64::from(MAX_SUPPORT_SUBSTEPS);
        let substeps = (self.travel_bound(base_duration * (1.0 + roundoff))
            / (1.0 - max_error)
            / 12.0
            / SUPPORT_TRAVEL)
            .ceil()
            .clamp(1.0, f64::from(MAX_SUPPORT_SUBSTEPS));
        let step = FIXED_DT / substeps as f32;
        let duration = (1..=substeps as u32)
            .map(|n| f64::from(FIXED_DT / n as f32) * f64::from(n))
            .fold(0.0, f64::max)
            * 12.0;
        let rise_rate = f64::from(SUPPORT_RISE / step);
        let initial_floor = self
            .heights(self.global(), self.state.yaw)
            .map_or(0.0, |hs| {
                (f64::from(hs.into_iter().fold(f32::NEG_INFINITY, f32::max))
                    + f64::from(FLOOR_CLEARANCE)
                    - f64::from(self.state.position[1]))
                .max(0.0)
            });
        // A newly eligible model support can rise .6, then the next terrain support another .6.
        let floor_rate =
            (2.0 * f64::from(SUPPORT_RISE) + f64::from(FLOOR_CLEARANCE)) / f64::from(step);
        // The implicit spring is a convex blend of v + spring*error*dt and surface velocity.
        // A grounded hop requires v - surfaceVelocity <= 2 and can occur only once in this batch.
        let speed = (f64::from(self.state.velocity[1]).abs() + 2.0)
            .max(rise_rate + f64::from(self.tuning.hop_speed))
            .max(floor_rate);
        let acceleration = (f64::from(self.tuning.spring) * f64::from(self.tuning.hover_height))
            .max(f64::from(self.tuning.gravity));
        let excursion = initial_floor + (speed + acceleration * duration) * duration;
        // Pad velocity casts, actual f32 substep dt, and accumulated position rounding on every branch.
        let error = roundoff * 12.0 * substeps;
        excursion
            + error / (1.0 - error) * (f64::from(self.state.position[1]).abs() + excursion + 1.0)
    }

    /// Ticks, substeps, missing terrain, unsupported surface, solid sweeps, steep rises, floor clamps, peak substeps.
    pub fn physics_stats(&self) -> Vec<u32> {
        self.physics_stats.to_vec()
    }

    pub fn set_admission_profiling(&mut self, enabled: bool) {
        self.profile_admission = enabled;
        self.admission_times.set([0.0; 9]);
    }

    /// Parse, terrain geometry, masks/materials, liquids, placements, validation, commit, render geometry, total add (ms).
    pub fn admission_timings(&self) -> Vec<f64> {
        self.admission_times.get().to_vec()
    }

    /// Indexed authored collision triangles in global east/up/south coordinates.
    pub fn set_scene_mesh(&mut self, vertices: &[f64]) -> Result<(), JsValue> {
        self.scene_mesh = CollisionTree::new(vertices).map_err(JsValue::from_str)?;
        self.scene_parts.clear();
        self.scene_bounds.clear();
        Ok(())
    }

    /// Positive counts supply new triangles; zero reuses a cached ID. Omitted IDs are evicted.
    pub fn set_scene_parts(
        &mut self,
        ids: &[u32],
        counts: &[u32],
        vertices: &[f64],
    ) -> Result<(), JsValue> {
        self.replace_scene_parts(ids, counts, vertices)
            .map_err(JsValue::from_str)
    }

    fn replace_scene_parts(
        &mut self,
        ids: &[u32],
        counts: &[u32],
        vertices: &[f64],
    ) -> Result<(), &'static str> {
        if ids.len() != counts.len() || ids.len() > 200_000 {
            return Err("Invalid collision part counts");
        }
        let mut wanted = std::collections::HashSet::with_capacity(ids.len());
        let mut total = 0usize;
        let mut supplied = 0usize;
        for (&id, &count) in ids.iter().zip(counts) {
            if !wanted.insert(id) {
                return Err("Duplicate collision part ID");
            }
            let count = if count == 0 {
                self.scene_parts
                    .get(&id)
                    .ok_or("Unknown cached collision part")?
                    .triangles
                    .len()
            } else {
                let count = count as usize;
                if count > 200_000 {
                    return Err("Collision parts exceed 200000 triangles");
                }
                supplied += count * 9;
                count
            };
            total += count;
            if total > 200_000 {
                return Err("Collision parts exceed 200000 triangles");
            }
        }
        if supplied != vertices.len() {
            return Err("Collision part payload length mismatch");
        }
        let mut replacements = HashMap::new();
        let mut offset = 0;
        for (&id, &count) in ids.iter().zip(counts) {
            if count > 0 {
                let end = offset + count as usize * 9;
                replacements.insert(id, CollisionTree::new(&vertices[offset..end])?);
                offset = end;
            }
        }
        let combined = {
            let mut parts: Vec<_> = ids
                .iter()
                .map(|id| {
                    replacements
                        .get(id)
                        .or_else(|| self.scene_parts.get(id))
                        .unwrap()
                })
                .collect();
            CollisionTree::from_parts(&mut parts)
        };
        self.scene_parts.retain(|id, _| wanted.contains(id));
        self.scene_parts.extend(replacements);
        self.scene_mesh = combined;
        self.scene_bounds.clear();
        Ok(())
    }

    fn parse_tuning(values: &[f32]) -> Result<Tuning, String> {
        let v: &[f32; 17] = values
            .try_into()
            .map_err(|_| "Tuning requires exactly 17 values")?;
        let tuning = Tuning {
            max_speed: v[0],
            boost_max_speed: v[1],
            acceleration: v[2],
            boost_acceleration: v[3],
            braking: v[4],
            drag: v[5],
            turn_rate: v[6],
            turn_response: v[7],
            grip: v[8],
            drift_grip: v[9],
            drift_turn_multiplier: v[10],
            hover_height: v[11],
            spring: v[12],
            damping: v[13],
            gravity: v[14],
            hop_speed: v[15],
            air_control: v[16],
        };
        tuning.validate().map_err(|e| e.to_string())?;
        Ok(tuning)
    }

    /// Active triangles, flat nodes, and geometry-buffer bytes including cached instance trees.
    pub fn collision_stats(&self) -> Vec<u32> {
        vec![
            self.scene_mesh.triangles.len() as u32,
            self.scene_mesh.nodes.len() as u32,
            (self.scene_mesh.buffer_bytes()
                + self
                    .scene_parts
                    .values()
                    .map(CollisionTree::buffer_bytes)
                    .sum::<usize>()) as u32,
        ]
    }

    pub fn collision_vertices(&self) -> Vec<f64> {
        self.scene_mesh
            .triangles
            .iter()
            .flatten()
            .flatten()
            .copied()
            .collect()
    }

    /// minXYZ/maxXYZ/start/end/left/right, ten f64s per node; leaf children are -1.
    pub fn collision_nodes(&self) -> Vec<f64> {
        self.scene_mesh
            .nodes
            .iter()
            .flat_map(|n| {
                let children = n.children.map_or([-1.0; 2], |c| c.map(|i| i as f64));
                [
                    n.bounds[0],
                    n.bounds[1],
                    n.bounds[2],
                    n.bounds[3],
                    n.bounds[4],
                    n.bounds[5],
                    n.range.start as f64,
                    n.range.end as f64,
                    children[0],
                    children[1],
                ]
            })
            .collect()
    }

    /// Conservative bounds of authored collision meshes, not exact building interiors.
    pub fn set_scene_bounds(&mut self, bounds: &[f64]) -> Result<(), JsValue> {
        if !bounds.len().is_multiple_of(6)
            || bounds.len() > 1024 * 6
            || bounds.iter().any(|v| !v.is_finite() || v.abs() > 1e12)
            || bounds
                .as_chunks::<6>()
                .0
                .iter()
                .any(|b| (0..3).any(|i| b[i] > b[i + 3]))
        {
            return Err(JsValue::from_str("Invalid scene collision bounds"));
        }
        self.scene_bounds = bounds.as_chunks::<6>().0.to_vec();
        self.scene_mesh = CollisionTree::default();
        self.scene_parts.clear();
        Ok(())
    }

    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<Voyage, JsValue> {
        let manifest: Manifest =
            serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Self::from_manifest(manifest).map_err(|e| JsValue::from_str(&e))
    }

    pub fn add_tile(&mut self, index: usize, bytes: &[u8]) -> Result<(), JsValue> {
        let fail = |s: &str| JsValue::from_str(s);
        self.check_tile_input(index, bytes.len())
            .map_err(|e| fail(&e))?;
        let now = || {
            if self.profile_admission {
                admission_now()
            } else {
                0.0
            }
        };
        let started = now();
        let mut times = [0.0; 9];
        let built = if self.profile_admission {
            let mut previous = started;
            adt_to_tile_mesh_observed(bytes, |phase| {
                let time = now();
                let index = match phase {
                    TerrainBuildPhase::Parse => 0,
                    TerrainBuildPhase::Geometry => 1,
                    TerrainBuildPhase::Materials => 2,
                    TerrainBuildPhase::Liquids => 3,
                    TerrainBuildPhase::Placements => 4,
                };
                times[index] += time - previous;
                previous = time;
            })
        } else {
            adt_to_tile_mesh(bytes)
        };
        times[8] = now() - started;
        self.admission_times.set(times);
        let tile = built.map_err(|e| fail(&e.to_string()))?;
        let validation = now();
        let valid = self.validate_tile(index, &tile);
        times[5] = now() - validation;
        times[8] = now() - started;
        self.admission_times.set(times);
        valid.map_err(|e| fail(&e))?;
        let commit = now();
        self.resident.insert(index, tile);
        times[6] = if self.profile_admission {
            admission_now() - commit
        } else {
            0.0
        };
        times[8] = if self.profile_admission {
            admission_now() - started
        } else {
            0.0
        };
        self.admission_times.set(times);
        Ok(())
    }

    pub fn begin_tile(&mut self, index: usize, bytes: Vec<u8>) -> Result<(), JsValue> {
        self.check_tile_input(index, bytes.len())
            .map_err(|e| JsValue::from_str(&e))?;
        if self.tile_builder.is_some() || self.prepared_tile.is_some() {
            return Err(JsValue::from_str(
                "A terrain tile is already being prepared",
            ));
        }
        let builder = TileMeshBuilder::new(bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.tile_builder = Some((index, builder));
        Ok(())
    }

    pub fn step_tile(&mut self) -> Result<bool, JsValue> {
        let (index, builder) = self
            .tile_builder
            .as_mut()
            .ok_or_else(|| JsValue::from_str("No terrain tile is being prepared"))?;
        let index = *index;
        if let Some(tile) = builder
            .step()
            .map_err(|e| JsValue::from_str(&e.to_string()))?
        {
            self.validate_tile(index, &tile)
                .map_err(|e| JsValue::from_str(&e))?;
            self.tile_builder = None;
            self.prepared_tile = Some((index, tile));
            return Ok(true);
        }
        Ok(false)
    }

    pub fn commit_tile(&mut self, index: usize) -> Result<(), JsValue> {
        if self
            .prepared_tile
            .as_ref()
            .is_none_or(|(prepared, _)| *prepared != index)
            || (!self.resident.contains_key(&index) && self.resident.len() >= MAX_RESIDENT)
        {
            return Err(JsValue::from_str(
                "Prepared terrain tile/resident limit rejected",
            ));
        }
        let (_, tile) = self.prepared_tile.take().expect("checked prepared tile");
        self.resident.insert(index, tile);
        Ok(())
    }

    pub fn cancel_tile(&mut self) {
        self.tile_builder = None;
        self.prepared_tile = None;
    }

    pub fn remove_tile(&mut self, index: usize) {
        self.resident.remove(&index);
    }

    pub fn tick(&mut self, throttle: f32, steer: f32, flags: u32) -> Result<(), JsValue> {
        self.advance(Input {
            throttle,
            steer,
            brake: flags & 1 != 0,
            boost: flags & 2 != 0,
            drift: flags & 4 != 0,
            jump: flags & 8 != 0,
        })
        .map_err(|e| JsValue::from_str(&e))
    }

    pub fn telemetry(&self) -> Vec<f64> {
        let p = self.global();
        let surface = self.sample(p);
        vec![
            p[0],
            f64::from(self.state.position[1]),
            p[1],
            f64::from(self.state.yaw),
            f64::from(self.state.bank),
            f64::from(self.state.velocity[0].hypot(self.state.velocity[2])),
            f64::from(self.state.boost_reserve),
            f64::from(self.state.grounded),
            f64::from(self.hold),
            f64::from(surface.on_water()),
            f64::from(surface.region),
            self.origin[0],
            self.origin[1],
            f64::from(self.rebases),
            f64::from(
                -self.state.velocity[0] * self.state.yaw.sin()
                    - self.state.velocity[2] * self.state.yaw.cos(),
            ),
        ]
    }

    pub fn surface(&self, x: f64, z: f64) -> Vec<f64> {
        let s = self.sample([x, z]);
        vec![
            f64::from(s.availability),
            s.ground.map_or(f64::NAN, f64::from),
            s.water.map_or(f64::NAN, f64::from),
            f64::from(s.solid),
            f64::from(s.region),
        ]
    }

    pub fn restore(&mut self, pose: &[f64]) -> Result<(), JsValue> {
        self.restore_pose(pose).map_err(|e| JsValue::from_str(&e))
    }

    pub fn reset(&mut self) {
        self.origin = [self.manifest.spawn[0], self.manifest.spawn[2]];
        self.state = State::new(
            [0.0, self.manifest.spawn[1] as f32, 0.0],
            self.manifest.spawn[3] as f32,
        )
        .expect("validated spawn");
        self.hold = 1;
    }

    /// Local tile positions and face normals, followed by material (0 ground, 2 water).
    pub fn geometry(&self, index: usize) -> Result<Vec<f32>, JsValue> {
        let started = if self.profile_admission {
            admission_now()
        } else {
            0.0
        };
        let tile = self
            .resident
            .get(&index)
            .ok_or_else(|| JsValue::from_str("Tile is not resident"))?;
        let entry = &self.manifest.tiles[index];
        let nw = [
            -(f64::from(entry.y) - 32.0) * TILE,
            -(f64::from(entry.x) - 32.0) * TILE,
        ];
        let mut out = Vec::new();
        let mut emit = |positions: &[[f32; 3]], indices: &[u32], material: f32| {
            for t in indices.as_chunks::<3>().0 {
                let p = t.map(|i| {
                    let v = positions[i as usize];
                    [
                        (nw[1] - f64::from(v[1])) as f32,
                        v[2],
                        (nw[0] - f64::from(v[0])) as f32,
                    ]
                });
                let a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
                let b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
                let mut n = [
                    a[1] * b[2] - a[2] * b[1],
                    a[2] * b[0] - a[0] * b[2],
                    a[0] * b[1] - a[1] * b[0],
                ];
                let length = n.iter().map(|v| v * v).sum::<f32>().sqrt().max(0.0001);
                let sign = if n[1] < 0.0 { -1.0 } else { 1.0 };
                n.iter_mut().for_each(|v| *v *= sign / length);
                for v in p {
                    out.extend(v);
                    out.extend(n);
                    out.push(material);
                }
            }
        };
        for chunk in &tile.chunks {
            emit(&chunk.positions, &chunk.indices, 0.0);
            for liquid in &chunk.liquids {
                if matches!(liquid.kind, LiquidKind::Still | LiquidKind::Ocean) {
                    emit(&liquid.positions, &liquid.indices, 2.0);
                }
            }
        }
        if self.profile_admission {
            let mut times = self.admission_times.get();
            times[7] = admission_now() - started;
            self.admission_times.set(times);
        }
        Ok(out)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    #[test]
    fn cached_collision_parts_preserve_queries_ranges_and_atomic_replacement() {
        use super::*;
        let vertices = [
            -10.0, 5.0, -10.0, 10.0, 5.0, -10.0, 10.0, 5.0, 10.0, -10.0, 5.0, -10.0, 10.0, 5.0,
            10.0, -10.0, 5.0, 10.0, 8.0, 0.0, -10.0, 8.0, 5.0, -10.0, 8.0, 5.0, 10.0, 8.0, 0.0,
            -10.0, 8.0, 5.0, 10.0, 8.0, 0.0, 10.0,
        ];
        let reference = CollisionTree::new(&vertices).unwrap();
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        world
            .replace_scene_parts(&[7, 8], &[2, 2], &vertices)
            .unwrap();
        let retained = world.scene_parts[&7].triangles.as_ptr();
        for x in -12..12 {
            for z in -12..12 {
                for ceiling in [1.6, 6.0] {
                    let p = [f64::from(x), f64::from(z)];
                    assert_eq!(
                        world.scene_mesh.height(p, ceiling),
                        reference.height(p, ceiling)
                    );
                }
                let start = [f64::from(x), 1.1, f64::from(z)];
                let end = [f64::from(x + 20), 1.1, f64::from(z)];
                assert_eq!(
                    world.scene_mesh.swept(start, end),
                    reference.swept(start, end)
                );
            }
        }
        let added = [100.0, 2.0, 0.0, 103.0, 2.0, 0.0, 100.0, 2.0, 3.0];
        world
            .replace_scene_parts(&[9, 8, 7], &[1, 0, 0], &added)
            .unwrap();
        assert_eq!(world.scene_parts[&7].triangles.as_ptr(), retained);
        assert_eq!(world.scene_mesh.height([101.0, 1.0], 3.0), Some(2.0));
        assert_eq!(world.scene_mesh.nodes[0].range, 0..5);
        let mut covered = 0;
        for node in &world.scene_mesh.nodes {
            if let Some([left, right]) = node.children {
                assert_eq!(node.range.start, world.scene_mesh.nodes[left].range.start);
                assert_eq!(
                    world.scene_mesh.nodes[left].range.end,
                    world.scene_mesh.nodes[right].range.start
                );
                assert_eq!(node.range.end, world.scene_mesh.nodes[right].range.end);
            } else {
                covered += node.range.len();
            }
            for p in world.scene_mesh.triangles[node.range.clone()]
                .iter()
                .flatten()
            {
                for (a, value) in p.iter().enumerate() {
                    assert!(*value >= node.bounds[a] && *value <= node.bounds[a + 3]);
                }
            }
        }
        assert_eq!(covered, 5);
        for (ids, counts, data) in [
            (vec![7, 7], vec![0, 0], vec![]),
            (vec![99], vec![0], vec![]),
            (vec![10], vec![1], vec![0.0; 8]),
            (vec![10], vec![1], vec![f64::NAN; 9]),
        ] {
            assert!(world.replace_scene_parts(&ids, &counts, &data).is_err());
            assert_eq!(world.scene_mesh.triangles.len(), 5);
            assert_eq!(world.scene_parts[&7].triangles.as_ptr(), retained);
        }
        assert_eq!(
            world.replace_scene_parts(&[7, 10], &[0, 199999], &[]),
            Err("Collision parts exceed 200000 triangles")
        );
        world.replace_scene_parts(&[7, 9], &[0, 0], &[]).unwrap();
        assert!(!world.scene_parts.contains_key(&8));
        assert!(!world.scene_mesh.swept([0.0, 1.1, 0.0], [20.0, 1.1, 0.0]));
        world.set_scene_mesh(&[]).unwrap();
        assert!(world.scene_parts.is_empty());
        assert!(world.scene_mesh.nodes.is_empty());
        world
            .replace_scene_parts(&[7], &[2], &vertices[..18])
            .unwrap();
        world.set_scene_bounds(&[]).unwrap();
        assert!(world.scene_parts.is_empty());
        assert!(world.scene_mesh.nodes.is_empty());
    }

    #[test]
    fn indexed_bvh_partition_preserves_every_triangle_and_exported_node_range() {
        use super::*;
        for count in [1, 8, 9, 17, 257, 2049] {
            let mut original: Vec<[[f64; 3]; 3]> = (0..count)
                .map(|i| {
                    let x = f64::from((i * 97) % 31);
                    let z = f64::from((i * 73) % 29);
                    [[x, 0.0, z], [x + 0.4, 0.0, z], [x, 0.0, z + 0.3]]
                })
                .collect();
            let vertices: Vec<_> = original.iter().flatten().flatten().copied().collect();
            let tree = CollisionTree::new(&vertices).unwrap();
            let mut reordered = tree.triangles.clone();
            original.sort_by(|a, b| a.partial_cmp(b).unwrap());
            reordered.sort_by(|a, b| a.partial_cmp(b).unwrap());
            assert_eq!(reordered, original);
            assert_eq!(tree.nodes[0].range, 0..count as usize);
            let mut covered = 0;
            for node in &tree.nodes {
                if node.children.is_none() {
                    covered += node.range.len();
                }
                for triangle in &tree.triangles[node.range.clone()] {
                    for point in triangle {
                        for (axis, value) in point.iter().enumerate() {
                            assert!(*value >= node.bounds[axis] && *value <= node.bounds[axis + 3]);
                        }
                    }
                }
            }
            assert_eq!(covered, count as usize);
        }
    }

    #[test]
    fn resident_gentle_slope_does_not_become_a_wall_at_high_speed() {
        use super::*;
        for (speed, grade) in [(36.0, 0.2), (250.0, 0.35), (500.0, 0.2)] {
            let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
            let entry = &world.manifest.tiles[0];
            let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
            let northwest = (32.0 - f64::from(entry.x)) * TILE;
            for vertex in tile.chunks.iter_mut().flat_map(|c| &mut c.positions) {
                vertex[2] = (northwest - f64::from(vertex[1]) - 200.0) as f32 * grade;
            }
            world.resident.insert(0, tile);
            world.state.yaw = -std::f32::consts::FRAC_PI_2;
            world.state.velocity = [speed, speed * grade, 0.0];
            world.tuning.max_speed = speed;
            world.tuning.boost_max_speed = speed;
            world.tuning.drag = 0.0;
            let saved = (world.state, world.origin, world.rebases, world.hold);
            world
                .advance_substep(
                    Input {
                        throttle: 1.0,
                        ..Default::default()
                    },
                    FIXED_DT,
                )
                .unwrap();
            assert_eq!(
                world.hold,
                if speed > 50.0 { 3 } else { 0 },
                "old single-step guard"
            );
            (world.state, world.origin, world.rebases, world.hold) = saved;
            world.physics_stats = [0; 8];
            let before = world.global();
            let started = std::time::Instant::now();
            for _ in 0..60 {
                world
                    .advance(Input {
                        throttle: 1.0,
                        ..Default::default()
                    })
                    .unwrap();
                assert_eq!(world.hold, 0, "continuous grade {grade} at {speed} yd/s");
            }
            assert!(world.global()[0] - before[0] > f64::from(speed * FIXED_DT) * 60.0 * 0.98);
            assert!(world.physics_stats[7] <= 9);
            eprintln!(
                "{speed} yd/s, 60 resident ticks, {} substeps, {:?}",
                world.physics_stats[1],
                started.elapsed()
            );
        }
    }

    #[test]
    fn admission_profiling_preserves_actual_terrain_collision_materials_and_placements() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        for (index, map, x, y) in [(0, "Kalimdor", 39, 43), (1, "Azeroth", 32, 48)] {
            let bytes = chain
                .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
                .unwrap();
            let mut manifest = fixture(0.0);
            manifest.regions[index].tile_origin = [x, y];
            let entry = &mut manifest.tiles[index];
            entry.x = x;
            entry.y = y;
            entry.bytes = bytes.len();
            entry.file = format!("{map}_{x}_{y}.adt");
            let mut plain = Voyage::from_manifest(manifest.clone()).unwrap();
            let mut staged = Voyage::from_manifest(manifest.clone()).unwrap();
            let mut profiled = Voyage::from_manifest(manifest).unwrap();
            profiled.set_admission_profiling(true);
            plain.add_tile(index, &bytes).unwrap();
            profiled.add_tile(index, &bytes).unwrap();
            staged.begin_tile(index, bytes.clone()).unwrap();
            let mut steps = 0;
            loop {
                let done = staged.step_tile().unwrap();
                steps += 1;
                assert!(
                    staged.resident.is_empty(),
                    "Partial terrain must never support physics"
                );
                if done {
                    break;
                }
            }
            assert_eq!(steps, 257);
            assert_eq!(
                staged.prepared_tile_placements(&bytes).unwrap(),
                plain.tile_placements(index, &bytes).unwrap()
            );
            staged.commit_tile(index).unwrap();
            for (a, b) in plain.resident[&index]
                .chunks
                .iter()
                .zip(&staged.resident[&index].chunks)
            {
                assert_eq!(format!("{a:?}"), format!("{b:?}"));
            }
            staged.begin_tile(index, bytes.clone()).unwrap();
            staged.step_tile().unwrap();
            staged.cancel_tile();
            assert!(staged.tile_builder.is_none() && staged.prepared_tile.is_none());
            assert_eq!(
                staged.geometry(index).unwrap(),
                plain.geometry(index).unwrap()
            );
            assert_eq!(
                plain.geometry(index).unwrap(),
                profiled.geometry(index).unwrap()
            );
            assert_eq!(
                plain.tile_placements(index, &bytes).unwrap(),
                profiled.tile_placements(index, &bytes).unwrap()
            );
            let a = plain.terrain_material(index).unwrap();
            let b = profiled.terrain_material(index).unwrap();
            assert_eq!(a.vertices(), b.vertices());
            assert_eq!(a.indices(), b.indices());
            assert_eq!(a.masks(), b.masks());
            assert_eq!(a.paths(), b.paths());
            for (a, b) in plain.resident[&index]
                .chunks
                .iter()
                .zip(&profiled.resident[&index].chunks)
            {
                assert_eq!(a.positions, b.positions);
                assert_eq!(a.holes, b.holes);
            }
            let times = profiled.admission_timings();
            assert!(times.iter().all(|t| t.is_finite() && *t >= 0.0));
            assert!(times[0] > 0.0 && times[7] > 0.0 && times[8] >= times[..7].iter().sum::<f64>());
            assert_eq!(plain.admission_timings(), vec![0.0; 9]);
            profiled.set_admission_profiling(false);
            assert_eq!(profiled.admission_timings(), vec![0.0; 9]);
        }
    }

    #[test]
    fn support_substeps_preserve_thin_walls_holes_and_atomic_rebase_rollback() {
        use super::*;
        for kind in ["wall", "hole", "ledge", "missing"] {
            let mut manifest = fixture(0.0);
            if kind == "missing" {
                manifest.regions[0].tile_count[0] = 2;
                manifest.ocean[0] = TILE * 2.0;
                let mut neighbor = manifest.tiles[0].clone();
                neighbor.x += 1;
                neighbor.file = format!("Kalimdor_{}_{}.adt", neighbor.x, neighbor.y);
                manifest.tiles.push(neighbor);
            }
            let mut world = Voyage::from_manifest(manifest).unwrap();
            let entry = &world.manifest.tiles[0];
            let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
            let x = match kind {
                "hole" => {
                    tile.chunks[22].holes = u16::MAX;
                    198.0
                }
                "ledge" => {
                    for chunk in tile.chunks.iter_mut().filter(|c| c.index_x >= 7) {
                        for p in &mut chunk.positions {
                            p[2] = 10.0;
                        }
                    }
                    231.0
                }
                "missing" => 531.0,
                _ => 255.8,
            };
            world.resident.insert(0, tile);
            world.origin = [0.0, 64.0];
            world.state.position = [x, 1.1, 0.0];
            world.state.yaw = -std::f32::consts::FRAC_PI_2;
            world.state.velocity = [500.0, 0.0, 0.0];
            world.tuning.max_speed = 500.0;
            world.tuning.boost_max_speed = 500.0;
            if kind == "wall" {
                world.scene_bounds = vec![[258.0, 0.0, 0.0, 258.1, 10.0, 500.0]];
            }
            let (position, origin, rebases) = (world.state.position, world.origin, world.rebases);
            world
                .advance(Input {
                    throttle: 1.0,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(
                world.hold,
                if kind == "missing" {
                    1
                } else if kind == "hole" {
                    2
                } else {
                    3
                },
                "{kind}"
            );
            assert_eq!(world.state.position, position, "{kind}");
            assert_eq!(world.origin, origin, "{kind}");
            assert_eq!(world.rebases, rebases, "{kind}");
            assert_eq!(world.state.velocity, [0.0; 3], "{kind}");
        }
    }

    #[test]
    fn legacy_tick_path_is_unchanged_and_extreme_substep_work_is_rejected_atomically() {
        use super::*;
        let mut a = Voyage::from_manifest(fixture(0.0)).unwrap();
        let mut b = Voyage::from_manifest(fixture(0.0)).unwrap();
        a.tuning = Tuning { air_control: 0.9, ..Tuning::default() };
        b.tuning = a.tuning;
        a.origin = [700.0, 300.0];
        b.origin = a.origin;
        for tick in 0..600 {
            let input = Input {
                throttle: if tick % 100 < 80 { 1.0 } else { -1.0 },
                steer: if tick % 200 < 100 { 0.5 } else { -0.5 },
                boost: tick % 80 < 20,
                jump: tick % 120 == 0,
                ..Default::default()
            };
            a.advance(input).unwrap();
            b.advance_substep(input, FIXED_DT).unwrap();
            assert_eq!(a.telemetry(), b.telemetry());
        }
        assert_eq!(a.physics_stats[7], 1);
        a.tuning.max_speed = 5000.0;
        a.tuning.boost_max_speed = 5000.0;
        a.state.velocity = [5000.0, 0.0, 0.0];
        let before = a.telemetry();
        assert!(a
            .advance(Input::default())
            .unwrap_err()
            .contains("64 support substeps"));
        assert_eq!(a.telemetry(), before);
    }

    #[test]
    fn vertical_demand_bounds_falling_hopping_springs_penetration_and_f32_extremes() {
        let mut rejected = 0;
        for speed in [0.0, 250.0, 500.0] {
            for vertical in [-100.0, 0.0, 100.0, 1e20] {
                for height in [-50.0, 1.1, 22.18466, 1e6] {
                    for (spring, damping, hover, hop, gravity) in [
                        (0.0, 0.0, 1.1, 1.0, 1e-30),
                        (90.0, 18.0, 1.1, 100.0, 24.0),
                        (1e6, 0.0, 4.0, 1000.0, 24.0),
                        (1e6, 1e6, 100.0, 1000.0, 1000.0),
                        (f32::MAX, 0.0, f32::MAX, 1.0, 1e-30),
                        (f32::MAX, f32::MAX, f32::MAX, f32::MAX, f32::MAX),
                    ] {
                        for jump in [false, true] {
                            let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
                            world.origin = [700.0, 64.0];
                            world.state.position = [0.0, height, 0.0];
                            world.state.velocity = [speed, vertical, 0.0];
                            world.tuning.max_speed = 500.0;
                            world.tuning.boost_max_speed = 500.0;
                            world.tuning.spring = spring;
                            world.tuning.damping = damping;
                            world.tuning.hover_height = hover;
                            world.tuning.hop_speed = hop;
                            world.tuning.gravity = gravity;
                            world.tuning.validate().unwrap();
                            let bound = world.frame_vertical_sweep_distance();
                            assert!(bound.is_finite() && bound >= 0.0);
                            for _ in 0..12 {
                                let previous = world.state;
                                if let Err(error) = world.advance(Input {
                                    jump,
                                    ..Default::default()
                                }) {
                                    assert_eq!(world.state.position, previous.position);
                                    assert_eq!(world.state.velocity, previous.velocity);
                                    assert!(error.to_lowercase().contains("finite"), "{error}");
                                    rejected += 1;
                                    break;
                                }
                                let excursion =
                                    (f64::from(world.state.position[1]) - f64::from(height)).abs();
                                assert!(excursion <= bound, "{speed}/{vertical}/{height}/{spring}/{damping}/{hover}/{hop}/{gravity}: {excursion} > {bound}");
                            }
                        }
                    }
                }
            }
        }
        assert!(
            rejected > 0,
            "Nonfinite extreme-tuning steps must fail transactionally"
        );
    }

    #[test]
    fn unreachable_ledge_preview_cannot_launch_a_braking_vehicle_or_leak_a_rejected_hop() {
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        let entry = &world.manifest.tiles[0];
        let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
        for chunk in tile.chunks.iter_mut().filter(|c| c.index_x >= 7) {
            for vertex in &mut chunk.positions {
                vertex[2] = 10.0;
            }
        }
        world.resident.insert(0, tile);
        world.origin = [0.0, 64.0];
        world.state.position = [231.0, 1.1, 0.0];
        world.state.yaw = -std::f32::consts::FRAC_PI_2;
        world.state.velocity = [500.0, 0.0, 0.0];
        world.tuning.max_speed = 500.0;
        world.tuning.boost_max_speed = 500.0;
        world.tuning.braking = 1e6;
        let before = world.state;
        world
            .advance_substep(
                Input {
                    brake: true,
                    ..Default::default()
                },
                FIXED_DT,
            )
            .unwrap();
        assert_eq!(world.hold, 0);
        assert_eq!(world.state.position[0], before.position[0]);
        assert!(world.state.position[1] - before.position[1] < SUPPORT_RISE);
        world.state = before;
        world
            .advance(Input {
                throttle: 1.0,
                jump: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(world.hold, 3);
        assert_eq!(world.state.position, before.position);
        assert_eq!(world.state.jump_cooldown, before.jump_cooldown);
    }

    #[test]
    fn upward_feedforward_cap_preserves_accepted_downhill_response() {
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        let entry = &world.manifest.tiles[0];
        let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
        let northwest = (32.0 - f64::from(entry.x)) * TILE;
        for vertex in tile.chunks.iter_mut().flat_map(|c| &mut c.positions) {
            vertex[2] = (northwest - f64::from(vertex[1]) - 200.0) as f32 * -0.5;
        }
        world.resident.insert(0, tile);
        world.state.yaw = -std::f32::consts::FRAC_PI_2;
        world.state.velocity = [250.0, -100.0, 0.0];
        world.tuning.max_speed = 250.0;
        world.tuning.boost_max_speed = 250.0;
        world.tuning.drag = 0.0;
        let start = world.global();
        let hs = world.heights(start, world.state.yaw).unwrap();
        let next = world
            .heights(
                [start[0] + f64::from(250.0 * FIXED_DT), start[1]],
                world.state.yaw,
            )
            .unwrap();
        let rise = (next.iter().sum::<f32>() - hs.iter().sum::<f32>()) / (4.0 * FIXED_DT);
        assert!(rise < -SUPPORT_RISE / FIXED_DT);
        let input = Input {
            jump: true,
            ..Default::default()
        };
        let mut expected = world.state;
        expected
            .step_with_surface_motion(
                input,
                hs.map(|h| Some((expected.position[1] - h).max(0.0))),
                rise,
                FIXED_DT,
                &world.tuning,
            )
            .unwrap();
        world.advance_substep(input, FIXED_DT).unwrap();
        assert_eq!(world.hold, 0);
        assert_eq!(world.state.velocity, expected.velocity);
        assert_eq!(world.state.grounded, expected.grounded);
        assert_eq!(world.state.jump_cooldown, expected.jump_cooldown);
    }

    #[test]
    fn frame_sweep_bounds_new_thrust_boost_and_airborne_authority() {
        use super::*;
        for supports in [[Some(1.1); 4], [None; 4]] {
            for (speed, acceleration, cap, air_control) in [
                (0.0, 18.0, 60.0, 0.9),
                (0.0, 10000.0, 500.0, 4.0),
                (500.0, 18.0, 500.0, 4.0),
            ] {
                let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
                world.state.velocity = [speed, 0.0, 0.0];
                world.tuning.max_speed = cap;
                world.tuning.boost_max_speed = cap;
                world.tuning.acceleration = acceleration;
                world.tuning.air_control = air_control;
                let bound = world.frame_sweep_distance();
                let mut traveled = 0.0;
                for _ in 0..12 {
                    world
                        .state
                        .step_with_tuning(
                            Input {
                                throttle: 1.0,
                                steer: 1.0,
                                boost: true,
                                ..Default::default()
                            },
                            supports,
                            FIXED_DT,
                            &world.tuning,
                        )
                        .unwrap();
                    traveled += f64::from(world.state.velocity[0])
                        .hypot(f64::from(world.state.velocity[2]))
                        * f64::from(FIXED_DT);
                }
                assert!(traveled <= bound + 0.0001, "{traveled} exceeds {bound}");
            }
        }
    }

    #[test]
    fn floor_correction_cannot_cross_newly_admitted_collision() {
        for shift in [0.0, 1.0e9] {
            for jump in [false, true] {
                let mut world = Voyage::from_manifest(fixture(shift)).unwrap();
                let entry = &world.manifest.tiles[0];
                let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
                for vertex in tile.chunks.iter_mut().flat_map(|c| &mut c.positions) {
                    vertex[2] = 1.0;
                }
                world.resident.insert(0, tile);
                let x = shift + 200.0;
                world.origin = [x, 64.0];
                world.state = State::new([0.0, 1.1, 0.0], 0.3).unwrap();
                world.state.bank = 0.2;
                world.state.boost_reserve = 0.5;
                world.tuning.hop_speed = 1.0;
                let before = (world.state, world.origin, world.rebases);
                world.scene_mesh = CollisionTree::new(&[
                    x - 10.0, 1.65, 54.0, x + 10.0, 1.65, 54.0, x + 10.0, 1.65, 74.0,
                    x - 10.0, 1.65, 54.0, x + 10.0, 1.65, 74.0, x - 10.0, 1.65, 74.0,
                ])
                .unwrap();
                let point = [x, f64::from(world.state.position[1]), 64.0];
                assert!(!world.scene_mesh.swept(point, point));
                world
                    .advance(Input {
                        throttle: 1.0,
                        steer: 0.5,
                        boost: true,
                        jump,
                        ..Default::default()
                    })
                    .unwrap();
                assert_eq!(world.hold, 3);
                assert_eq!((world.state, world.origin, world.rebases), before);
                assert_eq!(world.physics_stats[4], 1);
                assert_eq!(world.physics_stats[6], 0);
                world.scene_mesh = CollisionTree::default();
                world.advance(Input::default()).unwrap();
                assert_eq!(world.hold, 0, "A blocked correction must not embed the hull");
                assert_eq!(world.state.position[1], 1.25);
            }
        }
    }

    #[test]
    fn steep_terrain_edges_still_block_when_the_actual_hull_cannot_clear_them() {
        for (height, blocked) in [(1.4, true), (1.6, false)] {
            let mut world=Voyage::from_manifest(fixture(0.0)).unwrap();
            let tile=&world.manifest.tiles[0];
            let mut raised=crate::world::tests::flat_tile(tile.x,tile.y);
            for chunk in &mut raised.chunks {for p in &mut chunk.positions {p[2]=1.0;}}
            world.resident.insert(0,raised);
            world.tuning.hover_height=height;
            world.restore_pose(&[535.0,f64::from(height),64.0,std::f64::consts::FRAC_PI_2]).unwrap();
            world.state.velocity=[-36.0,0.0,0.0];
            for _ in 0..12 {
                world.advance(Input {throttle:1.0,..Default::default()}).unwrap();
                if world.hold!=0 {break;}
            }
            assert_eq!(world.hold==3,blocked,"height={height}");
            if blocked {assert!(world.physics_stats[5]>0);} else {assert!(world.global()[0]<533.0);}
        }
    }

    #[test]
    fn elevated_vehicle_clears_low_support_edges_without_a_false_solid_hold() {
        for shift in [0.0, 1.0e9] {
            for height in [3.0, 30.0] {
                for speed in [150.0, 300.0] {
                    let mut world = Voyage::from_manifest(fixture(shift)).unwrap();
                    let x = shift + 700.0;
                    world.tuning.hover_height = height;
                    world.tuning.max_speed = 150.0;
                    world.tuning.boost_max_speed = 300.0;
                    world.tuning.acceleration = 50.0;
                    world.tuning.boost_acceleration = 50.0;
                    world.restore_pose(&[x, f64::from(height), 64.0, -std::f64::consts::FRAC_PI_2]).unwrap();
                    world.state.velocity = [speed, 0.0, 0.0];
                    world.scene_mesh = CollisionTree::new(&[
                        x+4.0,1.0,54.0,x+10.0,1.0,54.0,x+10.0,1.0,74.0,
                        x+4.0,1.0,54.0,x+10.0,1.0,74.0,x+4.0,1.0,74.0,
                    ]).unwrap();
                    for _ in 0..20 {
                        world.advance(Input {throttle:1.0,boost:true,..Default::default()}).unwrap();
                        assert_eq!(world.hold, 0, "clear hull blocked at {height}yd/{speed}yd/s; counters={:?}",world.physics_stats);
                    }
                    assert!(world.global()[0] > x+15.0);
                    assert_eq!(world.physics_stats[4],0);
                    assert_eq!(world.physics_stats[5],0);
                }
            }
        }
    }

    #[test]
    fn overhead_mesh_is_not_support_and_does_not_trap_a_clear_vehicle() {
        for shift in [0.0, 1.0e9] {
            let mut world = Voyage::from_manifest(fixture(shift)).unwrap();
            world.tuning.hover_height = 1.1;
            let x = shift + 700.0;
            world.restore_pose(&[x, 1.1, 64.0, 0.0]).unwrap();
            world.scene_mesh = CollisionTree::new(&[
                x - 10.0, 1.65, 54.0, x + 10.0, 1.65, 54.0, x + 10.0, 1.65, 74.0,
                x - 10.0, 1.65, 54.0, x + 10.0, 1.65, 74.0, x - 10.0, 1.65, 74.0,
            ])
            .unwrap();
            world.restore_pose(&[x, 1.1, 64.0, 0.0]).unwrap();
            for _ in 0..60 {
                world.advance(Input { throttle: 1.0, ..Default::default() }).unwrap();
                assert_eq!(world.hold, 0);
                let p = world.global();
                let point = [p[0], f64::from(world.state.position[1]), p[1]];
                assert!(!world.scene_mesh.swept(point, point));
                assert!(world.state.position[1] < 1.65);
            }
            assert!(64.0 - world.global()[1] > 1.0);
        }
    }

    #[test]
    fn rising_motion_queries_bridge_support_at_the_proposed_height() {
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        let entry = &world.manifest.tiles[0];
        let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
        for chunk in &mut tile.chunks {
            chunk.holes = u16::MAX;
        }
        world.resident.insert(0, tile);
        let mut vertices = vec![];
        for (left, right, height) in [(180.0, 201.28, 0.59), (201.28, 220.0, 1.12)] {
            vertices.extend([
                left, height, 54.0, right, height, 54.0, right, height, 74.0,
                left, height, 54.0, right, height, 74.0, left, height, 74.0,
            ]);
        }
        world.scene_mesh = CollisionTree::new(&vertices).unwrap();
        world.restore_pose(&[200.0, 1.1, 64.0, -std::f64::consts::FRAC_PI_2]).unwrap();
        world.state.velocity = [500.0, 2000.0, 0.0];
        world.tuning.max_speed = 500.0;
        world.tuning.boost_max_speed = 500.0;
        world.tuning.drag = 0.0;
        world.tuning.spring = 0.0;
        world.tuning.damping = 0.0;
        let first_endpoint = [200.0 + f64::from(500.0 * (FIXED_DT / 9.0)), 64.0];
        assert!(!world.scene_mesh.swept(
            [200.0, 1.1, 64.0],
            [first_endpoint[0], 1.1 + f64::from(2000.0 * (FIXED_DT / 9.0)), 64.0],
        ));
        assert!(world.heights_at(first_endpoint, world.state.yaw, 1.1).is_err());
        world.advance(Input::default()).unwrap();
        assert_eq!(world.hold, 0);
        assert!(world.global()[0] > 204.0);
        assert_eq!(world.physics_stats[7], 9);
    }

    #[test]
    fn indexed_authored_collision_keeps_open_interiors_bridges_and_swept_walls() {
        use super::*;
        let triangles = [
            // A raised bridge, with open space underneath rather than an enclosing solid box.
            [-10.0, 5.0, -10.0, 10.0, 5.0, -10.0, 10.0, 5.0, 10.0],
            [-10.0, 5.0, -10.0, 10.0, 5.0, 10.0, -10.0, 5.0, 10.0],
            // Wall beyond the bridge's open center.
            [8.0, 0.0, -10.0, 8.0, 5.0, -10.0, 8.0, 5.0, 10.0],
            [8.0, 0.0, -10.0, 8.0, 5.0, 10.0, 8.0, 0.0, 10.0],
        ];
        let tree = CollisionTree::new(triangles.as_flattened()).unwrap();
        assert_eq!(tree.height([0.0, 0.0], 1.6), None);
        assert_eq!(tree.height([0.0, 0.0], 6.0), Some(5.0));
        assert!(!tree.swept([-5.0, 1.1, 0.0], [5.0, 1.1, 0.0]));
        assert!(!tree.swept([-5.0, 6.1, 0.0], [5.0, 6.1, 0.0]));
        assert!(tree.swept([0.0, 1.1, 0.0], [20.0, 1.1, 0.0]));
        assert!(tree.swept([0.0, 4.0, 0.0], [0.0, 6.0, 0.0]));
        assert!(!tree.swept([0.0, 1.1, 20.0], [20.0, 1.1, 20.0]));
        assert!(CollisionTree::new(&[f64::NAN; 9]).is_err());
        assert!(CollisionTree::new(&[0.0; 8]).is_err());
        assert!(!swept_triangle([0.0; 3], [1.0; 3], &[[0.0; 3]; 3]));
    }

    #[test]
    fn collision_tree_matches_full_sweep_and_height_walk_after_translation() {
        use super::*;
        let mut vertices = vec![];
        for i in 0..200 {
            let x = 1_000_000.0 + f64::from(i) * 4.0;
            vertices.extend([x, 0.0, 0.0, x + 3.0, 0.0, 0.0, x, 0.0, 3.0]);
        }
        let tree = CollisionTree::new(&vertices).unwrap();
        assert!(tree.nodes.len() > 1);
        let mut visits = 0;
        tree.any(
            0,
            &|b| b[0] <= 1_000_000.25 && b[3] >= 1_000_000.25 && b[2] <= 0.25 && b[5] >= 0.25,
            &mut |_| {
                visits += 1;
                false
            },
        );
        assert!(visits <= 8, "Point query visited {visits}/200 triangles");
        for i in 0..800 {
            let x = 1_000_000.0 + f64::from(i);
            for z in [0.25, 2.0, 4.0] {
                let start = [x, 1.0, z];
                let end = [x + 5.0, -1.0, z];
                let expected = tree.triangles.iter().any(|t| swept_triangle(start, end, t));
                assert_eq!(tree.swept(start, end), expected, "{start:?}");
                assert_eq!(
                    tree.height([x, z], 1.0).is_some(),
                    tree.triangles.iter().any(|t| {
                        let local = t.map(|p| [(p[0] - x) as f32, (p[2] - z) as f32, p[1] as f32]);
                        triangle_z_at(&local, 0.0, 0.0).is_some()
                    })
                );
            }
        }
    }

    #[test]
    fn browser_tuning_uses_native_validation_and_signed_velocity() {
        use super::*;
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        let initial = world.tuning();
        assert_eq!(initial.len(), 17);
        assert_eq!(initial[16], 0.9);
        assert!(Voyage::parse_tuning(&initial[..16]).is_err());
        let mut invalid = initial.clone();
        invalid[0] = -1.0;
        assert!(Voyage::parse_tuning(&invalid).is_err());
        assert_eq!(world.tuning(), initial);
        let mut valid = initial;
        valid[11] = 10.0;
        world.tuning = Voyage::parse_tuning(&valid).unwrap();
        assert!(world.tuning.support_reach() >= 10.8);
        world.state.yaw = 0.0;
        world.state.velocity[2] = 4.0;
        assert_eq!(world.telemetry()[14], -4.0);
        world.state.velocity[2] = -4.0;
        assert_eq!(world.telemetry()[14], 4.0);
    }

    #[test]
    fn scene_bridge_cannot_turn_an_unloaded_expected_tile_into_ready_ground() {
        use super::*;
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        world.scene_mesh =
            CollisionTree::new(&[0.0, 0.0, 0.0, TILE, 0.0, 0.0, 0.0, 0.0, TILE]).unwrap();
        let surface = world.sample([10.0, 10.0]);
        assert_eq!(surface.availability, 1);
        assert!(surface.support().is_none());
    }

    #[test]
    fn airborne_thrust_from_rest_crosses_known_holes_without_arresting_the_fall() {
        for kind in ["terrain", "hole", "partial-hole", "impassable"] {
            let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
            let entry = &world.manifest.tiles[0];
            let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
            for chunk in &mut tile.chunks {
                if kind == "hole" {
                    chunk.holes = u16::MAX;
                }
                chunk.impassable = kind == "impassable";
            }
            if kind == "partial-hole" {
                tile.chunks[22].holes = u16::MAX;
            }
            world.resident.insert(0, tile);
            world.origin = [200.0, 64.0];
            world.state = State::new([0.0, 100.0, 0.0], -std::f32::consts::FRAC_PI_2).unwrap();
            if kind == "partial-hole" {
                let hs = world.motion_heights_at(world.global(), world.state.yaw, 100.0, true).unwrap();
                assert!(hs.iter().any(Option::is_none) && hs.iter().any(Option::is_some));
            }
            let mut falling = world.state;
            for _ in 0..60 {
                world.advance(Input { throttle: 1.0, boost: true, ..Default::default() }).unwrap();
                falling.step_with_tuning(Input::default(), [None; 4], FIXED_DT, &world.tuning).unwrap();
                assert_eq!(world.hold, 0, "{kind}");
                assert!(!world.state.grounded, "{kind}");
                assert!((world.state.velocity[1] - falling.velocity[1]).abs() < 0.001, "{kind}");
            }
            assert!(world.global()[0] > 205.0, "{kind}");
            assert!(world.state.velocity[0] > 20.0, "{kind}");
            assert!(world.state.position[1] < 98.0, "{kind}");
            assert!((world.state.boost_reserve - 0.8).abs() < 0.00001, "{kind}");
            if kind == "hole" {
                let before = world.state;
                assert!(world.restore_pose(&[world.global()[0], 100.0, 64.0, 0.0]).is_err());
                assert_eq!(world.state, before, "Save validation stays strict");
            }
        }
    }

    #[test]
    fn airborne_motion_preserves_unloaded_boundary_ground_and_solid_guards() {
        for (kind, hold) in [("missing", 1), ("outside", 2), ("ground-hole", 2), ("ground-impassable", 2), ("wall", 3)] {
            let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
            let entry = &world.manifest.tiles[0];
            let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
            for chunk in &mut tile.chunks {
                chunk.holes = if kind == "ground-hole" { u16::MAX } else { 0 };
                chunk.impassable = kind == "ground-impassable";
            }
            if kind != "missing" {
                world.resident.insert(0, tile);
            }
            world.origin = [200.0, if kind == "outside" { -64.0 } else { 64.0 }];
            let grounded = kind.starts_with("ground-");
            world.state = State::new([0.0, if grounded { 1.1 } else { 100.0 }, 0.0], 0.0).unwrap();
            world.state.grounded = grounded;
            if kind == "wall" {
                world.scene_bounds = vec![[199.0, 90.0, 63.0, 201.0, 110.0, 65.0]];
            }
            let before = world.state;
            world.advance(Input { throttle: 1.0, boost: true, ..Default::default() }).unwrap();
            assert_eq!(world.hold, hold, "{kind}");
            assert_eq!(world.state, before, "{kind}: failed motion is atomic");
        }
    }

    #[test]
    fn restore_accepts_reachable_high_hover_and_airborne_poses() {
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        world.origin = [1000.0, 64.0];
        world.state = State::new([0.0, 30.0, 0.0], 0.0).unwrap();
        world.tuning.hover_height = 30.0;
        for _ in 0..600 {
            world.advance(Input::default()).unwrap();
        }
        let saved = [1000.0, f64::from(world.state.position[1]), 64.0, 0.0];
        assert!(saved[1] > 29.9);
        world.restore_pose(&saved).unwrap();
        assert_eq!(f64::from(world.state.position[1]), saved[1]);
        world.restore_pose(&[1000.0, 2000.0, 64.0, 0.0]).unwrap();
        assert_eq!(world.state.position[1], 2000.0);
    }

    #[test]
    fn restore_queries_destination_height_over_holes_and_rejects_occupied_poses_atomically() {
        for shift in [0.0, 1.0e9] {
            let mut world = Voyage::from_manifest(fixture(shift)).unwrap();
            let entry = &world.manifest.tiles[0];
            let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
            for chunk in &mut tile.chunks {
                chunk.holes = u16::MAX;
            }
            world.resident.insert(0, tile);
            let x = shift + 200.0;
            world.scene_mesh = CollisionTree::new(&[
                x - 20.0,
                20.0,
                40.0,
                x + 20.0,
                20.0,
                40.0,
                x - 20.0,
                20.0,
                90.0,
                x + 20.0,
                20.0,
                40.0,
                x + 20.0,
                20.0,
                90.0,
                x - 20.0,
                20.0,
                90.0,
            ])
            .unwrap();
            assert!(
                world.heights([x, 64.0], 0.0).is_err(),
                "Old body Y cannot see the destination deck"
            );
            world.restore_pose(&[x, 21.1, 64.0, 0.0]).unwrap();
            assert_eq!(world.global(), [x, 64.0]);
            world.state.velocity = [12.0, 3.0, 4.0];
            world.state.bank = 0.2;
            world.state.boost_reserve = 0.5;
            let previous = (world.state, world.origin, world.hold, world.rebases);
            for pose in [
                vec![x, 20.4, 64.0, 0.0],
                vec![x, 19.0, 64.0, 0.0],
                vec![x, f64::MAX, 64.0, 0.0],
                vec![x, 21.1, 64.0, f64::NAN],
                vec![x, 21.1, 64.0],
            ] {
                assert!(world.restore_pose(&pose).is_err());
                assert_eq!(
                    (world.state, world.origin, world.hold, world.rebases),
                    previous
                );
            }
            world.resident.clear();
            assert!(world.restore_pose(&[x, 21.1, 64.0, 0.0]).is_err());
            assert_eq!(
                (world.state, world.origin, world.hold, world.rebases),
                previous
            );
        }
    }

    use super::*;

    #[test]
    fn browser_defaults_match_requested_handling_and_reset_preserves_overrides() {
        let mut world=Voyage::from_manifest(fixture(0.0)).unwrap();
        let tile=&world.manifest.tiles[0];
        world.resident.insert(0,crate::world::tests::flat_tile(tile.x,tile.y));
        assert_eq!(world.tuning(),vec![150.0,300.0,50.0,50.0,30.0,0.25,2.2,10.0,8.0,1.5,1.3,3.0,90.0,18.0,24.0,7.0,0.9]);
        world.initialize_spawn().unwrap();
        assert_eq!(world.state.position[1],3.0);
        world.tuning.hover_height=7.0;
        world.tuning.max_speed=42.0;
        world.reset();world.initialize_spawn().unwrap();
        assert_eq!(world.state.position[1],7.0);
        assert_eq!(world.tuning.max_speed,42.0);
        assert_eq!(Tuning::default().max_speed,36.0,"Native defaults are not changed by the web adapter");
    }

    #[test]
    fn authored_bounds_block_swept_thin_walls_but_not_rooftop_support() {
        let wall = [5.0, 0.0, -2.0, 5.01, 4.0, 2.0];
        assert!(swept_box([0.0, 1.0, 0.0], [10.0, 1.0, 0.0], wall));
        assert!(!swept_box([0.0, 5.1, 0.0], [10.0, 5.1, 0.0], wall));
        assert!(!swept_box([0.0, 1.0, 5.0], [10.0, 1.0, 5.0], wall));
    }

    pub fn fixture(shift: f64) -> Manifest {
        let mut m = Manifest {
            version: 1,
            label: "test".into(),
            regions: vec![
                Region {
                    id: "west".into(),
                    map: "Kalimdor".into(),
                    tile_origin: [41, 33],
                    tile_count: [1, 1],
                    placement: [shift, 0.0],
                },
                Region {
                    id: "east".into(),
                    map: "Azeroth".into(),
                    tile_origin: [28, 51],
                    tile_count: [1, 1],
                    placement: [shift + 2000.0, 0.0],
                },
            ],
            tiles: vec![],
            horizons: vec![],
            world_bounds: None,
            ocean: [shift + TILE, 0.0, shift + 2000.0, TILE],
            sea_level: 0.0,
            spawn: [shift + 200.0, 1.1, 64.0, 0.0],
            destination: [shift + 2200.0, 64.0],
        };
        for (region, r) in m.regions.iter().enumerate() {
            m.tiles.push(TileEntry {
                region,
                x: r.tile_origin[0],
                y: r.tile_origin[1],
                file: format!("{}_{}_{}.adt", r.map, r.tile_origin[0], r.tile_origin[1]),
                bytes: 1,
                sha256: "a".repeat(64),
            });
        }
        m
    }

    #[test]
    fn source_placement_and_unloaded_terrain_are_distinct_from_ocean() {
        let m = fixture(1.0e9);
        m.validate().unwrap();
        assert_eq!(
            m.regions[0].source([1.0e9 + 200.0, 64.0]),
            [-597.3333, -5000.0, 0.0]
        );
        let world = Voyage::from_manifest(m).unwrap();
        assert_eq!(world.sample([1.0e9 + 200.0, 64.0]).availability, 1);
        assert_eq!(world.sample([1.0e9 + 1000.0, 64.0]).water, Some(0.0));
        assert_eq!(world.sample([1.0e9 + 1000.0, -1.0]).availability, 2);
    }

    #[test]
    fn floating_origin_preserves_global_motion_at_billion_yard_offset() {
        let mut a = Voyage::from_manifest(fixture(0.0)).unwrap();
        let mut b = Voyage::from_manifest(fixture(1.0e9)).unwrap();
        for (world, shift) in [(&mut a, 0.0), (&mut b, 1.0e9)] {
            world.origin = [shift + 700.0, 64.0];
            world.state = State::new([0.0, 1.1, 0.0], -std::f32::consts::FRAC_PI_2).unwrap();
        }
        for _ in 0..3000 {
            let input = Input {
                throttle: 1.0,
                ..Default::default()
            };
            a.advance(input).unwrap();
            b.advance(input).unwrap();
        }
        assert!(a.rebases >= 2);
        assert!((a.global()[0] - (b.global()[0] - 1.0e9)).abs() < 0.001);
        assert!(b.state.position[0].abs() < 256.0);
        assert_eq!(a.sample(a.global()).water, Some(0.0));
    }

    #[test]
    fn bad_manifest_cannot_turn_missing_land_into_ocean() {
        let mut m = fixture(0.0);
        m.ocean[0] = 0.0;
        assert!(m.validate().is_err());
        m = fixture(0.0);
        m.tiles.pop();
        assert!(m.validate().is_err());
        m = fixture(0.0);
        m.regions[0].placement[0] = f64::NAN;
        assert!(m.validate().is_err());
    }

    #[test]
    fn full_world_bounds_bracket_ocean_without_granting_wdl_collision() {
        let mut m = fixture(0.0);
        m.version = 2;
        m.horizons = vec![
            HorizonEntry {
                region: 0,
                file: "Kalimdor.wdl".into(),
                bytes: 100,
                sha256: "a".repeat(64),
                source_bounds: [40, 32, 43, 34],
            },
            HorizonEntry {
                region: 1,
                file: "Azeroth.wdl".into(),
                bytes: 100,
                sha256: "b".repeat(64),
                source_bounds: [27, 50, 30, 52],
            },
        ];
        m.ocean = [2.0 * TILE, -TILE, 2000.0 - TILE, TILE];
        m.validate().unwrap();
        let world = Voyage::from_manifest(m.clone()).unwrap();
        assert_eq!(world.sample([-100.0, 100.0]).availability, 2);
        assert_eq!(world.sample([1200.0, 100.0]).water, Some(0.0));
        m.regions[1].placement[0] = 1000.0;
        assert!(m.validate().is_err());
    }
}
