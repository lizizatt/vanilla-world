//! Deviation: bounded, static browser scene meshes, not the native animated world renderer.
use crate::voyage::Voyage;
use benilla_formats::{
    accumulate_wmo_group_collision, adt_to_tile_mesh, blp_to_rgba, parse_m2_collision_hull,
    parse_m2_render_submeshes, parse_wmo_root, wmo_group_liquid_mesh, wmo_group_submeshes_strict,
    CollisionMesh, LiquidKind, ModelBlend, RenderSubmesh, TileMesh, WmoRoot,
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
fn resolve_displays(
    models: &[u8],
    displays: &[u8],
    extra: &[u8],
    ids: &[u32],
) -> Result<String, String> {
    bounded(models)?;
    bounded(displays)?;
    bounded(extra)?;
    let catalog = benilla_formats::parse_creature_catalog(models, displays)
        .map_err(|e| e.to_string())?
        .with_extra(benilla_formats::parse_creature_display_info_extra(extra).unwrap_or_default());
    let mut out = serde_json::Map::new();
    for &id in ids {
        let Some(model) = catalog.model(id) else {
            continue;
        };
        let mut skins = model.textures.to_vec();
        skins.push(
            model
                .npc_appearance
                .as_ref()
                .and_then(|a| a.bake_name.as_ref())
                .map(|name| format!("Textures\\BakedNpcTextures\\{name}")),
        );
        out.insert(id.to_string(), json!({"path": model.model_path, "scale": model.scale, "skins": skins,
            "appearance": if model.npc_appearance.is_some() { "baked-body-no-equipment" } else { "creature-bind-pose" }}));
    }
    Ok(serde_json::Value::Object(out).to_string())
}

#[wasm_bindgen]
pub fn scene_resolve_displays(
    models: &[u8],
    displays: &[u8],
    extra: &[u8],
    ids: &[u32],
) -> Result<String, JsValue> {
    resolve_displays(models, displays, extra, ids).map_err(js)
}

/// Visible geosets for each character-body NPC display: the bare region bases, with the worn
/// shirt/chest/pants/boots/gloves/belt/tabard rows from ItemDisplayInfo (robe => skirt 1302, else
/// legs 1301). Hair and facial hair keep their bases until CharHairGeosets is wired in.
fn character_geosets(
    models: &[u8],
    displays: &[u8],
    extra: &[u8],
    items: &[u8],
    ids: &[u32],
) -> Result<String, String> {
    for b in [models, displays, extra, items] {
        bounded(b)?;
    }
    let catalog = benilla_formats::parse_creature_catalog(models, displays)
        .map_err(|e| e.to_string())?
        .with_extra(benilla_formats::parse_creature_display_info_extra(extra).unwrap_or_default());
    let items = benilla_formats::parse_item_display_catalog(items).map_err(|e| e.to_string())?;
    let bare = benilla_formats::CharacterGeosets::empty();
    let mut out = serde_json::Map::new();
    for &id in ids {
        let Some(npc) = catalog.model(id).and_then(|m| m.npc_appearance) else {
            continue;
        };
        let mut worn: [Option<&benilla_formats::ItemDisplay>; 8] = [None; 8];
        let mut eq = benilla_formats::EquipGeosets::default();
        for i in 0..8 {
            if npc.equipment[i + 2] != 0 {
                worn[i] = items.get(npc.equipment[i + 2]);
                eq.bodyslots[i] = worn[i].map(|row| row.geoset_groups);
            }
        }
        eq.forearm_dressed = benilla_formats::forearm_dressed(&worn);
        let ids = bare.visible_geosets(npc.race, npc.sex, npc.hair_style, npc.facial_hair, &eq);
        out.insert(id.to_string(), json!(ids.ids()));
    }
    Ok(serde_json::Value::Object(out).to_string())
}

#[wasm_bindgen]
pub fn scene_character_geosets(
    models: &[u8],
    displays: &[u8],
    extra: &[u8],
    items: &[u8],
    ids: &[u32],
) -> Result<String, JsValue> {
    character_geosets(models, displays, extra, items, ids).map_err(js)
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
    #[serde(skip_serializing_if = "Option::is_none")]
    sidn: Option<[u8; 3]>,
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
                sidn: sub.sidn,
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

    #[cfg(test)]
    fn from_m2(bytes: &[u8], path: &str, skins: &str) -> Result<Self, String> {
        Self::decode_m2(bytes, path, skins, false, None)
    }

    fn decode_m2(
        bytes: &[u8],
        path: &str,
        skins: &str,
        stand: bool,
        geosets: Option<Vec<u16>>,
    ) -> Result<Self, String> {
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
        retain_geosets(&mut subs, &geosets);
        let mut omitted_character_batches = 0;
        if let Some(Some(body)) = skins.get(3) {
            for sub in &mut subs {
                if sub.char_slot == Some(benilla_formats::CharSkinSlot::Body) {
                    sub.texture = Some(body.clone());
                }
            }
            omitted_character_batches = retain_baked(&mut subs);
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

/// Optional visible-geoset list (`""` means every geoset); an NPC body shows one variant per group.
fn parse_geosets(json: &str) -> Result<Option<Vec<u16>>, String> {
    if json.is_empty() {
        return Ok(None);
    }
    let ids: Vec<u16> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if ids.len() > 256 {
        return Err("Invalid geoset list".into());
    }
    Ok(Some(ids))
}

fn retain_geosets(subs: &mut Vec<RenderSubmesh>, geosets: &Option<Vec<u16>>) {
    if let Some(ids) = geosets {
        // Like the client's compositor, ids above 1700 are unmanaged and stay visible.
        subs.retain(|s| s.geoset_id > 1700 || ids.contains(&s.geoset_id));
    }
}

/// Baked-body-only NPCs: hair and equipment cards have no texture yet. The actor must apply the
/// same cut so its vertex stream matches the static mesh.
fn retain_baked(subs: &mut Vec<RenderSubmesh>) -> usize {
    let before = subs.len();
    subs.retain(|sub| sub.char_slot.is_none() || sub.texture.is_some());
    before - subs.len()
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
    pub fn m2(
        bytes: &[u8],
        path: &str,
        skins: &str,
        geosets: Option<String>,
    ) -> Result<SceneModel, JsValue> {
        let geosets = parse_geosets(geosets.as_deref().unwrap_or("")).map_err(js)?;
        Self::decode_m2(bytes, path, skins, false, geosets).map_err(js)
    }

    pub fn craft(bytes: &[u8], path: &str, skins: &str) -> Result<SceneModel, JsValue> {
        Self::decode_m2(bytes, path, skins, true, None).map_err(js)
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
    fn decode(
        bytes: &[u8],
        path: &str,
        skins: &str,
        geosets: Option<Vec<u16>>,
    ) -> Result<Self, String> {
        bounded(bytes)?;
        let skins: Vec<Option<String>> = serde_json::from_str(skins).map_err(|e| e.to_string())?;
        if skins.len() > 4 || path.len() > 1024 {
            return Err("Invalid actor skin/path metadata".into());
        }
        let dir = path.rsplit_once(['\\', '/']).map_or("", |(dir, _)| dir);
        let mut bind = parse_m2_render_submeshes(bytes, dir, &skins).map_err(|e| e.to_string())?;
        retain_geosets(&mut bind, &geosets);
        if let Some(Some(body)) = skins.get(3) {
            for sub in &mut bind {
                if sub.char_slot == Some(benilla_formats::CharSkinSlot::Body) {
                    sub.texture = Some(body.clone());
                }
            }
            retain_baked(&mut bind);
        }
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
    pub fn create(
        bytes: &[u8],
        path: &str,
        skins: &str,
        geosets: Option<String>,
    ) -> Result<SceneActor, JsValue> {
        let geosets = parse_geosets(geosets.as_deref().unwrap_or("")).map_err(js)?;
        Self::decode(bytes, path, skins, geosets).map_err(js)
    }

    /// Clip length in seconds; `0` when the model lacks it.
    pub fn duration(&self, anim_id: u16) -> f32 {
        self.rig.duration(anim_id).unwrap_or(0.0)
    }

    /// Authored yd/s of a locomotion clip;   when unset.
    pub fn move_speed(&self, anim_id: u16) -> f32 {
        self.rig.move_speed(anim_id)
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
mod tests;
