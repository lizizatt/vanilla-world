//! Live archive topology and layout; WDT presence is independent of asynchronous ADT residency.
use crate::voyage::{FLOOR_CLEARANCE, HorizonEntry, Manifest, Region, TILE, TileEntry, Voyage};
use benilla_formats::WdlFile;
use benilla_wdt::{WdtReader, WowVersion};
use std::{collections::VecDeque, io::Cursor};
use wasm_bindgen::prelude::*;

fn topology(bytes: &[u8]) -> Result<Vec<(u32, u32)>, String> {
    if bytes.len() > 128 * 1024 {
        return Err("WDT exceeds metadata limit".into());
    }
    let mut offset = 0;
    let mut main = false;
    let mut version = false;
    while offset < bytes.len() {
        let header = bytes
            .get(offset..offset + 8)
            .ok_or("Truncated WDT header")?;
        let size = u32::from_le_bytes(header[4..8].try_into().expect("four bytes")) as usize;
        let body = bytes
            .get(offset + 8..offset + 8 + size)
            .ok_or("Truncated WDT chunk")?;
        if &header[..4] == b"NIAM" {
            if main || size != 4096 * 8 {
                return Err("Invalid WDT MAIN grid".into());
            }
            main = true;
        }
        if &header[..4] == b"REVM" {
            if size != 4 || body != 18u32.to_le_bytes() {
                return Err("Unsupported WDT version".into());
            }
            version = true;
        }
        offset += 8 + size;
    }
    if !main || !version {
        return Err("WDT requires version and authoritative MAIN grid".into());
    }
    let wdt = WdtReader::new(Cursor::new(bytes), WowVersion::Classic)
        .read()
        .map_err(|e| e.to_string())?;
    if wdt.global_wmo().is_some() {
        return Err("Only terrain overworld maps are supported".into());
    }
    let cells = (0..4096)
        .filter_map(|i| {
            wdt.get_tile(i % 64, i / 64)
                .filter(|t| t.has_adt)
                .map(|t| (t.x as u32, t.y as u32))
        })
        .collect::<Vec<_>>();
    if cells.is_empty() {
        return Err("Overworld WDT has no ADTs".into());
    }
    Ok(cells)
}

fn extent(tiles: impl Iterator<Item = (u32, u32)>) -> [u32; 4] {
    tiles.fold([64, 64, 0, 0], |b, (x, y)| {
        [b[0].min(x), b[1].min(y), b[2].max(x + 1), b[3].max(y + 1)]
    })
}

