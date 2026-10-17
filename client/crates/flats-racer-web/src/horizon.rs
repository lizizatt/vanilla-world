//! Visual-only WDL adapter. Source terrain never participates in the vehicle surface query.
use crate::voyage::{Manifest, TILE, Voyage};
use benilla_formats::{WdlFile, WdlTileMesh};
use wasm_bindgen::prelude::*;

const MAX_PATCHES: usize = 8192;

pub(crate) struct Horizon {
    wdl: WdlFile,
    patches: Vec<(u32, u32)>,
}

fn placement(m: &Manifest, region: usize, x: u32, y: u32) -> [f64; 2] {
    let r = &m.regions[region];
    [
        r.placement[0] + (f64::from(x) - f64::from(r.tile_origin[0])) * TILE,
        r.placement[1] + (f64::from(y) - f64::from(r.tile_origin[1])) * TILE,
    ]
}

fn in_domain(m: &Manifest, region: usize, x: u32) -> bool {
    let h = &m.horizons[region];
    x >= h.source_bounds[0] && x < h.source_bounds[2]
}

fn vertices(mesh: &WdlTileMesh) -> Vec<f32> {
    let mut output = vec![0.0; 545 * 7];
    for (i, p) in mesh.positions.iter().enumerate() {
        let (row, col) = if i < 289 {
            ((i / 17) as f64, (i % 17) as f64)
        } else {
            (((i - 289) / 16) as f64 + 0.5, ((i - 289) % 16) as f64 + 0.5)
        };
        // The same authored lattice, in tile-local f64 before f32 upload; no world-size rounding.
        output[i * 7..i * 7 + 3].copy_from_slice(&[
            (col * TILE / 16.0) as f32,
            p[2],
            (row * TILE / 16.0) as f32,
        ]);
        output[i * 7 + 6] = 3.0;
    }
    for tri in mesh.indices.as_chunks::<3>().0 {
        let p = tri.map(|i| &output[i as usize * 7..i as usize * 7 + 3]);
        let a = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
        let b = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
        let n = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
        let sign = if n[1] < 0.0 { -1.0 } else { 1.0 };
        for &i in tri {
            for j in 0..3 {
                output[i as usize * 7 + 3 + j] += n[j] * sign;
            }
        }
    }
    for v in output.as_chunks_mut::<7>().0 {
        let length = v[3..6]
            .iter()
            .map(|n| n * n)
            .sum::<f32>()
            .sqrt()
            .max(0.0001);
        for n in &mut v[3..6] {
            *n /= length;
        }
    }
    output
}

impl Horizon {
    pub(crate) fn above_sea(&self, source: [f32; 3], sea: f32) -> bool {
        self.wdl
            .height_at(source[0], source[1])
            .is_some_and(|h| h > sea)
    }
    fn parse(m: &Manifest, region: usize, bytes: &[u8]) -> Result<Self, String> {
        let entry = m.horizons.get(region).ok_or("No horizon descriptor")?;
        if bytes.len() != entry.bytes {
            return Err("Wrong WDL size".into());
        }
        let wdl = WdlFile::parse(bytes).map_err(|e| format!("WDL: {e}"))?;
        if wdl.present_count() == 0 {
            return Err("WDL has no authored terrain".into());
        }
        let patches = wdl.present_tiles().collect::<Vec<_>>();
        let bounds = patches.iter().fold([64, 64, 0, 0], |b, &(x, y)| {
            [b[0].min(x), b[1].min(y), b[2].max(x + 1), b[3].max(y + 1)]
        });
        if bounds != entry.source_bounds {
            return Err("WDL source bounds differ from manifest".into());
        }
        if patches.is_empty() || patches.len() > MAX_PATCHES {
            return Err("WDL horizon empty or exceeds full-map format budget".into());
        }
        Ok(Self { wdl, patches })
    }
}

#[wasm_bindgen]
impl Voyage {
    pub fn add_horizon(&mut self, region: usize, bytes: &[u8]) -> Result<(), JsValue> {
        let h = Horizon::parse(&self.manifest, region, bytes).map_err(|e| JsValue::from_str(&e))?;
        let total = h.patches.len()
            + self
                .horizons
                .iter()
                .filter(|(r, _)| **r != region)
                .map(|(_, h)| h.patches.len())
                .sum::<usize>();
        if total > MAX_PATCHES {
            return Err(JsValue::from_str(
                "Combined horizon exceeds two complete 64x64 maps",
            ));
        }
        self.horizons.insert(region, h);
        Ok(())
    }

