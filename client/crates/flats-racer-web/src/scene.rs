//! Deviation: bounded, static browser scene meshes, not the native animated world renderer.
use crate::voyage::Voyage;
use benilla_formats::{
    CollisionMesh, LiquidKind, ModelBlend, RenderSubmesh, TileMesh, WmoRoot,
    accumulate_wmo_group_collision, adt_to_tile_mesh, blp_to_rgba, parse_m2_collision_hull,
    parse_m2_render_submeshes, parse_wmo_root, wmo_group_liquid_mesh,
    wmo_group_submeshes_strict,
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

fn craft_display(models: &[u8], displays: &[u8]) -> Result<String, String> {
    display_json(models, displays)
}

fn display_json(models: &[u8], displays: &[u8]) -> Result<String, String> {
    bounded(models)?;
    bounded(displays)?;
    let catalog =
        benilla_formats::parse_creature_catalog(models, displays).map_err(|e| e.to_string())?;
    let id = 10318;
    let model = catalog
        .model(id)
        .ok_or_else(|| format!("Creature display {id} is unavailable"))?;
    let scale = catalog
        .display_scale(id)
        .ok_or("Craft display scale is unavailable")?;
    if !scale.is_finite() || scale <= 0.0 || scale > 10.0 || model.model_path.is_empty() {
        return Err("Invalid authored craft display".into());
    }
    Ok(
        json!({"display":id,"path":model.model_path,"scale":scale,"skins":model.textures,
        "pose":"bind-pose","cockpitAvailable":false})
        .to_string(),
    )
}

#[wasm_bindgen]
pub fn scene_craft_display(models: &[u8], displays: &[u8]) -> Result<String, JsValue> {
    craft_display(models, displays).map_err(js)
}

/// Display id -> model map for a trimmed public NPC pack, resolved from the user's own DBCs (same shape resolve_npcs writes).
fn resolve_displays(models: &[u8], displays: &[u8], extra: &[u8], ids: &[u32]) -> Result<String, String> {
    bounded(models)?;
    bounded(displays)?;
    bounded(extra)?;
    let catalog = benilla_formats::parse_creature_catalog(models, displays)
        .map_err(|e| e.to_string())?
        .with_extra(benilla_formats::parse_creature_display_info_extra(extra).unwrap_or_default());
    let mut out = serde_json::Map::new();
    for &id in ids {
        let Some(model) = catalog.model(id) else { continue };
        let mut skins = model.textures.to_vec();
        skins.push(
            model.npc_appearance.as_ref().and_then(|a| a.bake_name.as_ref())
                .map(|name| format!("Textures\\BakedNpcTextures\\{name}")),
        );
        out.insert(id.to_string(), json!({"path": model.model_path, "scale": model.scale, "skins": skins,
            "appearance": if model.npc_appearance.is_some() { "baked-body-no-equipment" } else { "creature-bind-pose" }}));
    }
    Ok(serde_json::Value::Object(out).to_string())
}

#[wasm_bindgen]
pub fn scene_resolve_displays(models: &[u8], displays: &[u8], extra: &[u8], ids: &[u32]) -> Result<String, JsValue> {
    resolve_displays(models, displays, extra, ids).map_err(js)
}

fn craft_metadata(bytes: &[u8]) -> Result<String, String> {
    bounded(bytes)?;
    let attachments = benilla_formats::parse_m2_attachments(bytes).map_err(|e| e.to_string())?;
    let seat = attachments.iter().find(|a| a.id == 0).map(
        |a| json!({"bone":a.bone,"position":a.position,"space":"model-local","pose":"bind-pose"}),
    );
    Ok(
        json!({"attachment0":seat,"pose":"bind-pose","cockpitAvailable":false,
        "cockpitBlocker":"No selected rider model/head height or animated seat bone pose"})
        .to_string(),
    )
}

#[wasm_bindgen]
pub fn scene_craft_metadata(bytes: &[u8]) -> Result<String, JsValue> {
    craft_metadata(bytes).map_err(js)
}

#[wasm_bindgen]
pub fn scene_placements(bytes: &[u8]) -> Result<String, JsValue> {
    placements(bytes).map_err(js)
}

fn placements(bytes: &[u8]) -> Result<String, String> {
    bounded(bytes)?;
    let tile = adt_to_tile_mesh(bytes).map_err(|e| e.to_string())?;
    tile_placements(&tile, bytes)
}

fn tile_placements(tile: &TileMesh, bytes: &[u8]) -> Result<String, String> {
    let bounds = modf_bounds(bytes)?;
    if tile.doodads.len() + tile.wmos.len() > 20_000 {
        return Err("ADT exceeds 20000 scene placements".into());
    }
    let mut out = Vec::new();
    for d in &tile.doodads {
        out.push(json!({"kind":"m2", "id":d.unique_id, "path":d.model,
            "position":d.position, "rotation":d.rotation, "scale":d.scale, "doodadSet":0}));
    }
    for d in &tile.wmos {
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    water: bool,
}

#[wasm_bindgen]
pub struct SceneModel {
    vertices: Vec<f32>,
    indices: Vec<u32>,
    collision: CollisionMesh,
    water: CollisionMesh,
    metadata: String,
}

impl SceneModel {
    fn build(subs: Vec<(RenderSubmesh, bool)>, collision: CollisionMesh) -> Result<Self, String> {
        let count: usize = subs.iter().map(|(s, _)| s.indices.len()).sum();
        if count > MAX_TRIANGLES * 3 || collision.indices.len() > MAX_TRIANGLES * 3 {
            return Err("Scene model exceeds 200000 triangles".into());
        }
        validate_mesh(&collision.positions, &collision.indices)?;
        let mut vertices = Vec::new();
        let mut indices = Vec::with_capacity(count);
        let mut batches = Vec::new();
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for (sub, water) in subs {
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
                water,
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
            water: CollisionMesh::default(),
            metadata,
        })
    }

    fn from_m2(bytes: &[u8], path: &str, skins: &str) -> Result<Self, String> {
        Self::decode_m2(bytes, path, skins, false)
    }

    fn decode_m2(bytes: &[u8], path: &str, skins: &str, stand: bool) -> Result<Self, String> {
        bounded(bytes)?;
        let skins: Vec<Option<String>> = serde_json::from_str(skins).map_err(|e| e.to_string())?;
        if skins.len() > 4 || path.len() > 1024 {
            return Err("Invalid M2 skin/path metadata".into());
        }
        let dir = path.rsplit_once(['\\', '/']).map_or("", |(dir, _)| dir);
        let mut subs = parse_m2_render_submeshes(bytes, dir, &skins).map_err(|e| e.to_string())?;
        let posed_seat = if stand {
            benilla_formats::bake_m2_stand_pose(bytes, &mut subs).map_err(|e| e.to_string())?
        } else {
            None
        };
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
        let mut model = Self::build(
            subs.into_iter().map(|sub| (sub, false)).collect(),
            collision,
        )?;
        if omitted_character_batches > 0 || stand {
            let mut metadata: serde_json::Value =
                serde_json::from_str(&model.metadata).map_err(|e| e.to_string())?;
            if omitted_character_batches > 0 {
                metadata["omittedCharacterBatches"] = omitted_character_batches.into();
                metadata["appearance"] = "baked-body-only".into();
            }
            if stand {
                metadata["animation"] = "stand-frame-0".into();
                metadata["posedAttachment0"] = posed_seat
                    .map(|a| json!({"bone":a.bone,"position":a.position,"space":"model-local","pose":"stand-frame-0"}))
                    .unwrap_or(serde_json::Value::Null);
            }
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

    pub fn craft(bytes: &[u8], path: &str, skins: &str) -> Result<SceneModel, JsValue> {
        Self::decode_m2(bytes, path, skins, true).map_err(js)
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
    /// Authored WMO liquid surface (model space); a rideable surface, never solid collision.
    pub fn water_vertices(&self) -> Vec<f32> {
        self.water.positions.iter().flatten().copied().collect()
    }
    pub fn water_indices(&self) -> Vec<u32> {
        self.water.indices.clone()
    }
}

const ACTOR_MAX_VERTICES: usize = 20_000;

/// A bind-pose creature that can be re-posed (Stand `0`, Walk `4`) for the browser's bounded
/// nearby animation. It shares `SceneModel`'s vertex order and 12-float layout.
#[wasm_bindgen]
pub struct SceneActor {
    bind: Vec<RenderSubmesh>,
    rig: benilla_formats::M2Rig,
    vertices: Vec<f32>,
}

impl SceneActor {
    fn decode(bytes: &[u8], path: &str, skins: &str) -> Result<Self, String> {
        bounded(bytes)?;
        let skins: Vec<Option<String>> = serde_json::from_str(skins).map_err(|e| e.to_string())?;
        if skins.len() > 3 || path.len() > 1024 {
            return Err("Invalid actor skin/path metadata".into());
        }
        let dir = path.rsplit_once(['\\', '/']).map_or("", |(dir, _)| dir);
        let bind = parse_m2_render_submeshes(bytes, dir, &skins).map_err(|e| e.to_string())?;
        let mut vertices = Vec::new();
        for sub in &bind {
            let n = sub.positions.len();
            if sub.normals.len() != n
                || sub.uvs.len() != n
                || sub.joints.len() != n
                || sub.weights.len() != n
                || (!sub.vertex_colors.is_empty() && sub.vertex_colors.len() != n)
                || vertices.len() / 12 + n > ACTOR_MAX_VERTICES
            {
                return Err("Actor streams are inconsistent or too large".into());
            }
            for i in 0..n {
                vertices.extend(sub.positions[i]);
                vertices.extend(sub.normals[i]);
                vertices.extend(sub.uvs[i]);
                vertices.extend(sub.vertex_colors.get(i).copied().unwrap_or([1.0; 4]));
            }
        }
        let rig = benilla_formats::M2Rig::new(bytes, &bind, &[0, 4]).map_err(|e| e.to_string())?;
        if rig.duration(0).is_none() {
            return Err("Actor has no Stand clip".into());
        }
        Ok(Self {
            bind,
            rig,
            vertices,
        })
    }
}

#[wasm_bindgen]
impl SceneActor {
    pub fn create(bytes: &[u8], path: &str, skins: &str) -> Result<SceneActor, JsValue> {
        Self::decode(bytes, path, skins).map_err(js)
    }

    /// Clip length in seconds; `0` when the model lacks it.
    pub fn duration(&self, anim_id: u16) -> f32 {
        self.rig.duration(anim_id).unwrap_or(0.0)
    }

    pub fn vertex_count(&self) -> usize {
        self.vertices.len() / 12
    }

    /// The complete interleaved vertices posed `seconds` into `anim_id` (looped).
    pub fn pose(&self, anim_id: u16, seconds: f32) -> Result<Vec<f32>, JsValue> {
        let mut out = self.vertices.clone();
        self.rig
            .pose_into(&self.bind, anim_id, seconds, &mut out)
            .map_err(js)?;
        Ok(out)
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
        let mut subs: Vec<(RenderSubmesh, bool)> = wmo_group_submeshes_strict(bytes, &self.root)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|sub| (sub, false))
            .collect();
        let mut water = CollisionMesh::default();
        if let Some(liquid) = wmo_group_liquid_mesh(bytes) {
            if matches!(liquid.kind, LiquidKind::Still | LiquidKind::Ocean) {
                if liquid.depths.len() != liquid.positions.len()
                    || liquid.uvs.len() != liquid.positions.len()
                    || liquid
                        .depths
                        .iter()
                        .any(|&depth| !depth.is_finite() || !(0.0..=1.0).contains(&depth))
                {
                    return Err("Invalid WMO liquid depth ramp".into());
                }
                water.positions = liquid.positions.clone();
                water.indices = liquid.indices.clone();
                subs.push((
                    RenderSubmesh {
                        positions: liquid.positions,
                        normals: vec![[0.0, 0.0, 1.0]; liquid.uvs.len()],
                        uvs: liquid.depths.iter().map(|&depth| [depth, 0.0]).collect(),
                        indices: liquid.indices,
                        texture: None,
                        skin_slot: None,
                        geoset_id: 0,
                        char_slot: None,
                        blend: ModelBlend::Opaque,
                        wrap_x: false,
                        wrap_y: false,
                        two_sided: true,
                        joints: Vec::new(),
                        weights: Vec::new(),
                        vertex_colors: vec![[1.0; 4]; liquid.uvs.len()],
                        interior: false,
                        emissive: false,
                        icon_slot: false,
                        sidn: None,
                        window: false,
                        additive: false,
                        no_depth_write: false,
                        no_depth_test: false,
                        fog_policy: Default::default(),
                        billboard: None,
                        welded_billboard: false,
                        alpha_anim: None,
                        uv_anim: None,
                        uv_seq: None,
                        uv_rot_seq: None,
                        uv_scale_seq: None,
                        rgb_anim: None,
                        rgb_seq: None,
                        wmo_batch: None,
                        section: None,
                        env_map: false,
                    },
                    true,
                ));
            }
        }
        let mut collision = CollisionMesh::default();
        accumulate_wmo_group_collision(bytes, &mut collision.positions, &mut collision.indices);
        let mut model = SceneModel::build(subs, collision)?;
        model.water = water;
        Ok(model)
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
    nw: [f64; 2],
    chunks: usize,
}

impl TerrainMaterial {
    fn begin(tile: &benilla_formats::TileMesh, x: u32, y: u32) -> Result<Self, String> {
        if tile.chunks.is_empty() || tile.chunks.len() > 256 {
            return Err("Terrain requires 1..256 authored chunks".into());
        }
        Ok(Self {
            vertices: Vec::with_capacity(tile.vertex_count() * 13),
            indices: Vec::with_capacity(tile.chunks.iter().map(|c| c.indices.len()).sum()),
            masks: Vec::with_capacity(tile.chunks.len() * 64 * 64 * 4),
            paths: Vec::new(),
            nw: [
                (32.0 - f64::from(y)) * crate::voyage::TILE,
                (32.0 - f64::from(x)) * crate::voyage::TILE,
            ],
            chunks: tile.chunks.len(),
        })
    }

    fn step(&mut self, tile: &benilla_formats::TileMesh, x: u32, y: u32) -> Result<bool, String> {
        if self.chunks != tile.chunks.len()
            || self.nw
                != [
                    (32.0 - f64::from(y)) * crate::voyage::TILE,
                    (32.0 - f64::from(x)) * crate::voyage::TILE,
                ]
        {
            return Err("Terrain material belongs to a different tile".into());
        }
        let chunk_id = self.masks.len() / 16384;
        if chunk_id == self.chunks {
            return Ok(true);
        }
        let chunk = &tile.chunks[chunk_id];
        let nw = self.nw;
        let out = self;
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
        out.masks.resize((chunk_id + 1) * 16384, 0);
        let mask = &mut out.masks[chunk_id * 16384..(chunk_id + 1) * 16384];
        for (i, pixel) in mask.as_chunks_mut::<4>().0.iter_mut().enumerate() {
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
        Ok(chunk_id + 1 == out.chunks)
    }

    fn build(tile: &benilla_formats::TileMesh, x: u32, y: u32) -> Result<Self, String> {
        let mut out = Self::begin(tile, x, y)?;
        while !out.step(tile, x, y)? {}
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
    pub fn prepared_tile_placements(&self, bytes: &[u8]) -> Result<String, JsValue> {
        bounded(bytes).map_err(js)?;
        let (_, tile) = self
            .prepared_tile
            .as_ref()
            .ok_or_else(|| js("Terrain tile is not prepared"))?;
        tile_placements(tile, bytes).map_err(js)
    }

    pub fn tile_placements(&self, index: usize, bytes: &[u8]) -> Result<String, JsValue> {
        bounded(bytes).map_err(js)?;
        let tile = self
            .resident
            .get(&index)
            .ok_or_else(|| js("Tile is not resident"))?;
        tile_placements(tile, bytes).map_err(js)
    }

    pub fn terrain_material(&self, index: usize) -> Result<TerrainMaterial, JsValue> {
        let tile = self
            .resident
            .get(&index)
            .ok_or_else(|| js("Tile is not resident"))?;
        let entry = &self.manifest.tiles[index];
        TerrainMaterial::build(tile, entry.x, entry.y).map_err(js)
    }

    pub fn begin_terrain_material(&self, index: usize) -> Result<TerrainMaterial, JsValue> {
        let tile = self
            .resident
            .get(&index)
            .ok_or_else(|| js("Tile is not resident"))?;
        let entry = &self.manifest.tiles[index];
        TerrainMaterial::begin(tile, entry.x, entry.y).map_err(js)
    }

    pub fn step_terrain_material(
        &self,
        index: usize,
        material: &mut TerrainMaterial,
    ) -> Result<bool, JsValue> {
        let tile = self
            .resident
            .get(&index)
            .ok_or_else(|| js("Tile is not resident"))?;
        let entry = &self.manifest.tiles[index];
        material.step(tile, entry.x, entry.y).map_err(js)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_creature_actor_poses_stand_loop_finitely_and_moves() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let mut built = 0;
        for path in [
            "Creature\\Wolf\\Wolf.m2",
            "Creature\\Boar\\Boar.m2",
            "Creature\\Rabbit\\Rabbit.m2",
            "Creature\\Deer\\Deer.m2",
            "Creature\\HumanMaleGuard\\HumanMaleGuard.m2",
        ] {
            let Ok(bytes) = chain.read_file(path) else { continue };
            let Ok(actor) = SceneActor::decode(&bytes, path, "[]") else { continue };
            built += 1;
            let model = SceneModel::from_m2(&bytes, path, "[]").unwrap();
            assert_eq!(actor.vertices.len(), model.vertices.len());
            let duration = actor.rig.duration(0).unwrap();
            let mut first = actor.vertices.clone();
            actor.rig.pose_into(&actor.bind, 0, 0.0, &mut first).unwrap();
            let mut mid = actor.vertices.clone();
            actor.rig.pose_into(&actor.bind, 0, duration * 0.5, &mut mid).unwrap();
            let mut wrapped = actor.vertices.clone();
            actor.rig.pose_into(&actor.bind, 0, duration * 3.0, &mut wrapped).unwrap();
            assert!(first.iter().chain(&mid).all(|v| v.is_finite()));
            assert!(first.iter().zip(&wrapped).all(|(a, b)| (a - b).abs() < 1e-3));
            // UVs and colours are never touched.
            for v in 0..first.len() / 12 {
                assert_eq!(first[v * 12 + 6..v * 12 + 12], model.vertices[v * 12 + 6..v * 12 + 12]);
            }
            assert!(first.iter().zip(&mid).any(|(a, b)| (a - b).abs() > 1e-4), "{path} did not move");
        }
        assert!(built > 0, "no probe creature produced an actor");
    }

    #[test]
    fn actual_racer_display_keeps_complete_model_and_authored_seat_without_inventing_rider() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let models = chain
            .read_file("DBFilesClient\\CreatureModelData.dbc")
            .unwrap();
        let displays = chain
            .read_file("DBFilesClient\\CreatureDisplayInfo.dbc")
            .unwrap();
        let display: serde_json::Value =
            serde_json::from_str(&craft_display(&models, &displays).unwrap()).unwrap();
        assert_eq!(display["display"], 10318);
        assert_eq!(display["scale"], 1.0);
        assert_eq!(
            display["path"],
            "Creature\\GoblinRocketCar\\GoblinRocketCar.mdx"
        );
        let native = benilla_formats::load_creature_catalog(&mut chain)
            .unwrap()
            .model(10318)
            .unwrap();
        assert_eq!(display["path"], native.model_path);
        let bytes = chain
            .read_file("Creature\\GoblinRocketCar\\GoblinRocketCar.m2")
            .unwrap();
        let metadata: serde_json::Value =
            serde_json::from_str(&craft_metadata(&bytes).unwrap()).unwrap();
        assert_eq!(metadata["attachment0"]["bone"], 74);
        assert_eq!(metadata["cockpitAvailable"], false);
        assert!(metadata.get("riderHeadHeight").is_none());
        let model = SceneModel::from_m2(
            &bytes,
            "Creature\\GoblinRocketCar\\GoblinRocketCar.m2",
            &display["skins"].to_string(),
        )
        .unwrap();
        assert_eq!(model.indices.len() / 3, 1566);
        let batches: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
        assert_eq!(batches["batches"].as_array().unwrap().len(), 6);
        for batch in batches["batches"].as_array().unwrap() {
            let texture = batch["texture"].as_str().unwrap();
            SceneTexture::decode(&chain.read_file(texture).unwrap()).unwrap();
        }
        assert!(craft_display(b"bad", b"bad").is_err());
        assert!(craft_metadata(b"bad").is_err());
    }

    #[test]
    fn actual_craft_stand_uses_sequence_start_and_each_weighted_root_not_a_mesh_yaw() {
        use benilla_formats::{bake_m2_stand_pose, parse_m2_animations, parse_m2_skeleton};
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let path = "Creature\\GoblinRocketCar\\GoblinRocketCar.m2";
        let bytes = chain.read_file(path).unwrap();
        let skeleton = parse_m2_skeleton(&bytes).unwrap();
        let animations = parse_m2_animations(&bytes);
        let stand = animations.iter().find(|a| a.anim_id == 0).unwrap();
        assert_eq!(
            (stand.seq_index, stand.start_ms, stand.end_ms),
            (0, 3333, 6667)
        );
        let root0 = stand.bones.iter().find(|k| k.bone == 0).unwrap();
        let root1 = stand.bones.iter().find(|k| k.bone == 1).unwrap();
        assert_eq!(root0.rotation[0].0, 0.0);
        assert!((root0.rotation[0].1[2] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
        assert_eq!(root1.translation[0], (0.0, [-3.1643076, 0.0, 0.8874265]));

        // Independent point walk: child pivot/keys first, then its ancestors in raw M2 axes.
        let reference = |mut p: [f32; 3], mut bone: usize, point: bool| {
            loop {
                let b = skeleton.bones[bone];
                let keys = stand.bones.iter().find(|k| k.bone as usize == bone);
                let scale = keys.and_then(|k| k.scale.first()).map_or([1.0; 3], |k| k.1);
                let translation = keys
                    .and_then(|k| k.translation.first())
                    .map_or([0.0; 3], |k| k.1);
                let mut q = keys
                    .and_then(|k| k.rotation.first())
                    .map_or([0.0, 0.0, 0.0, 1.0], |k| k.1);
                let length = q.iter().map(|x| x * x).sum::<f32>().sqrt();
                for x in &mut q {
                    *x /= length;
                }
                for i in 0..3 {
                    p[i] = (p[i] - if point { b.pivot[i] } else { 0.0 }) * scale[i];
                }
                let cross = |a: [f32; 3], b: [f32; 3]| {
                    [
                        a[1] * b[2] - a[2] * b[1],
                        a[2] * b[0] - a[0] * b[2],
                        a[0] * b[1] - a[1] * b[0],
                    ]
                };
                let v = [q[0], q[1], q[2]];
                let c = cross(v, p);
                let cc = cross(v, c);
                for i in 0..3 {
                    p[i] += 2.0 * (q[3] * c[i] + cc[i])
                        + if point {
                            b.pivot[i] + translation[i]
                        } else {
                            0.0
                        };
                }
                if b.parent < 0 {
                    return p;
                }
                bone = b.parent as usize;
            }
        };
        let raw = parse_m2_render_submeshes(&bytes, "Creature\\GoblinRocketCar", &[]).unwrap();
        let mut baked = raw.clone();
        let seat = bake_m2_stand_pose(&bytes, &mut baked).unwrap().unwrap();
        let mut weighted = 0;
        for (raw, baked) in raw.iter().zip(&baked) {
            assert_eq!(raw.indices, baked.indices);
            assert_eq!(raw.uvs, baked.uvs);
            assert_eq!(raw.texture, baked.texture);
            for i in 0..raw.positions.len() {
                weighted += usize::from(raw.weights[i].iter().filter(|&&w| w > 0.0).count() > 1);
                for (input, actual, point) in [
                    (raw.positions[i], baked.positions[i], true),
                    (raw.normals[i], baked.normals[i], false),
                ] {
                    let mut expected = [0.0; 3];
                    for (&bone, &weight) in raw.joints[i].iter().zip(&raw.weights[i]) {
                        if weight == 0.0 {
                            continue;
                        }
                        let p = reference(input, bone as usize, point);
                        for j in 0..3 {
                            expected[j] += p[j] * weight;
                        }
                    }
                    if !point {
                        let length = expected.iter().map(|x| x * x).sum::<f32>().sqrt();
                        for x in &mut expected {
                            *x /= length;
                        }
                    }
                    for j in 0..3 {
                        assert!(
                            (expected[j] - actual[j]).abs() < 1e-4,
                            "{expected:?} != {actual:?}"
                        );
                    }
                }
            }
        }
        assert!(
            weighted > 100,
            "Exercise the goblin's multi-bone skin, not only rigid chassis"
        );
        let model = SceneModel::decode_m2(&bytes, path, "[]", true).unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
        assert_eq!(metadata["animation"], "stand-frame-0");
        assert_eq!(model.indices.len() / 3, 1566);
        let bounds = &metadata["bounds"];
        let length = bounds[1][0].as_f64().unwrap() - bounds[0][0].as_f64().unwrap();
        let width = bounds[1][1].as_f64().unwrap() - bounds[0][1].as_f64().unwrap();
        assert!(
            length > width * 1.5,
            "Posed chassis must run along model X: {bounds}"
        );
        let raw_seat = benilla_formats::parse_m2_attachments(&bytes)
            .unwrap()
            .into_iter()
            .find(|a| a.id == 0)
            .unwrap();
        let expected = reference(raw_seat.position, raw_seat.bone as usize, true);
        for (actual, expected) in seat.position.iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-5);
        }
        let mut malformed = raw.clone();
        malformed[0].joints[0] = [255; 4];
        assert!(bake_m2_stand_pose(&bytes, &mut malformed).is_err());
    }

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
            let mut staged = TerrainMaterial::begin(&tile, x, y).unwrap();
            for chunk in 0..tile.chunks.len() {
                assert_eq!(
                    staged.step(&tile, x, y).unwrap(),
                    chunk + 1 == tile.chunks.len()
                );
                assert_eq!(staged.masks.len(), (chunk + 1) * 16384);
            }
            assert!(staged.step(&tile, x, y).unwrap());
            assert!(staged.step(&tile, x + 1, y).is_err());
            assert_eq!(staged.vertices, material.vertices);
            assert_eq!(staged.indices, material.indices);
            assert_eq!(staged.masks, material.masks);
            assert_eq!(staged.paths, material.paths);
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
                assert_eq!(
                    texture.rgba.len(),
                    (texture.width * texture.height * 4) as usize
                );
                colored_textures += usize::from(
                    texture
                        .rgba
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .any(|p| p[0] != p[1] || p[1] != p[2]),
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
    fn stormwind_wmo_exports_authored_water_without_collision() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::Chain::open(&data).unwrap();
        let root = SceneRoot::from_bytes(
            &chain
                .read_file("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo")
                .unwrap(),
        )
        .unwrap();
        let wet_bytes = chain
            .read_file("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind_099.wmo")
            .unwrap();
        let dry_bytes = chain
            .read_file("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind_000.wmo")
            .unwrap();
        let authored = wmo_group_liquid_mesh(&wet_bytes).unwrap();
        assert_eq!(authored.kind, LiquidKind::Still);
        assert_eq!(authored.wet.iter().filter(|&&wet| wet).count(), 52);
        assert_eq!(
            authored.wet.len() - authored.wet.iter().filter(|&&wet| wet).count(),
            36
        );
        assert_eq!(authored.positions.len(), 108);
        let (depth_min, depth_max) = authored
            .depths
            .iter()
            .copied()
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), depth| {
                (lo.min(depth), hi.max(depth))
            });
        assert_eq!((depth_min, depth_max), (0.0, 0.3372549));
        assert_eq!(
            authored.depths.iter().filter(|&&depth| depth == 0.0).count(),
            36
        );
        assert_eq!(
            authored
                .depths
                .iter()
                .filter(|&&depth| depth == 0.3372549)
                .count(),
            71
        );
        assert_eq!(
            authored
                .depths
                .iter()
                .filter(|&&depth| depth == 0.19215687)
                .count(),
            1
        );
        let model = root.decode_group(&wet_bytes).unwrap();
        let metadata: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
        let water = metadata["batches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|batch| batch["water"] == true)
            .unwrap();
        assert_eq!(water["texture"], serde_json::Value::Null);
        assert_eq!(water["blend"], "opaque");
        assert_eq!(water["indexCount"], 52 * 6);
        assert_eq!(
            model.indices.len(),
            wmo_group_submeshes_strict(&wet_bytes, &root.root)
                .unwrap()
                .iter()
                .map(|s| s.indices.len())
                .sum::<usize>()
                + 52 * 6
        );
        let mut expected_collision = CollisionMesh::default();
        accumulate_wmo_group_collision(
            &wet_bytes,
            &mut expected_collision.positions,
            &mut expected_collision.indices,
        );
        assert_eq!(model.collision.positions, expected_collision.positions);
        assert_eq!(model.collision.indices, expected_collision.indices);
        assert!(root
            .decode_group(&dry_bytes)
            .unwrap()
            .metadata
            .find("\"water\"")
            .is_none());
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
            let tile = adt_to_tile_mesh(&bytes).unwrap();
            let reused: Vec<serde_json::Value> =
                serde_json::from_str(&tile_placements(&tile, &bytes).unwrap()).unwrap();
            assert_eq!(
                refs, reused,
                "Resident tile reuse must preserve every authored placement"
            );
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
