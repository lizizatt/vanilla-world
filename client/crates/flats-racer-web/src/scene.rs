//! Deviation: bounded, static browser scene meshes, not the native animated world renderer.
use crate::voyage::Voyage;
use benilla_formats::{
    CollisionMesh, ModelBlend, RenderSubmesh, WmoRoot, accumulate_wmo_group_collision,
    adt_to_tile_mesh, blp_to_rgba, parse_m2_collision_hull, parse_m2_render_submeshes,
    parse_wmo_root, wmo_group_submeshes_strict,
};
use serde::Serialize;
use serde_json::json;
use wasm_bindgen::prelude::*;

const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_TRIANGLES: usize = 200_000;

fn bounded(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_FILE {
        return Err("Scene file is empty or exceeds 64 MiB".into());
    }
    Ok(())
}

fn js(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub fn scene_placements(bytes: &[u8]) -> Result<String, JsValue> {
    placements(bytes).map_err(js)
}

fn placements(bytes: &[u8]) -> Result<String, String> {
    bounded(bytes)?;
    let tile = adt_to_tile_mesh(bytes).map_err(|e| e.to_string())?;
    let bounds = modf_bounds(bytes)?;
    if tile.doodads.len() + tile.wmos.len() > 20_000 {
        return Err("ADT exceeds 20000 scene placements".into());
    }
    let mut out = Vec::new();
    for d in tile.doodads {
        out.push(json!({"kind":"m2", "id":d.unique_id, "path":d.model,
            "position":d.position, "rotation":d.rotation, "scale":d.scale, "doodadSet":0}));
    }
    for d in tile.wmos {
        let world_bounds = bounds
            .get(&d.unique_id)
            .ok_or("WMO placement has no MODF bounds")?;
        out.push(json!({"kind":"wmo", "id":d.unique_id, "path":d.model,
            "position":d.position, "rotation":d.rotation, "scale":1.0, "doodadSet":d.doodad_set,
            "bounds":world_bounds}));
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

// The terrain adapter omits MODF extents; these are already world-aligned, not model-local.
fn modf_bounds(bytes: &[u8]) -> Result<std::collections::HashMap<u32, [[f32; 3]; 2]>, String> {
    let mut bounds = std::collections::HashMap::new();
    let mut offset = 0;
    while offset + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(size)
            .filter(|&end| end <= bytes.len())
            .ok_or("ADT chunk exceeds file")?;
        if &bytes[offset..offset + 4] == b"FDOM" {
            let (records, tail) = bytes[start..end].as_chunks::<64>();
            if !tail.is_empty() {
                return Err("Incomplete MODF placement".into());
            }
            for record in records {
                let id = u32::from_le_bytes(record[4..8].try_into().unwrap());
                let raw: [f32; 6] = std::array::from_fn(|i| {
                    f32::from_le_bytes(record[32 + i * 4..36 + i * 4].try_into().unwrap())
                });
                if raw.iter().any(|v| !v.is_finite()) || (0..3).any(|i| raw[i] > raw[i + 3]) {
                    return Err("Invalid MODF world bounds".into());
                }
                let center = 32.0 * benilla_formats::TILE_SIZE;
                bounds.insert(
                    id,
                    [
                        [center - raw[5], center - raw[3], raw[1]],
                        [center - raw[2], center - raw[0], raw[4]],
                    ],
                );
            }
        }
        offset = end;
    }
    Ok(bounds)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Batch {
    first_index: usize,
    index_count: usize,
    texture: Option<String>,
    alpha_cutoff: f32,
    blend: &'static str,
    double_sided: bool,
    wrap_x: bool,
    wrap_y: bool,
    emissive: bool,
    no_depth_write: bool,
}

#[wasm_bindgen]
pub struct SceneModel {
    vertices: Vec<f32>,
    indices: Vec<u32>,
    collision: CollisionMesh,
    metadata: String,
}

impl SceneModel {
    fn build(subs: Vec<RenderSubmesh>, collision: CollisionMesh) -> Result<Self, String> {
        let count: usize = subs.iter().map(|s| s.indices.len()).sum();
        if count > MAX_TRIANGLES * 3 || collision.indices.len() > MAX_TRIANGLES * 3 {
            return Err("Scene model exceeds 200000 triangles".into());
        }
        validate_mesh(&collision.positions, &collision.indices)?;
        let mut vertices = Vec::new();
        let mut indices = Vec::with_capacity(count);
        let mut batches = Vec::new();
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for sub in subs {
            validate_mesh(&sub.positions, &sub.indices)?;
            if sub.normals.len() != sub.positions.len()
                || sub.uvs.len() != sub.positions.len()
                || (!sub.vertex_colors.is_empty() && sub.vertex_colors.len() != sub.positions.len())
            {
                return Err("Scene vertex streams have inconsistent lengths".into());
            }
            let base = (vertices.len() / 12) as u32;
            for (i, p) in sub.positions.iter().enumerate() {
                let normal = sub.normals[i];
                let uv = sub.uvs[i];
                let color = sub.vertex_colors.get(i).copied().unwrap_or([1.0; 4]);
                if normal
                    .iter()
                    .chain(uv.iter())
                    .chain(color.iter())
                    .any(|v| !v.is_finite())
                {
                    return Err("Non-finite scene vertex attribute".into());
                }
                for axis in 0..3 {
                    min[axis] = min[axis].min(p[axis]);
                    max[axis] = max[axis].max(p[axis]);
                }
                vertices.extend(p);
                vertices.extend(normal);
                vertices.extend(uv);
                vertices.extend(color);
            }
            batches.push(Batch {
                first_index: indices.len(),
                index_count: sub.indices.len(),
                texture: sub.texture,
                alpha_cutoff: if sub.blend == ModelBlend::AlphaTest {
                    224.0 / 255.0
                } else {
                    0.0
                },
                blend: match sub.blend {
                    ModelBlend::Opaque | ModelBlend::AlphaTest => "opaque",
                    ModelBlend::Blend if sub.additive => "add",
                    ModelBlend::Blend => "alpha",
                    ModelBlend::Mod => "mod",
                    ModelBlend::Mod2x => "mod2x",
                },
                double_sided: sub.two_sided,
                wrap_x: sub.wrap_x,
                wrap_y: sub.wrap_y,
                emissive: sub.emissive,
                no_depth_write: sub.no_depth_write,
            });
            indices.extend(sub.indices.iter().map(|i| i + base));
        }
        if vertices.is_empty() {
            min = [0.0; 3];
            max = [0.0; 3];
        }
        let metadata = json!({"bounds": [min,max], "batches":batches,
            "stride":12, "collision":"authored-static", "animation":"bind-pose"})
        .to_string();
        Ok(Self {
            vertices,
            indices,
            collision,
            metadata,
        })
    }

    fn from_m2(bytes: &[u8], path: &str, skins: &str) -> Result<Self, String> {
        bounded(bytes)?;
        let skins: Vec<Option<String>> = serde_json::from_str(skins).map_err(|e| e.to_string())?;
        if skins.len() > 4 || path.len() > 1024 {
            return Err("Invalid M2 skin/path metadata".into());
        }
        let dir = path.rsplit_once(['\\', '/']).map_or("", |(dir, _)| dir);
        let mut subs = parse_m2_render_submeshes(bytes, dir, &skins).map_err(|e| e.to_string())?;
        let mut omitted_character_batches = 0;
        if let Some(Some(body)) = skins.get(3) {
            for sub in &mut subs {
                if sub.char_slot == Some(benilla_formats::CharSkinSlot::Body) {
                    sub.texture = Some(body.clone());
                }
            }
            // shortcut: baked body only; resolve hair/equipment before admitting their untextured cards.
            let before = subs.len();
            subs.retain(|sub| sub.char_slot.is_none() || sub.texture.is_some());
            omitted_character_batches = before - subs.len();
        }
        let collision = parse_m2_collision_hull(bytes).map_err(|e| e.to_string())?;
        let mut model = Self::build(subs, collision)?;
        if omitted_character_batches > 0 {
            let mut metadata: serde_json::Value =
                serde_json::from_str(&model.metadata).map_err(|e| e.to_string())?;
            metadata["omittedCharacterBatches"] = omitted_character_batches.into();
            metadata["appearance"] = "baked-body-only".into();
            model.metadata = metadata.to_string();
        }
        Ok(model)
    }
}

fn validate_mesh(positions: &[[f32; 3]], indices: &[u32]) -> Result<(), String> {
    if positions.len() > MAX_TRIANGLES * 3
        || !indices.len().is_multiple_of(3)
        || indices.iter().any(|&i| i as usize >= positions.len())
        || positions
            .iter()
            .flatten()
            .any(|v| !v.is_finite() || v.abs() > 100_000.0)
    {
        return Err("Invalid scene geometry or index range".into());
    }
    Ok(())
}

#[wasm_bindgen]
impl SceneModel {
    pub fn m2(bytes: &[u8], path: &str, skins: &str) -> Result<SceneModel, JsValue> {
        Self::from_m2(bytes, path, skins).map_err(js)
    }
    pub fn metadata(&self) -> String {
        self.metadata.clone()
    }
    pub fn vertices(&self) -> Vec<f32> {
        self.vertices.clone()
    }
    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }
    pub fn collision_vertices(&self) -> Vec<f32> {
        self.collision.positions.iter().flatten().copied().collect()
    }
    pub fn collision_indices(&self) -> Vec<u32> {
        self.collision.indices.clone()
    }
}

#[wasm_bindgen]
pub struct SceneRoot {
    root: WmoRoot,
}

#[wasm_bindgen]
impl SceneRoot {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<SceneRoot, JsValue> {
        Self::from_bytes(bytes).map_err(js)
    }
    pub fn metadata(&self) -> String {
        json!({
            "groupCount":self.root.group_count(),
            "groups":self.root.group_infos().iter().map(|g| json!({"bounds":[g.bbox_min,g.bbox_max]})).collect::<Vec<_>>(),
            "doodads":self.root.doodads().iter().map(|d| json!({
                "path":d.model,"position":d.position,"orientation":d.orientation,"scale":d.scale,"color":d.color
            })).collect::<Vec<_>>(),
            "sets":self.root.doodad_sets().iter().map(|s| json!({"start":s.start,"count":s.count})).collect::<Vec<_>>()
        }).to_string()
    }
    pub fn group(&self, bytes: &[u8]) -> Result<SceneModel, JsValue> {
        self.decode_group(bytes).map_err(js)
    }
}

impl SceneRoot {
    fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        bounded(bytes)?;
        let root = parse_wmo_root(bytes).map_err(|e| e.to_string())?;
        if root.group_count() > 512 || root.doodads().len() > 20_000 {
            return Err("WMO exceeds 512 groups or 20000 doodads".into());
        }
        Ok(Self { root })
    }
    fn decode_group(&self, bytes: &[u8]) -> Result<SceneModel, String> {
        bounded(bytes)?;
        let subs = wmo_group_submeshes_strict(bytes, &self.root).map_err(|e| e.to_string())?;
        let mut collision = CollisionMesh::default();
        accumulate_wmo_group_collision(bytes, &mut collision.positions, &mut collision.indices);
        SceneModel::build(subs, collision)
    }
}

#[wasm_bindgen]
pub struct SceneTexture {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl SceneTexture {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<SceneTexture, JsValue> {
        Self::decode(bytes).map_err(js)
    }
    pub fn metadata(&self) -> String {
        json!({"width":self.width,"height":self.height}).to_string()
    }
    pub fn rgba(&self) -> Vec<u8> {
        self.rgba.clone()
    }
}

impl SceneTexture {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        bounded(bytes)?;
        if bytes.len() < 20 || &bytes[..4] != b"BLP2" {
            return Err("Expected a BLP2 scene texture".into());
        }
        let width = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        let height = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
        if width == 0 || height == 0 || width > 2048 || height > 2048 {
            return Err("Scene texture exceeds 2048 pixels per side".into());
        }
        let (width, height, rgba) = blp_to_rgba(bytes).map_err(|e| e.to_string())?;
        Ok(Self {
            width,
            height,
            rgba,
        })
    }
}

#[wasm_bindgen]
pub struct TerrainMaterial {
    vertices: Vec<f32>,
    indices: Vec<u32>,
    masks: Vec<u8>,
    paths: Vec<String>,
}

impl TerrainMaterial {
    fn build(tile: &benilla_formats::TileMesh, x: u32, y: u32) -> Result<Self, String> {
        if tile.chunks.is_empty() || tile.chunks.len() > 256 {
            return Err("Terrain requires 1..256 authored chunks".into());
        }
        let mut out = Self {
            vertices: Vec::new(),
            indices: Vec::new(),
            masks: vec![0; tile.chunks.len() * 64 * 64 * 4],
            paths: Vec::new(),
        };
        let nw = [
            (32.0 - f64::from(y)) * crate::voyage::TILE,
            (32.0 - f64::from(x)) * crate::voyage::TILE,
        ];
        for (chunk_id, chunk) in tile.chunks.iter().enumerate() {
            validate_mesh(&chunk.positions, &chunk.indices)?;
            if chunk.normals.len() != chunk.positions.len()
                || chunk.uvs.len() != chunk.positions.len()
                || chunk.layer_textures.is_empty()
                || chunk.layer_textures.len() > 4
                || chunk
                    .alpha_map
                    .as_ref()
                    .is_some_and(|a| a.len() != 64 * 64 * 4)
                || chunk.shadow.as_ref().is_some_and(|s| s.len() != 64 * 64)
            {
                return Err(format!(
                    "Invalid terrain material streams in chunk {chunk_id}"
                ));
            }
            let mut layers = [0.0; 4];
            for (layer, path) in chunk.layer_textures.iter().enumerate() {
                let path = path.replace('/', "\\").to_ascii_lowercase();
                let index = if let Some(index) = out.paths.iter().position(|p| p == &path) {
                    index
                } else {
                    if out.paths.len() == 64 {
                        return Err("Terrain tile exceeds 64 unique texture layers".into());
                    }
                    out.paths.push(path);
                    out.paths.len() - 1
                };
                layers[layer] = index as f32;
            }
            for layer in chunk.layer_textures.len()..4 {
                layers[layer] = layers[0];
            }
            let mask = &mut out.masks[chunk_id * 16384..(chunk_id + 1) * 16384];
            for (i, pixel) in mask.chunks_exact_mut(4).enumerate() {
                if let Some(alpha) = &chunk.alpha_map {
                    pixel[..3].copy_from_slice(&alpha[i * 4..i * 4 + 3]);
                }
                pixel[3] = chunk.shadow.as_ref().map_or(0, |s| s[i]);
            }
            let base = (out.vertices.len() / 13) as u32;
            for (i, p) in chunk.positions.iter().enumerate() {
                let n = chunk.normals[i];
                let uv = chunk.uvs[i];
                if n.iter().chain(uv.iter()).any(|v| !v.is_finite())
                    || n.iter().map(|v| v * v).sum::<f32>() < 0.01
                {
                    return Err("Invalid authored terrain normal or UV".into());
                }
                out.vertices.extend([
                    (nw[1] - f64::from(p[1])) as f32,
                    p[2],
                    (nw[0] - f64::from(p[0])) as f32,
                    -n[1],
                    n[2],
                    -n[0],
                    uv[0],
                    uv[1],
                    layers[0],
                    layers[1],
                    layers[2],
                    layers[3],
                    chunk_id as f32,
                ]);
            }
            // The native fan indices already omit every authored MCNK hole.
            out.indices.extend(chunk.indices.iter().map(|i| base + i));
        }
        Ok(out)
    }
}

#[wasm_bindgen]
impl TerrainMaterial {
    pub fn vertices(&self) -> Vec<f32> {
        self.vertices.clone()
    }
    pub fn indices(&self) -> Vec<u32> {
        self.indices.clone()
    }
    pub fn masks(&self) -> Vec<u8> {
        self.masks.clone()
    }
    pub fn paths(&self) -> String {
        serde_json::to_string(&self.paths).expect("texture paths")
    }
}

#[wasm_bindgen]
impl Voyage {
    pub fn terrain_material(&self, index: usize) -> Result<TerrainMaterial, JsValue> {
        let tile = self
            .resident
            .get(&index)
            .ok_or_else(|| js("Tile is not resident"))?;
        let entry = &self.manifest.tiles[index];
        TerrainMaterial::build(tile, entry.x, entry.y).map_err(js)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_corrupt_and_oversize_inputs() {
        assert!(placements(b"bad").is_err());
        assert!(SceneModel::from_m2(b"bad", "bad.m2", "[]").is_err());
        assert!(SceneRoot::from_bytes(b"bad").is_err());
        assert!(SceneTexture::decode(b"bad").is_err());
        assert!(validate_mesh(&[[0.0; 3]], &[0, 1, 0]).is_err());
        assert!(validate_mesh(&[[f32::NAN; 3]], &[]).is_err());
        assert!(validate_mesh(&[[0.0; 3]], &[0]).is_err());
    }

    #[test]
    fn authored_terrain_material_streams_match_native_layers_masks_normals_and_holes() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let mut layered = 0;
        let mut shadowed = 0;
        let mut holes = 0;
        let mut colored_textures = 0;
        for (map, x, y) in [
            ("Kalimdor", 39, 43),
            ("Azeroth", 32, 48),
            ("Azeroth", 30, 48),
            ("Kalimdor", 40, 30),
        ] {
            let bytes = chain
                .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
                .unwrap();
            let tile = adt_to_tile_mesh(&bytes).unwrap();
            let material = TerrainMaterial::build(&tile, x, y).unwrap();
            assert_eq!(
                material.indices.len(),
                tile.chunks.iter().map(|c| c.indices.len()).sum::<usize>()
            );
            assert_eq!(material.vertices.len(), tile.vertex_count() * 13);
            assert_eq!(material.masks.len(), tile.chunks.len() * 16384);
            let mut vertex = 0;
            let mut index = 0;
            for (id, chunk) in tile.chunks.iter().enumerate() {
                layered += usize::from(chunk.layer_textures.len() > 1);
                holes += chunk.holes.count_ones();
                for i in 0..chunk.positions.len() {
                    let v = &material.vertices[(vertex + i) * 13..(vertex + i + 1) * 13];
                    assert_eq!(&v[6..8], &chunk.uvs[i]);
                    assert_eq!(
                        &v[3..6],
                        &[
                            -chunk.normals[i][1],
                            chunk.normals[i][2],
                            -chunk.normals[i][0]
                        ]
                    );
                    assert_eq!(v[12], id as f32);
                    for (layer, path) in chunk.layer_textures.iter().enumerate() {
                        assert_eq!(
                            material.paths[v[8 + layer] as usize],
                            path.to_ascii_lowercase()
                        );
                    }
                }
                for &i in &chunk.indices {
                    assert_eq!(material.indices[index], vertex as u32 + i);
                    index += 1;
                }
                for pixel in 0..4096 {
                    let mask = &material.masks[id * 16384 + pixel * 4..][..4];
                    assert_eq!(mask[3], chunk.shadow.as_ref().map_or(0, |s| s[pixel]));
                    shadowed += usize::from(mask[3] != 0);
                    assert_eq!(
                        &mask[..3],
                        chunk
                            .alpha_map
                            .as_ref()
                            .map_or(&[0, 0, 0][..], |a| &a[pixel * 4..pixel * 4 + 3])
                    );
                }
                vertex += chunk.positions.len();
            }
            for path in material.paths {
                let texture = SceneTexture::decode(&chain.read_file(&path).unwrap()).unwrap();
                assert_eq!(texture.rgba.len(), (texture.width * texture.height * 4) as usize);
                colored_textures += usize::from(
                    texture
                        .rgba
                        .chunks_exact(4)
                        .any(|p| p[0] != p[1] || p[1] != p[2])
                );
            }
        }
        assert!(layered > 0 && shadowed > 0 && holes > 0 && colored_textures > 0);
    }

    #[test]
    fn modf_bounds_are_source_world_aabbs_not_rotated_model_bounds() {
        let mut record = [0u8; 64];
        record[4..8].copy_from_slice(&7u32.to_le_bytes());
        for (i, value) in [10f32, 20., 30., 40., 50., 60.].iter().enumerate() {
            record[32 + i * 4..36 + i * 4].copy_from_slice(&value.to_le_bytes());
        }
        let mut bytes = b"FDOM".to_vec();
        bytes.extend(64u32.to_le_bytes());
        bytes.extend(record);
        let center = 32.0 * benilla_formats::TILE_SIZE;
        assert_eq!(
            modf_bounds(&bytes).unwrap()[&7],
            [
                [center - 60., center - 40., 20.],
                [center - 30., center - 10., 50.]
            ]
        );
        bytes.pop();
        assert!(modf_bounds(&bytes).is_err());
    }

    #[test]
    fn source_geometry_and_alpha_survive_browser_payload() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let tree = "World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnTree01\\ElwynnPine01.m2";
        let bytes = chain.read_file(tree).unwrap();
        let model = SceneModel::from_m2(&bytes, tree, "[]").unwrap();
        assert_eq!(model.indices.len() / 3, 68);
        assert_eq!(model.collision.indices.len() / 3, 6);
        let meta: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
        let cutout = meta["batches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["alphaCutoff"].as_f64().unwrap() > 0.0)
            .unwrap();
        let tex = chain
            .read_file(cutout["texture"].as_str().unwrap())
            .unwrap();
        let tex = SceneTexture::decode(&tex).unwrap();
        assert!(tex.rgba.as_chunks::<4>().0.iter().any(|p| p[3] < 224));
        assert!(tex.rgba.as_chunks::<4>().0.iter().any(|p| p[3] >= 224));
        assert!(
            model
                .vertices
                .as_chunks::<12>()
                .0
                .iter()
                .all(|v| v.iter().all(|x| x.is_finite()))
        );
    }

    #[test]
    fn real_inn_keeps_render_surfaces_and_authored_collision() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let path = "World\\wmo\\Azeroth\\Buildings\\GoldshireInn\\GoldshireInn";
        let root =
            SceneRoot::from_bytes(&chain.read_file(&format!("{path}.wmo")).unwrap()).unwrap();
        let mut triangles = 0;
        let mut collision = 0;
        for i in 0..root.root.group_count() {
            let bytes = chain.read_file(&format!("{path}_{i:03}.wmo")).unwrap();
            let group = root.decode_group(&bytes).unwrap();
            triangles += group.indices.len() / 3;
            collision += group.collision.indices.len() / 3;
        }
        assert_eq!(triangles, 24_274);
        assert!(collision > 100);
        assert!(root.decode_group(b"not a WMO group").is_err());
    }

    #[test]
    fn both_continents_provide_authored_nearby_models_and_finite_placements() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        for (map, x, y) in [("Kalimdor", 39, 43), ("Azeroth", 32, 48)] {
            let bytes = chain
                .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
                .unwrap();
            let refs: Vec<serde_json::Value> =
                serde_json::from_str(&placements(&bytes).unwrap()).unwrap();
            assert!(!refs.is_empty(), "{map} has authored placements");
            let mut seen = std::collections::HashSet::new();
            let mut decoded = 0;
            for p in &refs {
                assert!(
                    p["position"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|v| v.as_f64().is_some_and(f64::is_finite))
                );
                let raw_path = p["path"].as_str().unwrap().to_ascii_lowercase();
                if p["kind"] != "m2" || !seen.insert(raw_path.clone()) || decoded >= 8 {
                    continue;
                }
                let path = raw_path
                    .strip_suffix(".mdx")
                    .map_or(raw_path.clone(), |s| format!("{s}.m2"));
                let bytes = chain.read_file(&path).unwrap();
                let model = SceneModel::from_m2(&bytes, &path, "[]").unwrap();
                assert!(!model.indices.is_empty(), "{path}");
                decoded += 1;
            }
            assert!(decoded > 0, "{map} models decoded");
            eprintln!(
                "{map}: {} placements, {decoded} distinct authored M2 models decoded",
                refs.len()
            );
        }
    }

    #[test]
    fn real_baked_npc_has_a_visible_body_without_unresolved_cutout_cards() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let catalog = benilla_formats::load_creature_catalog(&mut chain).unwrap();
        let creature = catalog
            .display_models()
            .filter_map(|(id, _)| catalog.model(id))
            .find(|m| {
                m.npc_appearance
                    .as_ref()
                    .is_some_and(|a| a.bake_name.is_some())
            })
            .unwrap();
        let path = creature
            .model_path
            .to_ascii_lowercase()
            .replace(".mdx", ".m2");
        let mut skins = creature.textures.to_vec();
        skins.push(
            creature
                .npc_appearance
                .unwrap()
                .bake_name
                .map(|name| format!("Textures\\BakedNpcTextures\\{name}")),
        );
        let bytes = chain.read_file(&path).unwrap();
        let model =
            SceneModel::from_m2(&bytes, &path, &serde_json::to_string(&skins).unwrap()).unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
        let batches = metadata["batches"].as_array().unwrap();
        assert!(batches.iter().any(|b| {
            b["texture"]
                .as_str()
                .is_some_and(|s| s.contains("BakedNpcTextures"))
        }));
        assert!(
            batches
                .iter()
                .all(|b| b["alphaCutoff"].as_f64().unwrap() == 0.0 || b["texture"].is_string()),
            "Unresolved character cutouts hide an otherwise valid baked NPC"
        );
    }
}