    /// Each row: source x/y, global east/south, corresponding detailed index (-1 otherwise).
    pub fn horizon_patches(&self, region: usize) -> Result<Vec<f64>, JsValue> {
        let h = self
            .horizons
            .get(&region)
            .ok_or_else(|| JsValue::from_str("WDL not loaded"))?;
        let mut out = Vec::new();
        for &(x, y) in &h.patches {
            let p = placement(&self.manifest, region, x, y);
            let near = self
                .manifest
                .tiles
                .iter()
                .position(|t| t.region == region && t.x == x && t.y == y);
            out.extend([
                f64::from(x),
                f64::from(y),
                p[0],
                p[1],
                near.map_or(-1.0, |i| i as f64),
            ]);
        }
        Ok(out)
    }

    pub fn horizon_vertices(&self, region: usize, patch: usize) -> Result<Vec<f32>, JsValue> {
        let h = self
            .horizons
            .get(&region)
            .ok_or_else(|| JsValue::from_str("WDL not loaded"))?;
        let &(x, y) = h
            .patches
            .get(patch)
            .ok_or_else(|| JsValue::from_str("Unknown WDL patch"))?;
        Ok(vertices(&h.wdl.tile_mesh(x, y).expect("present patch")))
    }

    /// All WDL patches share this indexed centre-fan topology.
    pub fn horizon_indices(&self, region: usize) -> Result<Vec<u32>, JsValue> {
        let h = self
            .horizons
            .get(&region)
            .ok_or_else(|| JsValue::from_str("WDL not loaded"))?;
        let (x, y) = h.patches[0];
        Ok(h.wdl.tile_mesh(x, y).expect("present patch").indices)
    }

    /// Conservative payload bound: each parsed map reserves 4096 inline optional height arrays.
    pub fn horizon_cpu_bound(&self) -> usize {
        self.horizons.len() * 4096 * (545 * 2 + 8)
            + self
                .horizons
                .values()
                .map(|h| h.patches.capacity() * 8)
                .sum::<usize>()
    }

