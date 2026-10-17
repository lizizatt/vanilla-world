//! Deviation: bounded, static browser scene meshes, not the native animated world renderer.
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
    if tile.doodads.len() + tile.wmos.len() > 20_000 {
        return Err("ADT exceeds 20000 scene placements".into());
    }
    let mut out = Vec::new();
    for d in tile.doodads {
        out.push(json!({"kind":"m2", "id":d.unique_id, "path":d.model,
            "position":d.position, "rotation":d.rotation, "scale":d.scale, "doodadSet":0}));
    }
    for d in tile.wmos {
        out.push(json!({"kind":"wmo", "id":d.unique_id, "path":d.model,
            "position":d.position, "rotation":d.rotation, "scale":1.0, "doodadSet":d.doodad_set}));
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
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
        if let Some(Some(body)) = skins.get(3) {
            for sub in &mut subs {
                if sub.char_slot == Some(benilla_formats::CharSkinSlot::Body) {
                    sub.texture = Some(body.clone());
                }
            }
        }
        let collision = parse_m2_collision_hull(bytes).map_err(|e| e.to_string())?;
        Self::build(subs, collision)
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
}