fn build_world(wdts: [&[u8]; 2], wdls: [&[u8]; 2]) -> Result<Manifest, String> {
    let maps = ["Kalimdor", "Azeroth"];
    let mut tiles = Vec::new();
    let mut horizons = Vec::new();
    let mut bounds = [[0; 4]; 2];
    for region in 0..2 {
        let cells = topology(wdts[region])?;
        let wdl = WdlFile::parse(wdls[region]).map_err(|e| format!("WDL: {e}"))?;
        let source_bounds = extent(wdl.present_tiles());
        bounds[region] = extent(cells.iter().copied().chain(wdl.present_tiles()));
        horizons.push(HorizonEntry {
            region,
            file: format!("{}.wdl", maps[region]),
            bytes: wdls[region].len(),
            sha256: "0".repeat(64),
            source_bounds,
        });
        tiles.extend(cells.into_iter().map(|(x, y)| TileEntry {
            region,
            x,
            y,
            file: format!("{}_{x}_{y}.adt", maps[region]),
            bytes: 0,
            sha256: String::new(),
        }));
    }
    let west_origin = [-41.0 * TILE, -33.0 * TILE];
    let west_edge = west_origin[0] + f64::from(bounds[0][2]) * TILE;
    // User-directed layout: broad ocean and Eastern Kingdoms south by half its actual WDL length.
    let south = f64::from(horizons[1].source_bounds[3] - horizons[1].source_bounds[1]) * TILE * 0.5;
    let east_origin = [
        west_edge + 8192.0 - f64::from(bounds[1][0]) * TILE,
        -51.0 * TILE + south,
    ];
    let min_z = (west_origin[1] + f64::from(bounds[0][1]) * TILE)
        .min(east_origin[1] + f64::from(bounds[1][1]) * TILE);
    let max_z = (west_origin[1] + f64::from(bounds[0][3]) * TILE)
        .max(east_origin[1] + f64::from(bounds[1][3]) * TILE);
    let manifest = Manifest {
        version: 3,
        label: "Azeroth / local overworld / provisional broad ocean and southern Eastern Kingdoms"
            .into(),
        regions: vec![
            Region {
                id: "kalimdor".into(),
                map: maps[0].into(),
                tile_origin: [0, 0],
                tile_count: [64, 64],
                placement: west_origin,
            },
            Region {
                id: "eastern-kingdoms".into(),
                map: maps[1].into(),
                tile_origin: [0, 0],
                tile_count: [64, 64],
                placement: east_origin,
            },
        ],
        tiles,
        horizons,
        world_bounds: Some(bounds),
        ocean: [west_edge, min_z, west_edge + 8192.0, max_z],
        sea_level: 0.0,
        spawn: [
            west_origin[0] + 39.0 * TILE + 256.0,
            0.0,
            west_origin[1] + 43.0 * TILE + 256.0,
            std::f64::consts::PI,
        ],
        destination: [
            east_origin[0] + 28.0 * TILE + 256.0,
            east_origin[1] + 51.0 * TILE + 160.0,
        ],
    };
    manifest.validate()?;
    Ok(manifest)
}

#[wasm_bindgen]
pub fn world_manifest(
    kalimdor_wdt: &[u8],
    kalimdor_wdl: &[u8],
    azeroth_wdt: &[u8],
    azeroth_wdl: &[u8],
) -> Result<String, JsValue> {
    let m = build_world([kalimdor_wdt, azeroth_wdt], [kalimdor_wdl, azeroth_wdl])
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&m).map_err(|e| JsValue::from_str(&e.to_string()))
}

pub(crate) fn exterior_cells(grid: &[Option<usize>]) -> Vec<bool> {
    let mut exterior = vec![false; 8192];
    for region in 0..2 {
        let base = region * 4096;
        let mut queue = VecDeque::new();
        for i in 0..4096 {
            if (i % 64 == 0 || i % 64 == 63 || i / 64 == 0 || i / 64 == 63)
                && grid[base + i].is_none()
            {
                exterior[base + i] = true;
                queue.push_back(i);
            }
        }
        while let Some(i) = queue.pop_front() {
            for (x, y) in [
                (i as i32 % 64 - 1, i as i32 / 64),
                (i as i32 % 64 + 1, i as i32 / 64),
                (i as i32 % 64, i as i32 / 64 - 1),
                (i as i32 % 64, i as i32 / 64 + 1),
            ] {
                if !(0..64).contains(&x) || !(0..64).contains(&y) {
                    continue;
                }
                let next = y as usize * 64 + x as usize;
                if grid[base + next].is_none() && !exterior[base + next] {
                    exterior[base + next] = true;
                    queue.push_back(next);
                }
            }
        }
    }
    exterior
}

