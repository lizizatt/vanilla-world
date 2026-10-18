//! Visual-only distant MCLQ surfaces. No inferred water, terrain residency or physics changes.
use crate::voyage::TILE;
use benilla_formats::{LiquidKind, LiquidMesh, adt_bytes_to_liquid_only};
use wasm_bindgen::prelude::*;

fn geometry(meshes: &[LiquidMesh], x: u32, y: u32) -> Result<Vec<f32>, String> {
    if x >= 64 || y >= 64 {
        return Err("Invalid liquid tile coordinate".into());
    }
    let nw = [-(f64::from(y) - 32.0) * TILE, -(f64::from(x) - 32.0) * TILE];
    let mut out = Vec::new();
    for mesh in meshes
        .iter()
        .filter(|m| matches!(m.kind, LiquidKind::Still | LiquidKind::Ocean))
    {
        let compact = planar_indices(mesh);
        let indices = compact.as_deref().unwrap_or(&mesh.indices);
        if out.len() + indices.len() * 7 > 8 * 1024 * 1024 / 4 {
            return Err("Distant liquid tile exceeds 8 MiB geometry budget".into());
        }
        for &i in indices {
            let p = mesh
                .positions
                .get(i as usize)
                .ok_or("Invalid liquid index")?;
            let local = [
                (nw[1] - f64::from(p[1])) as f32,
                p[2],
                (nw[0] - f64::from(p[0])) as f32,
            ];
            if !local.iter().all(|n| n.is_finite())
                || local[1].abs() >= 1e9
                || [local[0], local[2]]
                    .iter()
                    .any(|&n| n < -0.02 || f64::from(n) > TILE + 0.02)
            {
                return Err("Authored liquid is outside its tile or has invalid heights".into());
            }
            out.extend(local);
            out.extend([0.0, 1.0, 0.0, 2.0]);
        }
    }
    Ok(out)
}

fn planar_indices(mesh: &LiquidMesh) -> Option<Vec<u32>> {
    let height = mesh.positions.get(*mesh.indices.first()? as usize)?[2];
    if mesh.grid != [9, 9]
        || mesh.wet.len() != 64
        || mesh.positions.len() != 81
        || !mesh
            .indices
            .iter()
            .all(|&i| mesh.positions[i as usize][2] == height)
    {
        return None;
    }
    let mut remaining = mesh.wet.clone();
    let mut out = Vec::new();
    for row in 0..8 {
        for col in 0..8 {
            if !remaining[row * 8 + col] {
                continue;
            }
            let mut width = 1;
            while col + width < 8 && remaining[row * 8 + col + width] {
                width += 1;
            }
            let mut height = 1;
            while row + height < 8 && (col..col + width).all(|c| remaining[(row + height) * 8 + c])
            {
                height += 1;
            }
            for r in row..row + height {
                for c in col..col + width {
                    remaining[r * 8 + c] = false;
                }
            }
            let a = (row * 9 + col) as u32;
            let b = a + width as u32;
            let c = b + height as u32 * 9;
            let d = a + height as u32 * 9;
            out.extend([a, b, c, a, c, d]);
        }
    }
    Some(out)
}

