//! Translation-only regions keep authored WoW geometry separate from global and local physics.
use crate::horizon::Horizon;
use benilla_formats::{
    adt_to_tile_mesh, adt_to_tile_mesh_observed, triangle_z_at, LiquidKind, TerrainBuildPhase,
    TileMesh, TileMeshBuilder,
};
use flats_racer_physics::{Input, State, Tuning, FIXED_DT, PROBE_OFFSETS};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

pub const TILE: f64 = 1600.0 / 3.0;
// Hard cap on resident collision tiles; the JS budget (memory-budget.js residentTileCap) chooses how many to use.
pub const MAX_RESIDENT: usize = 32;
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

mod collision;
mod math;
mod types;
pub use math::whirlpool_dip;
use math::{contains, swept_box, swept_triangle};
use collision::CollisionTree;
pub use types::{HorizonEntry, Manifest, Region, TileEntry};

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

/// Engine durability settings and the little memory the damage rules need between ticks.
#[derive(Clone, Copy)]
struct Durability {
    on: bool,
    lethal: f32,
    pre_speed: f32,
    hit_side: usize,
    hot_side: usize,
    hot: bool,
}

impl Default for Durability {
    fn default() -> Self {
        Self {
            on: true,
            lethal: 100.0,
            pre_speed: 0.0,
            hit_side: 0,
            hot_side: 0,
            hot: false,
        }
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
    scene_water: CollisionTree,
    /// [centre x, centre z, radius, depth]; see whirlpool_dip.
    whirlpool: Option<[f64; 4]>,
    /// Debug crash wreck and the global x/z its local coordinates are relative to.
    wreck: Option<(flats_racer_physics::wreck::Wreck, [f64; 2])>,
    scene_parts: HashMap<u32, CollisionTree>,
    state: State,
    pub(crate) tuning: Tuning,
    origin: [f64; 2],
    rebases: u32,
    hold: u8,
    dur: Durability,
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
                boost_acceleration: 30.0,
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
            scene_water: CollisionTree::default(),
            whirlpool: None,
            wreck: None,
            scene_parts: HashMap::new(),
            rebases: 0,
            hold: 1,
            dur: Durability::default(),
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
                            }) || (matches!(liquid.kind, LiquidKind::Still | LiquidKind::Ocean)
                                && liquid.depths.get(i as usize).is_none_or(|depth| {
                                    !depth.is_finite() || !(0.0..=1.0).contains(depth)
                                }))
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

    /// Open-ocean surface height: sea level minus the whirlpool dip. Only the unauthored ocean branches use it.
    fn sea_height(&self, p: [f64; 2]) -> f32 {
        self.manifest.sea_level - self.whirlpool.map_or(0.0, |w| whirlpool_dip(p, w))
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
        } else if self.manifest.version != 4 && contains(self.manifest.ocean, p) {
            result.water = Some(self.sea_height(p));
            result.availability = 0;
            result.region = -1;
        } else if self.manifest.version == 3 {
            if let Some(region) = self.exterior_ocean(p) {
                result.water = Some(self.sea_height(p));
                result.availability = 0;
                result.region = region as i32;
            }
        }
        if result.availability != 1 {
            // Authored WMO liquid (canals) rides like ADT water; a 2 yd ceiling keeps a shallow dip supported.
            if let Some(h) = self.scene_water.height(p, f64::from(body_y) + 2.0) {
                result.water = Some(result.water.map_or(h as f32, |w| w.max(h as f32)));
                result.availability = 0;
            }
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
                *height = Surface {
                    solid: false,
                    ..surface
                }
                .support();
                if height.is_none_or(|h| body_y - h <= self.tuning.support_reach()) {
                    return Err(2);
                }
            }
        }
        Ok(heights)
    }

    /// Overheating wears the engines (the hotter side alternates per episode, 60/40) and a rising obstacle contact (hold 3)
    /// damages one engine (alternating) by the speed just before it.
    fn durability_step(&mut self, hold_before: u8, powered: f32) {
        let d = &mut self.dur;
        let speed = self.state.velocity[0].hypot(self.state.velocity[2]);
        if !d.on {
            d.pre_speed = speed;
            return;
        }
        let rate = flats_racer_physics::heat_damage_rate(self.state.heat) * FIXED_DT * (1.0-powered);
        let hot = rate > 0.0;
        if d.hot && !hot {
            d.hot_side ^= 1;
        }
        d.hot = hot;
        let h = &mut self.state.health;
        h[d.hot_side] = (h[d.hot_side] - rate * 0.6).max(0.0);
        h[d.hot_side ^ 1] = (h[d.hot_side ^ 1] - rate * 0.4).max(0.0);
        if self.hold == 3 && hold_before != 3 {
            let side = d.hit_side;
            d.hit_side ^= 1;
            h[side] =
                (h[side] - flats_racer_physics::impact_damage(d.pre_speed, d.lethal)).max(0.0);
        }
        if self.hold != 3 {
            d.pre_speed = speed;
        }
    }

    fn restore_pose(&mut self, pose: &[f64]) -> Result<(), String> {
        if pose.len() != 4 || pose.iter().any(|v| !v.is_finite()) {
            return Err("Save requires a finite global pose".into());
        }
        let mut state =
            State::new([0.0, pose[1] as f32, 0.0], pose[3] as f32).map_err(|e| e.to_string())?;
        // Teleporting (unstuck, load) does not cool the engines.
        state.heat = self.state.heat;
        state.health = self.state.health;
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
        if !input.throttle.is_finite() || !input.steer.is_finite() || !input.pitch.is_finite() {
            return Err("Throttle, steer and pitch must be finite".into());
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
            + f64::from(self.tuning.boost_acceleration) + f64::from(flats_racer_physics::POWERED_THRUST))
            * f64::from(self.tuning.air_control).max(1.0);
        (speed + thrust * duration).min(f64::from(self.tuning.boost_max_speed)) * duration
    }

    fn advance_substep(&mut self, input: Input, dt: f32) -> Result<(), String> {
        let p = self.global();
        let before = self.state;
        let heights =
            match self.motion_heights_at(p, before.yaw, before.position[1], !before.grounded) {
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
                    (hs.iter().flatten().sum::<f32>() - heights.iter().flatten().sum::<f32>())
                        / (4.0 * dt)
                } else {
                    0.0
                }
            })
            .min(SUPPORT_RISE / dt);
        self.state
            .step_with_surface_motion(
                input,
                heights.map(|h| {
                    h.and_then(|h| {
                        let distance = (before.position[1] - h).max(0.0);
                        (distance <= self.tuning.support_reach()).then_some(distance)
                    })
                }),
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
        match self.motion_heights_at(
            next,
            self.state.yaw,
            swept_end[1] as f32,
            !self.state.grounded,
        ) {
            Ok(hs)
                if hs.iter().zip(heights).all(|(h, old)| {
                    h.is_none_or(|h| {
                        old.is_some_and(|old| h - old < SUPPORT_RISE)
                            || f64::from(h) + HULL_HALF_HEIGHT <= swept_start[1].min(swept_end[1])
                    })
                }) =>
            {
                let floor =
                    hs.into_iter().flatten().fold(f32::NEG_INFINITY, f32::max) + FLOOR_CLEARANCE;
                let corrected_end = [swept_end[0], f64::from(floor), swept_end[2]];
                if swept_end[1] < corrected_end[1]
                    && (self
                        .scene_bounds
                        .iter()
                        .any(|b| swept_box(swept_end, corrected_end, *b))
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
        let vertical_thrust = (f64::from(self.tuning.acceleration) + f64::from(self.tuning.boost_acceleration) + f64::from(flats_racer_physics::POWERED_THRUST))
            * f64::from(self.tuning.air_control).max(1.0)
            * f64::from(flats_racer_physics::PITCH_LIMIT).sin();
        let acceleration = (f64::from(self.tuning.spring) * f64::from(self.tuning.hover_height))
            .max(f64::from(self.tuning.gravity)) + vertical_thrust;
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

    /// Maelstrom dip (centre x/z in global yd, radius, depth), shared with browser/clouds.js WHIRLPOOL_DIP; zero depth clears it.
    pub fn set_whirlpool(
        &mut self,
        x: f64,
        z: f64,
        radius: f64,
        depth: f64,
    ) -> Result<(), JsValue> {
        if ![x, z, radius, depth].iter().all(|v| v.is_finite())
            || x.abs() > 1.0e7
            || z.abs() > 1.0e7
            || !(1.0..=20_000.0).contains(&radius)
            || !(0.0..=2_000.0).contains(&depth)
        {
            return Err(JsValue::from_str("Invalid whirlpool"));
        }
        self.whirlpool = (depth > 0.0).then_some([x, z, radius, depth]);
        Ok(())
    }

    /// Indexed WMO liquid-surface triangles (global east/up/south); replaces the previous set.
    pub fn set_scene_water(&mut self, vertices: &[f64]) -> Result<(), JsValue> {
        self.scene_water = CollisionTree::new(vertices).map_err(JsValue::from_str)?;
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

    pub fn tick(&mut self, throttle: f32, steer: f32, flags: u32, pitch: Option<f32>, powered: Option<f32>) -> Result<(), JsValue> {
        let before = self.hold;
        let result = self
            .advance(Input {
                throttle,
                steer,
                pitch: pitch.unwrap_or(0.0),
                powered: powered.unwrap_or(0.0),
                brake: flags & 1 != 0,
                boost: flags & 2 != 0,
                drift: flags & 4 != 0,
                jump: flags & 8 != 0,
            })
            .map_err(|e| JsValue::from_str(&e));
        if result.is_ok() {
            let protection=if flags & 2 != 0 && flags & 1 == 0 && throttle>0.0 {powered.unwrap_or(0.0)} else {0.0};
            self.durability_step(before,protection);
        }
        result
    }

    /// A fresh craft after a wreck: both engines whole and cool (restore_pose alone keeps both, for Unstuck).
    pub fn repair(&mut self) {
        self.state.health = [1.0; 2];
        self.state.heat = 0.0;
    }

    /// Engine durability on/off and the instant-wreck speed (yd/s; impact damage reaches a whole engine there).
    pub fn set_durability(&mut self, on: bool, lethal_speed: f32) {
        self.dur.on = on;
        self.dur.lethal = lethal_speed;
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
            f64::from(self.state.heat),
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
            f64::from(self.state.health[0]),
            f64::from(self.state.health[1]),
            f64::from(self.state.pitch),
        ]
    }

    /// The `AreaTable` id under the car, or 0 when no resident terrain covers it (open ocean).
    pub fn area(&self) -> u32 {
        self.area_at(self.global()[0], self.global()[1])
    }

    /// The AreaTable id at a global position (x, z), 0 where no resident terrain covers it.
    pub fn area_at(&self, x: f64, z: f64) -> u32 {
        let p = [x, z];
        let Some(index) = self.locate(p) else {
            return 0;
        };
        let Some(tile) = self.resident.get(&index) else {
            return 0;
        };
        let wow = self.manifest.regions[self.manifest.tiles[index].region].source(p);
        tile.chunks.iter().find_map(|c| c.area_at(wow)).unwrap_or(0)
    }

    /// Debug crash: split the craft into box parts and tumble them against the terrain. `rot` is the model-to-world
    /// rotation (3 unit columns), `parts` is `[cx,cy,cz,hx,hy,hz]` per part (pod first, then engines).
    pub fn wreck_start(
        &mut self,
        pos: &[f64],
        rot: &[f32],
        scale: f32,
        vel: &[f32],
        parts: &[f32],
        seed: u32,
    ) -> Result<(), JsValue> {
        use flats_racer_physics::wreck::{PartSpec, Wreck};
        if pos.len() != 3
            || rot.len() != 9
            || vel.len() != 3
            || parts.is_empty()
            || !parts.len().is_multiple_of(6)
            || parts.len() > 36
            || !pos.iter().all(|v| v.is_finite())
            || !rot.iter().chain(vel).chain(parts).all(|v| v.is_finite())
            || scale <= 0.0
            || !scale.is_finite()
        {
            return Err(JsValue::from_str("Invalid wreck input"));
        }
        let specs: Vec<PartSpec> = parts
            .chunks(6)
            .map(|c| PartSpec {
                center: [c[0], c[1], c[2]],
                half: [c[3], c[4], c[5]],
            })
            .collect();
        let cols = [
            [rot[0], rot[1], rot[2]],
            [rot[3], rot[4], rot[5]],
            [rot[6], rot[7], rot[8]],
        ];
        let origin = [pos[0], pos[2]];
        self.state.health = [1.0; 2]; // the wreck replaces the craft: both engines are whole again
        self.wreck = Some((
            Wreck::new(
                [0.0, pos[1] as f32, 0.0],
                cols,
                scale,
                [vel[0], vel[1], vel[2]],
                &specs,
                seed,
            ),
            origin,
        ));
        Ok(())
    }

    /// Advance the wreck `steps` fixed steps; returns one pose record (global x/z) per 2 steps (60 Hz).
    pub fn wreck_run(&mut self, steps: u32) -> Vec<f32> {
        let Some((mut wreck, origin)) = self.wreck.take() else {
            return vec![];
        };
        let floor = wreck.bodies[0].pos[1] - 2.0;
        let mut out = vec![];
        let mut ground = |x: f32, z: f32| {
            let s = self.sample([origin[0] + f64::from(x), origin[1] + f64::from(z)]);
            (s.support().unwrap_or(floor), s.on_water())
        };
        for i in 0..steps.min(240) {
            wreck.step(&mut ground);
            if i % 2 == 1 {
                for b in wreck.bodies.iter() {
                    out.extend([
                        (f64::from(b.pos[0]) + origin[0]) as f32,
                        b.pos[1],
                        (f64::from(b.pos[2]) + origin[1]) as f32,
                        b.rot[0],
                        b.rot[1],
                        b.rot[2],
                        b.rot[3],
                    ]);
                }
            }
        }
        out.extend(wreck.connected.iter().map(|&c| f32::from(c)));
        self.wreck = Some((wreck, origin));
        out
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

    pub fn pod_velocity(&self) -> Vec<f32> {
        self.state.velocity.to_vec()
    }

    /// Advance the same heat and durability rules for accepted externally integrated ticks.
    pub fn pod_engine_step(&mut self, throttle: f32, flags: u32, powered: f32) -> Result<(), JsValue> {
        if !throttle.is_finite() || !(0.0..=1.0).contains(&powered) {
            return Err(JsValue::from_str("Invalid pod engine input"));
        }
        if flags & 2 != 0 && flags & 1 == 0 && throttle > 0.0 {
            self.state.heat = (self.state.heat + flats_racer_physics::HEAT_RISE_PER_SEC * FIXED_DT * (1.0-powered)).min(1.0);
        } else if flags & 2 == 0 {
            self.state.heat = (self.state.heat - flats_racer_physics::HEAT_COOL_PER_SEC * FIXED_DT).max(0.0);
        }
        self.durability_step(self.hold,powered);
        Ok(())
    }

    pub fn pod_engine_state(&mut self, values: &[f32]) -> Result<(), JsValue> {
        if values.len()!=3 || values.iter().any(|v| !(0.0..=1.0).contains(v)) {
            return Err(JsValue::from_str("Invalid pod engine state"));
        }
        self.state.heat=values[0];
        self.state.health=[values[1],values[2]];
        Ok(())
    }

    /// Sweep externally integrated launch motion against resident scenery and ground.
    pub fn pod_sweep(&self, from: &[f64], to: &[f64]) -> Result<u32, JsValue> {
        if from.len() != 3 || to.len() != 3 || from.iter().chain(to).any(|n| !n.is_finite()) {
            return Err(JsValue::from_str("Invalid pod sweep"));
        }
        let a = [from[0], from[1], from[2]];
        let b = [to[0], to[1], to[2]];
        if self.scene_mesh.swept(a, b) || self.scene_bounds.iter().any(|bounds| swept_box(a, b, *bounds)) {
            return Ok(3);
        }
        let count = ((b[0]-a[0]).hypot(b[2]-a[2]) / SUPPORT_TRAVEL).ceil().max(1.0);
        if count > 768.0 { return Err(JsValue::from_str("Pod sweep exceeds collision work budget")); }
        for i in 0..=count as u32 {
            let t = f64::from(i) / count;
            let p = [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
            let surface = self.sample_at([p[0],p[2]],p[1] as f32);
            if surface.availability == 1 { return Ok(1); }
            if surface.support().is_some_and(|h| p[1] < f64::from(h+FLOOR_CLEARANCE)) { return Ok(2); }
        }
        Ok(0)
    }

    pub fn pod_land(&mut self, pose: &[f64], velocity: &[f32]) -> Result<(), JsValue> {
        if velocity.len()!=3 || velocity.iter().any(|n| !n.is_finite()) {
            return Err(JsValue::from_str("Invalid landing velocity"));
        }
        self.restore_pose(pose).map_err(|e| JsValue::from_str(&e))?;
        self.state.velocity.copy_from_slice(velocity);
        Ok(())
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

    /// Local positions, normal or water [ramp, 1, 1], then material (0 ground, 2 water).
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
        let mut emit = |positions: &[[f32; 3]],
                        depths: Option<&[f32]>,
                        indices: &[u32],
                        material: f32|
         -> Result<(), String> {
            for t in indices.as_chunks::<3>().0 {
                let vertices = t.map(|i| positions.get(i as usize).copied());
                let p = [
                    vertices[0].ok_or("Invalid authored geometry index")?,
                    vertices[1].ok_or("Invalid authored geometry index")?,
                    vertices[2].ok_or("Invalid authored geometry index")?,
                ]
                .map(|v| {
                    [
                        (nw[1] - f64::from(v[1])) as f32,
                        v[2],
                        (nw[0] - f64::from(v[0])) as f32,
                    ]
                });
                let n = if material == 2.0 {
                    None
                } else {
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
                    Some(n)
                };
                for (vertex, v) in p.into_iter().enumerate() {
                    out.extend(v);
                    let vertex_n = if let Some(n) = n {
                        n
                    } else {
                        let depths = depths.ok_or("Missing authored liquid depth ramp")?;
                        let depth = depths
                            .get(t[vertex] as usize)
                            .ok_or("Missing authored liquid depth ramp")?;
                        if !depth.is_finite() || !(0.0..=1.0).contains(depth) {
                            return Err("Invalid authored liquid depth ramp".into());
                        }
                        [*depth, 1.0, 1.0]
                    };
                    out.extend(vertex_n);
                    out.push(material);
                }
            }
            Ok(())
        };
        for chunk in &tile.chunks {
            emit(&chunk.positions, None, &chunk.indices, 0.0).map_err(|e| JsValue::from_str(&e))?;
            for liquid in &chunk.liquids {
                if matches!(liquid.kind, LiquidKind::Still | LiquidKind::Ocean) {
                    emit(
                        &liquid.positions,
                        Some(&liquid.depths),
                        &liquid.indices,
                        2.0,
                    )
                    .map_err(|e| JsValue::from_str(&e))?;
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
pub(crate) mod tests;