impl Voyage {
    fn cell(&self, region: usize, p: [f64; 2]) -> Option<usize> {
        let r = &self.manifest.regions[region];
        let x = ((p[0] - r.placement[0]) / TILE + f64::from(r.tile_origin[0])).floor();
        let y = ((p[1] - r.placement[1]) / TILE + f64::from(r.tile_origin[1])).floor();
        if !(0.0..64.0).contains(&x) || !(0.0..64.0).contains(&y) {
            return None;
        }
        Some(region * 4096 + y as usize * 64 + x as usize)
    }
    pub(crate) fn locate(&self, p: [f64; 2]) -> Option<usize> {
        (0..2).find_map(|r| self.cell(r, p).and_then(|c| self.grid[c]))
    }
    pub(crate) fn exterior_ocean(&self, p: [f64; 2]) -> Option<usize> {
        (0..2).find(|&region| {
            if (region == 0 && p[0] >= self.manifest.ocean[0])
                || (region == 1 && p[0] < self.manifest.ocean[2])
            {
                return false;
            }
            let Some(cell) = self.cell(region, p) else {
                return false;
            };
            let Some(h) = self.horizons.get(&region) else {
                return false;
            };
            let source = self.manifest.regions[region].source(p);
            self.exterior[cell] && !h.above_sea(source, self.manifest.sea_level)
        })
    }
}

#[wasm_bindgen]
impl Voyage {
    /// Only exterior-connected, WDT-absent cells; never an expected but unloaded ADT.
    pub fn exterior_geometry(&self, region: usize) -> Result<Vec<f32>, JsValue> {
        if region >= 2 {
            return Err(JsValue::from_str("Unknown ocean region"));
        }
        let r = &self.manifest.regions[region];
        let mut vertices = Vec::new();
        for cell in 0..4096 {
            if !self.exterior[region * 4096 + cell] {
                continue;
            }
            let x = (cell % 64) as f64 * TILE;
            let z = (cell / 64) as f64 * TILE;
            let gx = r.placement[0] + x;
            if (region == 0 && gx >= self.manifest.ocean[0] - 0.01)
                || (region == 1 && gx < self.manifest.ocean[2] - 0.01)
            {
                continue;
            }
            for p in [
                [x, z],
                [x + TILE, z],
                [x + TILE, z + TILE],
                [x, z],
                [x + TILE, z + TILE],
                [x, z + TILE],
            ] {
                vertices.extend([
                    p[0] as f32,
                    self.manifest.sea_level,
                    p[1] as f32,
                    0.0,
                    1.0,
                    0.0,
                    2.0,
                ]);
            }
        }
        Ok(vertices)
    }

    pub fn initialize_spawn(&mut self) -> Result<(), JsValue> {
        let p = [self.manifest.spawn[0], self.manifest.spawn[2]];
        let s = self.sample(p);
        if s.availability != 0 || s.solid {
            return Err(JsValue::from_str("Raceway terrain is not ready or usable"));
        }
        let height = match (s.ground, s.water) {
            (Some(g), Some(w)) => g.max(w),
            (Some(g), None) => g,
            (None, Some(w)) => w,
            _ => return Err(JsValue::from_str("Raceway has no support")),
        };
        self.manifest.spawn[1] = f64::from(height) + f64::from(self.tuning.hover_height.max(FLOOR_CLEARANCE));
        self.reset();
        Ok(())
    }