#[wasm_bindgen]
pub fn coast_liquids(bytes: &[u8], x: u32, y: u32) -> Result<Vec<f32>, JsValue> {
    let result = if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 {
        Err("Liquid source file is empty or exceeds 64 MiB".into())
    } else {
        adt_bytes_to_liquid_only(bytes)
            .map_err(|e| e.to_string())
            .and_then(|meshes| geometry(&meshes, x, y))
    };
    result.map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authored_coasts_lake_and_below_sea_raceway_match_full_liquid_parse() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        for (map, x, y) in [
            ("Kalimdor", 43, 40),
            ("Kalimdor", 41, 43),
            ("Kalimdor", 41, 50),
            ("Kalimdor", 39, 43),
            ("Azeroth", 29, 48),
            ("Azeroth", 32, 48),
            ("Azeroth", 33, 33),
        ] {
            let bytes = chain
                .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
                .unwrap();
            let start = std::time::Instant::now();
            let light = adt_bytes_to_liquid_only(&bytes).unwrap();
            let vertices = geometry(&light, x, y).unwrap();
            let elapsed = start.elapsed();
            let full = benilla_formats::adt_to_tile_mesh(&bytes).unwrap();
            let near: Vec<_> = full.chunks.iter().flat_map(|c| c.liquids.iter()).collect();
            assert_eq!(light.len(), near.len(), "{map}_{x}_{y}");
            for (a, b) in light.iter().zip(near) {
                assert_eq!(a.kind, b.kind);
                assert_eq!(a.positions, b.positions);
                assert_eq!(a.indices, b.indices);
                assert_eq!(a.wet, b.wet);
            }
            let input: usize = light
                .iter()
                .filter(|l| matches!(l.kind, LiquidKind::Still | LiquidKind::Ocean))
                .map(|l| l.indices.len())
                .sum();
            assert!(vertices.len() / 7 <= input);
            println!(
                "{map}_{x}_{y}: {} meshes, {input}->{} vertices, {:?}, {} bytes",
                light.len(),
                vertices.len() / 7,
                elapsed,
                vertices.len() * 4
            );
            if (map, x, y) == ("Azeroth", 32, 48) {
                assert_eq!(light.len(), 42);
            }
        }
    }
    #[test]
    fn simplification_preserves_dry_cells_and_nonplanar_surfaces() {
        let flat = LiquidMesh {
            grid: [9, 9],
            wet: vec![true; 64],
            shared: vec![false; 64],
            positions: (0..81)
                .map(|i| [-((i / 9) as f32), -((i % 9) as f32), 0.0])
                .collect(),
            uvs: vec![[0.0; 2]; 81],
            depths: vec![1.0; 81],
            indices: (0..64)
                .flat_map(|i| {
                    let a = i + i / 8;
                    [a, a + 1, a + 10, a, a + 10, a + 9]
                })
                .collect(),
            sound_nibble: 1,
            material_id: None,
            kind: LiquidKind::Ocean,
        };
        assert_eq!(geometry(&[flat.clone()], 32, 32).unwrap().len(), 6 * 7);
        for mask in 0..3 {
            let mut hole = flat.clone();
            for (i, wet) in hole.wet.iter_mut().enumerate() {
                *wet = match mask {
                    0 => i != 27,
                    1 => (i / 8 + i % 8) % 2 == 0,
                    _ => (2..5).contains(&(i / 8)) && (3..7).contains(&(i % 8)),
                };
            }
            hole.indices = flat
                .indices
                .chunks_exact(6)
                .enumerate()
                .filter(|(i, _)| hole.wet[*i])
                .flat_map(|(_, indices)| indices.iter().copied())
                .collect();
            let compact = planar_indices(&hole).unwrap();
            assert!(compact.len() <= hole.indices.len());
            let mut covered = [false; 64];
            for quad in compact.chunks_exact(6) {
                let (top, left) = (quad[0] as usize / 9, quad[0] as usize % 9);
                let (bottom, right) = (quad[2] as usize / 9, quad[2] as usize % 9);
                for row in top..bottom {
                    for col in left..right {
                        assert!(!covered[row * 8 + col]);
                        covered[row * 8 + col] = true;
                    }
                }
            }
            assert_eq!(covered.as_slice(), hole.wet.as_slice());
        }
        let mut slope = flat;
        slope.positions[40][2] += 0.25;
        assert_eq!(
            geometry(&[slope.clone()], 32, 32).unwrap().len(),
            slope.indices.len() * 7
        );
    }
    #[test]
    #[ignore = "whole-install sequential liquid-only census; requires local Data"]
    fn whole_continent_liquid_budget() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let mut total = 0;
        let mut tiles = 0;
        let mut wet = 0;
        for map in ["Kalimdor", "Azeroth"] {
            let wdl = benilla_formats::WdlFile::load(&mut chain, map).unwrap();
            for (x, y) in wdl.present_tiles() {
                let bytes = chain
                    .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
                    .unwrap();
                let liquids = adt_bytes_to_liquid_only(&bytes)
                    .unwrap_or_else(|e| panic!("{map}_{x}_{y}: {e}"));
                let length = geometry(&liquids, x, y).unwrap().len() * 4;
                total += length;
                tiles += 1;
                wet += usize::from(length > 0);
            }
        }
        println!("{tiles} authored tiles, {wet} wet, {total} GPU bytes");
        assert!(
            total <= 64 * 1024 * 1024,
            "Full authored coast must fit without hiding distant coverage"
        );
    }
}