    /// Join exposed ADT triangle edges to the neighbouring WDL edge, without filling ADT holes.
    /// These vertical visual stitches can be visible where coarse heights disagree; no collision.
    pub fn horizon_seams(&self, index: usize) -> Result<Vec<f32>, JsValue> {
        let tile = self
            .resident
            .get(&index)
            .ok_or_else(|| JsValue::from_str("Tile not resident"))?;
        let entry = &self.manifest.tiles[index];
        let Some(h) = self.horizons.get(&entry.region) else {
            return Ok(vec![]);
        };
        let mut out = Vec::new();
        let nw = [
            -(f64::from(entry.y) - 32.0) * TILE,
            -(f64::from(entry.x) - 32.0) * TILE,
        ];
        for (edge, (dx, dy)) in [(-1, 0), (1, 0), (0, -1), (0, 1)].into_iter().enumerate() {
            let (nx, ny) = (entry.x as i32 + dx, entry.y as i32 + dy);
            if !(0..64).contains(&nx)
                || !(0..64).contains(&ny)
                || !in_domain(&self.manifest, entry.region, nx as u32)
            {
                continue;
            }
            if self.resident.keys().any(|&i| {
                let t = &self.manifest.tiles[i];
                t.region == entry.region && t.x == nx as u32 && t.y == ny as u32
            }) {
                continue;
            }
            let Some(neighbor) = h.wdl.tile_mesh(nx as u32, ny as u32) else {
                continue;
            };
            let far_height = |along: f32| {
                let t = (f64::from(along) / TILE * 16.0).clamp(0.0, 16.0);
                let i = (t.floor() as usize).min(15);
                let at = |j: usize| {
                    neighbor.positions[match edge {
                        0 => j * 17 + 16,
                        1 => j * 17,
                        2 => 16 * 17 + j,
                        _ => j,
                    }][2]
                };
                at(i) + (at(i + 1) - at(i)) * (t - i as f64) as f32
            };
            let axis = if edge < 2 { 0 } else { 2 };
            let source_axis = if edge < 2 { 1 } else { 0 };
            let border = if edge % 2 == 0 { 0.0 } else { TILE as f32 };
            for chunk in &tile.chunks {
                if !chunk.positions.iter().any(|p| {
                    ((nw[source_axis] - f64::from(p[source_axis])) as f32 - border).abs() <= 0.02
                }) {
                    continue;
                }
                for tri in chunk.indices.as_chunks::<3>().0 {
                    for pair in [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
                        let local = |i: u32| {
                            let p = chunk.positions[i as usize];
                            [
                                (nw[1] - f64::from(p[1])) as f32,
                                p[2],
                                (nw[0] - f64::from(p[0])) as f32,
                            ]
                        };
                        let (mut a, mut b) = (local(pair.0), local(pair.1));
                        if (a[axis] - border).abs() > 0.02 || (b[axis] - border).abs() > 0.02 {
                            continue;
                        }
                        a[axis] = border;
                        b[axis] = border;
                        let along = if axis == 0 { 2 } else { 0 };
                        let c = [a[0], far_height(a[along]), a[2]];
                        let d = [b[0], far_height(b[along]), b[2]];
                        for p in [a, b, c, c, b, d] {
                            out.extend(p);
                            out.extend([0.0, 1.0, 0.0, 0.0]);
                        }
                    }
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voyage::tests::fixture;

    #[test]
    fn seam_chunk_pruning_preserves_every_authored_border_triangle() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        for (map, x, y) in [("Kalimdor", 39, 43), ("Azeroth", 32, 48)] {
            let bytes = chain
                .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
                .unwrap();
            let mut tile = benilla_formats::adt_to_tile_mesh(&bytes).unwrap();
            // Include holes: only surviving triangle edges, never a filled rectangular skirt.
            tile.chunks[0].indices.clear();
            let bytes = chain
                .read_file(&format!("World\\Maps\\{map}\\{map}.wdl"))
                .unwrap();
            let wdl = WdlFile::parse(&bytes).unwrap();
            let mut expected = Vec::new();
            let nw = [-(y as f64 - 32.0) * TILE, -(x as f64 - 32.0) * TILE];
            for (edge, (dx, dy)) in [(-1, 0), (1, 0), (0, -1), (0, 1)].into_iter().enumerate() {
                if wdl
                    .tile_mesh((x as i32 + dx) as u32, (y as i32 + dy) as u32)
                    .is_none()
                {
                    continue;
                }
                let axis = if edge < 2 { 0 } else { 2 };
                let border = if edge % 2 == 0 { 0.0 } else { TILE as f32 };
                for chunk in &tile.chunks {
                    for tri in chunk.indices.chunks_exact(3) {
                        for (a, b) in [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
                            let local = |i: u32| {
                                let p = chunk.positions[i as usize];
                                [
                                    (nw[1] - p[1] as f64) as f32,
                                    p[2],
                                    (nw[0] - p[0] as f64) as f32,
                                ]
                            };
                            let (mut a, mut b) = (local(a), local(b));
                            if (a[axis] - border).abs() <= 0.02 && (b[axis] - border).abs() <= 0.02
                            {
                                a[axis] = border;
                                b[axis] = border;
                                expected.push([a, b]);
                            }
                        }
                    }
                }
            }
            assert!(!expected.is_empty());
            let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
            world.manifest.tiles[0].x = x;
            world.manifest.tiles[0].y = y;
            world.manifest.horizons.push(crate::voyage::HorizonEntry {
                region: 0,
                file: String::new(),
                bytes: bytes.len(),
                sha256: String::new(),
                source_bounds: [0, 0, 64, 64],
            });
            world.horizons.insert(
                0,
                Horizon {
                    wdl,
                    patches: vec![],
                },
            );
            world.resident.insert(0, tile);
            let seams = world.horizon_seams(0).unwrap();
            let actual: Vec<_> = seams
                .chunks_exact(42)
                .map(|quad| {
                    [
                        <[f32; 3]>::try_from(&quad[..3]).unwrap(),
                        <[f32; 3]>::try_from(&quad[7..10]).unwrap(),
                    ]
                })
                .collect();
            assert_eq!(
                actual, expected,
                "{map}: optimized seams differ from full triangle traversal"
            );
        }
    }

    fn wdl() -> Vec<u8> {
        let mut bytes = b"REVM\x04\0\0\0\x12\0\0\0FOAM\0\x40\0\0".to_vec();
        let offset = (bytes.len() + 4096 * 4) as u32;
        for i in 0..4096 {
            bytes.extend(if i == 33 * 64 + 41 { offset } else { 0 }.to_le_bytes());
        }
        bytes.extend(b"ERAM");
        bytes.extend(1090u32.to_le_bytes());
        for i in 0..545 {
            bytes.extend(((i % 17) as i16).to_le_bytes());
        }
        bytes
    }

    #[test]
    fn authored_lattice_is_indexed_local_and_placement_is_translation_only() {
        let parsed = WdlFile::parse(&wdl()).unwrap();
        let mesh = parsed.tile_mesh(41, 33).unwrap();
        let v = vertices(&mesh);
        assert_eq!(v.len(), 545 * 7);
        assert_eq!(mesh.indices.len(), 3072);
        for (i, p) in mesh.positions.iter().enumerate() {
            assert_eq!(v[i * 7 + 1], p[2]);
            assert!((v[i * 7] - (mesh.positions[0][1] - p[1])).abs() < 0.002);
            assert!((v[i * 7 + 2] - (mesh.positions[0][0] - p[0])).abs() < 0.002);
            assert!(v[i * 7 + 4] > 0.0);
        }
        let m = fixture(1e9);
        assert_eq!(placement(&m, 0, 41, 33), [1e9, 0.0]);
    }
}
