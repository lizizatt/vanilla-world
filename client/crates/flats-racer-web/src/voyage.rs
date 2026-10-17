//! Translation-only regions keep authored WoW geometry separate from global and local physics.
use crate::horizon::Horizon;
use benilla_formats::{adt_to_tile_mesh, triangle_z_at, LiquidKind, TileMesh};
use flats_racer_physics::{Input, State, Tuning, FIXED_DT, PROBE_OFFSETS};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

pub const TILE: f64 = 1600.0 / 3.0;
pub const MAX_RESIDENT: usize = 3;

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
        if !matches!(self.version, 1 | 2)
            || (self.version == 1 && !self.horizons.is_empty())
            || (self.version == 2 && self.horizons.len() != 2)
            || self.regions.len() != 2
            || self.tiles.is_empty()
            || self.tiles.len() > 16
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
                || r.tile_count.iter().any(|&n| n > 4)
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
        let a = self.regions[0].bounds();
        let b = self.regions[1].bounds();
        let expected = if self.version == 1 {
            [a[2], a[1], b[0], a[3]]
        } else {
            let bounds = |i: usize| {
                let r = &self.regions[i];
                let h = &self.horizons[i];
                [
                    r.placement[0]
                        + (f64::from(h.source_bounds[0]) - f64::from(r.tile_origin[0])) * TILE,
                    r.placement[1]
                        + (f64::from(h.source_bounds[1]) - f64::from(r.tile_origin[1])) * TILE,
                    r.placement[0]
                        + (f64::from(h.source_bounds[2]) - f64::from(r.tile_origin[0])) * TILE,
                    r.placement[1]
                        + (f64::from(h.source_bounds[3]) - f64::from(r.tile_origin[1])) * TILE,
                ]
            };
            let (west, east) = (bounds(0), bounds(1));
            if west[2] >= east[0] {
                return Err("Full authored continent bounds overlap".into());
            }
            [west[2], west[1].min(east[1]), east[0], west[3].max(east[3])]
        };
        if self.regions[0].id == self.regions[1].id
            || a[2] >= b[0]
            || (a[1] - b[1]).abs() > 0.001
            || (a[3] - b[3]).abs() > 0.001
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
                || t.bytes == 0
                || t.bytes > 16 * 1024 * 1024
                || t.sha256.len() != 64
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

    fn locate(&self, p: [f64; 2]) -> Option<usize> {
        self.tiles.iter().enumerate().find_map(|(i, _)| {
            let a = self.tile_placement(i);
            contains([a[0], a[1], a[0] + TILE, a[1] + TILE], p).then_some(i)
        })
    }
}

/// Vehicle-neutral surface query. No WMO/M2 solids are imported yet.
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
    state: State,
    origin: [f64; 2],
    rebases: u32,
    hold: u8,
}