    /// Pin current supports and the next frame's horizontal sweep before prefetch/eviction.
    pub fn required_tiles(&self) -> Vec<u32> {
        let p = self.telemetry();
        let mut needed = Vec::new();
        let radius = 4.0 + self.frame_sweep_distance();
        if radius >= TILE / 2.0 {
            // A nine-point stencil can skip intermediate cells at high user-tuned speeds.
            for (index, tile) in self.manifest.tiles.iter().enumerate() {
                let r = &self.manifest.regions[tile.region];
                let x = r.placement[0] + (f64::from(tile.x) - f64::from(r.tile_origin[0])) * TILE;
                let z = r.placement[1] + (f64::from(tile.y) - f64::from(r.tile_origin[1])) * TILE;
                if x <= p[0] + radius
                    && x + TILE >= p[0] - radius
                    && z <= p[2] + radius
                    && z + TILE >= p[2] - radius
                {
                    needed.push(index as u32);
                }
            }
            return needed;
        }
        for x in [p[0] - radius, p[0], p[0] + radius] {
            for z in [p[2] - radius, p[2], p[2] + radius] {
                if let Some(index) = self.locate([x, z]) {
                    if !needed.contains(&(index as u32)) {
                        needed.push(index as u32);
                    }
                }
            }
        }
        needed
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use benilla_formats::{ChunkMesh, TileMesh};
    use flats_racer_physics::Input;

    pub(crate) fn flat_tile(x: u32, y: u32) -> TileMesh {
        let mut chunks = Vec::new();
        for row in 0..16 {
            for col in 0..16 {
                let nx = (32.0 - f64::from(y)) * TILE - f64::from(row) * TILE / 16.0;
                let ny = (32.0 - f64::from(x)) * TILE - f64::from(col) * TILE / 16.0;
                let mut positions = Vec::new();
                for r in 0..9 {
                    for c in 0..9 {
                        positions.push([
                            (nx - f64::from(r) * TILE / 128.0) as f32,
                            (ny - f64::from(c) * TILE / 128.0) as f32,
                            0.0,
                        ]);
                    }
                    if r < 8 {
                        for c in 0..8 {
                            positions.push([
                                (nx - (f64::from(r) + 0.5) * TILE / 128.0) as f32,
                                (ny - (f64::from(c) + 0.5) * TILE / 128.0) as f32,
                                0.0,
                            ]);
                        }
                    }
                }
                chunks.push(ChunkMesh {
                    positions,
                    normals: vec![],
                    uvs: vec![],
                    indices: vec![],
                    holes: 0,
                    base_texture: None,
                    layer_textures: vec![],
                    layer_effect_ids: vec![],
                    alpha_map: None,
                    shadow: None,
                    pred_tex: [0; 64],
                    no_effect_doodad: [false; 64],
                    index_x: col,
                    index_y: row,
                    area_id: 1,
                    impassable: false,
                    liquids: vec![],
                });
            }
        }
        TileMesh {
            chunks,
            doodads: vec![],
            wmos: vec![],
        }
    }

    #[test]
    fn spawn_uses_active_hover_without_a_suspension_launch_or_floor_snap() {
        for hover in [0.1_f32, 1.1, 30.0] {
            let mut world = Voyage::from_manifest(crate::voyage::tests::fixture(0.0)).unwrap();
            let t = &world.manifest.tiles[0];
            world.resident.insert(0, flat_tile(t.x, t.y));
            let mut tuning = world.tuning();
            tuning[11] = hover;
            world.set_tuning(&tuning).unwrap();
            world.initialize_spawn().unwrap();
            let expected = hover.max(0.25);
            assert_eq!(world.telemetry()[1], f64::from(expected));
            for _ in 0..480 {
                world.advance(Input::default()).unwrap();
                assert_eq!(world.telemetry()[8], 0.0);
                assert!((world.telemetry()[1] - f64::from(expected)).abs() < 1e-5);
            }
            world.reset();
            assert_eq!(world.telemetry()[1], f64::from(expected));
        }
    }

    #[test]
    fn accelerated_large_sweep_pins_intermediate_tiles_missed_by_nine_points() {
        let mut m = crate::voyage::tests::fixture(0.0);
        m.regions[0].tile_count = [4, 1];
        m.regions[1].placement[0] = 4000.0;
        m.ocean[0] = 4.0 * TILE;
        m.ocean[2] = 4000.0;
        m.destination[0] = 4200.0;
        m.spawn = [TILE * 1.5, 1.1, 200.0, 0.0];
        m.tiles.clear();
        for (region, r) in m.regions.iter().enumerate() {
            for y in r.tile_origin[1]..r.tile_origin[1] + r.tile_count[1] {
                for x in r.tile_origin[0]..r.tile_origin[0] + r.tile_count[0] {
                    m.tiles.push(TileEntry {
                        region,
                        x,
                        y,
                        file: format!("{}_{}_{}.adt", r.map, x, y),
                        bytes: 1,
                        sha256: "a".repeat(64),
                    });
                }
            }
        }
        let mut world = Voyage::from_manifest(m).unwrap();
        assert_eq!(world.required_tiles(), vec![1]);
        let mut tuning = world.tuning();
        tuning[0] = 10000.0;
        tuning[1] = 10000.0;
        tuning[2] = 1000000.0;
        world.set_tuning(&tuning).unwrap();
        assert!(world.frame_sweep_distance() >= 1000.0);
        assert_eq!(world.required_tiles(), vec![0, 1, 2, 3]);
        assert!(
            world.resident.is_empty(),
            "Expected cells must not become fictitious ocean"
        );
    }

    #[test]
    fn four_way_diagonal_crossing_pins_four_tiles_and_missing_tile_holds() {
        let mut m = crate::voyage::tests::fixture(0.0);
        m.regions[0].tile_count = [2, 2];
        m.regions[1].tile_count = [1, 2];
        m.ocean = [2.0 * TILE, 0.0, 2000.0, 2.0 * TILE];
        m.spawn = [TILE - 0.1, 1.1, TILE - 0.1, -std::f64::consts::PI * 0.75];
        m.tiles.clear();
        for (region, r) in m.regions.iter().enumerate() {
            for y in r.tile_origin[1]..r.tile_origin[1] + r.tile_count[1] {
                for x in r.tile_origin[0]..r.tile_origin[0] + r.tile_count[0] {
                    m.tiles.push(TileEntry {
                        region,
                        x,
                        y,
                        file: format!("{}_{}_{}.adt", r.map, x, y),
                        bytes: 1,
                        sha256: "a".repeat(64),
                    });
                }
            }
        }
        let mut world = Voyage::from_manifest(m).unwrap();
        assert_eq!(world.required_tiles().len(), 4);
        for index in 0..3 {
            let t = &world.manifest.tiles[index];
            world.resident.insert(index, flat_tile(t.x, t.y));
        }
        let before = world.telemetry();
        world
            .advance(Input {
                throttle: 1.0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(world.telemetry()[8], 1.0);
        assert_eq!(world.telemetry()[0], before[0]);
        let t = &world.manifest.tiles[3];
        world.resident.insert(3, flat_tile(t.x, t.y));
        for _ in 0..240 {
            world
                .advance(Input {
                    throttle: 1.0,
                    ..Default::default()
                })
                .unwrap();
        }
        let after = world.telemetry();
        assert!(
            after[0] > TILE + 10.0 && after[2] > TILE + 10.0,
            "diagonal held at {after:?}"
        );
        assert_eq!(after[8], 0.0);
        assert_eq!(world.resident.len(), 4);
    }
    #[test]
    fn enclosed_missing_cells_are_not_exterior_ocean() {
        let mut grid = vec![None; 8192];
        for (x, y) in [(20, 19), (19, 20), (21, 20), (20, 21)] {
            grid[y * 64 + x] = Some(0);
        }
        let sea = exterior_cells(&grid);
        assert!(!sea[20 * 64 + 20]);
        assert!(!sea[19 * 64 + 20]);
        assert!(sea[18 * 64 + 20]);
        assert!(sea[4096 + 20 * 64 + 20]);
    }
    #[test]
    fn missing_or_malformed_wdt_never_becomes_a_valid_empty_ocean_map() {
        assert!(topology(&[]).is_err());
        assert!(topology(b"NIAM\0\0\0\0").is_err());
        let mut bytes = b"REVM\x04\0\0\0\x12\0\0\0NIAM\0\x80\0\0".to_vec();
        bytes.resize(bytes.len() + 4096 * 8, 0);
        assert!(topology(&bytes).is_err());
        bytes[20 + 8 * (43 * 64 + 39)] = 1;
        assert_eq!(topology(&bytes).unwrap(), [(39, 43)]);
    }
}
