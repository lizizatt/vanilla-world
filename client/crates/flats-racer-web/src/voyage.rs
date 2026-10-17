//! Translation-only regions keep authored WoW geometry separate from global and local physics.
use crate::horizon::Horizon;
use benilla_formats::{LiquidKind, TileMesh, adt_to_tile_mesh, triangle_z_at};
use flats_racer_physics::{FIXED_DT, Input, PROBE_OFFSETS, State, Tuning};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

pub const TILE: f64 = 1600.0 / 3.0;
pub const MAX_RESIDENT: usize = 4;

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
    state: State,
    tuning: Tuning,
    origin: [f64; 2],
    rebases: u32,
    hold: u8,
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
            if let Some(height) = self
                .scene_mesh
                .height(p, f64::from(self.state.position[1]) + 0.6)
            {
                result.ground = Some(
                    result
                        .ground
                        .map_or(height as f32, |g| g.max(height as f32)),
                );
                result.availability = 0;
            }
            for b in &self.scene_bounds {
                if p[0] >= b[0] && p[0] <= b[3] && p[1] >= b[2] && p[1] <= b[5] {
                    if f64::from(self.state.position[1]) >= b[4] - 0.1 {
                        result.ground =
                            Some(result.ground.map_or(b[4] as f32, |g| g.max(b[4] as f32)));
                        result.availability = 0;
                    } else if f64::from(self.state.position[1]) + 0.6 >= b[1] {
                        result.solid = true;
                    }
                }
            }
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

    pub(crate) fn advance(&mut self, input: Input) -> Result<(), String> {
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
                heights.map(|h| {
                    let distance = (before.position[1] - h).max(0.0);
                    (distance <= self.tuning.support_reach()).then_some(distance)
                }),
                rise,
                FIXED_DT,
                &self.tuning,
            )
            .map_err(|e| e.to_string())?;
        let next = [
            p[0] + f64::from(self.state.velocity[0] * FIXED_DT),
            p[1] + f64::from(self.state.velocity[2] * FIXED_DT),
        ];
        let swept_start = [p[0], f64::from(before.position[1]), p[1]];
        let swept_end = [
            next[0],
            f64::from(before.position[1] + self.state.velocity[1] * FIXED_DT),
            next[1],
        ];
        if self
            .scene_bounds
            .iter()
            .any(|b| swept_box(swept_start, swept_end, *b))
            || self.scene_mesh.swept(swept_start, swept_end)
        {
            self.state = before;
            self.state.velocity = [0.0; 3];
            self.hold = 3;
            return Ok(());
        }
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

impl CollisionTree {
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
        if !tree.triangles.is_empty() {
            tree.build(0..tree.triangles.len());
        }
        Ok(tree)
    }

    fn build(&mut self, range: std::ops::Range<usize>) -> usize {
        let mut bounds = [f64::INFINITY; 6];
        bounds[3..].fill(f64::NEG_INFINITY);
        for triangle in &self.triangles[range.clone()] {
            for p in triangle {
                for a in 0..3 {
                    bounds[a] = bounds[a].min(p[a]);
                    bounds[a + 3] = bounds[a + 3].max(p[a]);
                }
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
            self.triangles[range.clone()].select_nth_unstable_by(half, |a, b| {
                a.iter()
                    .map(|v| v[axis])
                    .sum::<f64>()
                    .total_cmp(&b.iter().map(|v| v[axis]).sum::<f64>())
            });
            let middle = range.start + half;
            let left = self.build(range.start..middle);
            let right = self.build(middle..range.end);
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
        let radius = axis[0].abs() * 1.1 + axis[1].abs() * 0.5 + axis[2].abs() * 1.1;
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
    if start[1].min(end[1]) - 0.5 >= bounds[4] {
        return false;
    }
    let mut enter: f64 = 0.0;
    let mut exit: f64 = 1.0;
    for axis in 0..3 {
        let margin = if axis == 1 { 0.5 } else { 1.1 };
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

    /// Indexed authored collision triangles in global east/up/south coordinates.
    pub fn set_scene_mesh(&mut self, vertices: &[f64]) -> Result<(), JsValue> {
        self.scene_mesh = CollisionTree::new(vertices).map_err(JsValue::from_str)?;
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

    pub fn collision_stats(&self) -> Vec<u32> {
        vec![
            self.scene_mesh.triangles.len() as u32,
            self.scene_mesh.nodes.len() as u32,
            (self.scene_mesh.triangles.capacity() * std::mem::size_of::<[[f64; 3]; 3]>()
                + self.scene_mesh.nodes.capacity() * std::mem::size_of::<CollisionNode>())
                as u32,
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
        let entry = self
            .manifest
            .tiles
            .get(index)
            .ok_or_else(|| fail("Unknown tile"))?;
        if (entry.bytes != 0 && bytes.len() != entry.bytes)
            || bytes.is_empty()
            || bytes.len() > 16 * 1024 * 1024
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

    use super::*;

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