impl Voyage {
    pub fn from_manifest(manifest: Manifest) -> Result<Self, String> {
        manifest.validate()?;
        let mut world = Self {
            state: State::new(
                [0.0, manifest.spawn[1] as f32, 0.0],
                manifest.spawn[3] as f32,
            )
            .map_err(|e| e.to_string())?,
            origin: [manifest.spawn[0], manifest.spawn[2]],
            manifest,
            resident: HashMap::new(),
            horizons: HashMap::new(),
            rebases: 0,
            hold: 1,
        };
        world.rebase();
        Ok(world)
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
        let mut result = Surface {
            ground: None,
            water: None,
            solid: false,
            availability: 2,
            region: -2,
        };
        if let Some(index) = self.manifest.locate(p) {
            let region = self.manifest.tiles[index].region;
            result.region = region as i32;
            let Some(tile) = self.resident.get(&index) else {
                result.availability = 1;
                return result;
            };
            let wow = self.manifest.regions[region].source(p);
            for chunk in &tile.chunks {
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
        }
        result
    }

    fn heights(&self, p: [f64; 2], yaw: f32) -> Result<[f32; 4], u8> {
        let (sin, cos) = yaw.sin_cos();
        let mut heights = [0.0; 4];
        for (i, [x, _, z]) in PROBE_OFFSETS.into_iter().enumerate() {
            let surface = self.sample([
                p[0] + f64::from(x * cos + z * sin),
                p[1] + f64::from(-x * sin + z * cos),
            ]);
            heights[i] = surface
                .support()
                .ok_or(if surface.availability == 1 { 1 } else { 2 })?;
        }
        Ok(heights)
    }

    fn advance(&mut self, input: Input) -> Result<(), String> {
        if !input.throttle.is_finite() || !input.steer.is_finite() {
            return Err("Throttle and steer must be finite".into());
        }
        let p = self.global();
        let before = self.state;
        let heights = match self.heights(p, before.yaw) {
            Ok(h) => h,
            Err(hold) => {
                self.hold = hold;
                self.state.velocity = [0.0; 3];
                return Ok(());
            }
        };
        let projected = [
            p[0] + f64::from(before.velocity[0] * FIXED_DT),
            p[1] + f64::from(before.velocity[2] * FIXED_DT),
        ];
        let rise = self.heights(projected, before.yaw).map_or(0.0, |hs| {
            (hs.iter().sum::<f32>() - heights.iter().sum::<f32>()) / (4.0 * FIXED_DT)
        });
        self.state
            .step_with_surface_motion(
                input,
                heights.map(|h| Some((before.position[1] - h).max(0.0))),
                rise,
                FIXED_DT,
                &Tuning::default(),
            )
            .map_err(|e| e.to_string())?;
        let next = [
            p[0] + f64::from(self.state.velocity[0] * FIXED_DT),
            p[1] + f64::from(self.state.velocity[2] * FIXED_DT),
        ];
        match self.heights(next, self.state.yaw) {
            Ok(hs) if hs.iter().zip(heights).all(|(h, old)| h - old < 0.6) => {
                for i in 0..3 {
                    self.state.position[i] += self.state.velocity[i] * FIXED_DT;
                }
                let floor = hs.into_iter().fold(f32::NEG_INFINITY, f32::max) + 0.25;
                if self.state.position[1] < floor {
                    self.state.position[1] = floor;
                    self.state.velocity[1] = self.state.velocity[1].max(0.0);
                }
                self.hold = 0;
                self.rebase();
            }
            result => {
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
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<Voyage, JsValue> {
        let manifest: Manifest =
            serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        Self::from_manifest(manifest).map_err(|e| JsValue::from_str(&e))
    }

    pub fn add_tile(&mut self, index: usize, bytes: &[u8]) -> Result<(), JsValue> {
        let fail = |s: &str| JsValue::from_str(s);
        let entry = self
            .manifest
            .tiles
            .get(index)
            .ok_or_else(|| fail("Unknown tile"))?;
        if bytes.len() != entry.bytes
            || (!self.resident.contains_key(&index) && self.resident.len() >= MAX_RESIDENT)
        {
            return Err(fail("Tile size/resident limit rejected"));
        }
        let tile = adt_to_tile_mesh(bytes).map_err(|e| fail(&e.to_string()))?;
        let northwest = [
            -(f64::from(entry.y) - 32.0) * TILE,
            -(f64::from(entry.x) - 32.0) * TILE,
        ];
        if tile.chunks.len() != 256
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
            })
        {
            return Err(fail("Tile geometry does not match its source coordinates"));
        }
        self.resident.insert(index, tile);
        Ok(())
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
        if pose.len() != 4 || pose.iter().any(|v| !v.is_finite()) {
            return Err(JsValue::from_str("Save requires a finite global pose"));
        }
        let hs = self
            .heights([pose[0], pose[2]], pose[3] as f32)
            .map_err(|_| {
                JsValue::from_str("Saved location is unloaded or outside supported surfaces")
            })?;
        let floor = f64::from(hs.into_iter().fold(f32::NEG_INFINITY, f32::max));
        if pose[1] < floor + 0.2 || pose[1] > floor + 20.0 {
            return Err(JsValue::from_str("Saved height is outside supported range"));
        }
        let state = State::new([0.0, pose[1] as f32, 0.0], pose[3] as f32)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.origin = [pose[0], pose[2]];
        self.state = state;
        self.hold = 0;
        Ok(())
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
        Ok(out)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

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
