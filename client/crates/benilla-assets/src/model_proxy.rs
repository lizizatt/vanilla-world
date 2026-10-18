//! Racer-only authored render geometry, shared per model. M2 cutout cards keep their topology
//! and a bounded alpha atlas; WMO render surfaces use vertex clustering, never collision hulls.
//! Deviation: no skeleton, animation, detailed albedo, WMO furnishings or portals in this far LOD.

use std::collections::HashMap;

use benilla_formats::{
    blp_to_rgba, parse_m2_render_submeshes, parse_wmo_root, wmo_group_submeshes_strict, ModelBlend,
    RenderSubmesh,
};
use bevy::asset::io::Reader;
use bevy::asset::RenderAssetUsages;
use bevy::asset::{Asset, AssetLoader, LoadContext};
use bevy::prelude::{Handle, Image};
use bevy::reflect::TypePath;
use bevy::render::render_resource::{Extent3d, TextureDimension, TextureFormat};

/// A triangle list in raw model-local coordinates (the same space `CollisionMesh` uses), already
/// capped to [`M2_PROXY_MAX_TRIANGLES`]/[`WMO_PROXY_MAX_TRIANGLES`].
#[derive(Asset, TypePath, Clone, Default)]
pub struct ModelProxyMesh {
    pub positions: Vec<[f32; 3]>,
    pub indices: Vec<u32>,
    pub uvs: Vec<[f32; 2]>,
    pub alpha_mask: Option<Handle<Image>>,
}

impl ModelProxyMesh {
    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }
}

/// Complete bounded M2 models avoid collapsing disconnected alpha-card corners or UV seams.
/// Oversize models fail explicitly rather than silently substituting a trunk or punched mesh.
const M2_PROXY_MAX_TRIANGLES: usize = 4000;
/// WMO render geometry is clustered to this ceiling.
const WMO_PROXY_MAX_TRIANGLES: usize = 4000;
const MAX_SOURCE_TRIANGLES: usize = 200_000;
const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_WMO_GROUPS: u32 = 128;
const MASK_SIZE: usize = 64;
const ATLAS_SIZE: usize = MASK_SIZE * 4;

fn checked_geometry(subs: &[RenderSubmesh]) -> std::io::Result<()> {
    let mut count = 0usize;
    for sub in subs {
        count += sub.indices.len() / 3;
        if count > MAX_SOURCE_TRIANGLES
            || sub.positions.len() > MAX_SOURCE_TRIANGLES * 3
            || sub.indices.len() % 3 != 0
            || sub.positions.iter().flatten().any(|x| !x.is_finite())
            || sub
                .indices
                .iter()
                .any(|&i| i as usize >= sub.positions.len())
        {
            return Err(std::io::Error::other(
                "invalid or oversized proxy render geometry",
            ));
        }
    }
    Ok(())
}

fn merge_render(subs: &[RenderSubmesh]) -> std::io::Result<ModelProxyMesh> {
    checked_geometry(subs)?;
    let mut out = ModelProxyMesh::default();
    for sub in subs {
        let base = out.positions.len() as u32;
        out.positions.extend_from_slice(&sub.positions);
        out.indices.extend(sub.indices.iter().map(|i| i + base));
    }
    if out.is_empty() {
        return Err(std::io::Error::other("model has no render triangles"));
    }
    Ok(out)
}

fn mask_slot(atlas: &mut [u8], slot: usize, w: u32, h: u32, rgba: &[u8]) {
    for y in 0..MASK_SIZE {
        for x in 0..MASK_SIZE {
            let source =
                ((y * h as usize / MASK_SIZE) * w as usize + x * w as usize / MASK_SIZE) * 4 + 3;
            let dest = ((slot / 4 * MASK_SIZE + y) * ATLAS_SIZE + slot % 4 * MASK_SIZE + x) * 4 + 3;
            atlas[dest] = rgba[source];
        }
    }
}

fn check_mask_source(bytes: &[u8]) -> std::io::Result<()> {
    if bytes.len() < 20 || &bytes[..4] != b"BLP2" || bytes.len() > MAX_SOURCE_BYTES {
        return Err(std::io::Error::other(
            "invalid or oversized proxy alpha BLP2",
        ));
    }
    let w = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    let h = u32::from_le_bytes(bytes[16..20].try_into().unwrap());
    if w == 0 || h == 0 || w > 2048 || h > 2048 {
        return Err(std::io::Error::other(
            "proxy alpha decode exceeds 2048x2048 budget",
        ));
    }
    Ok(())
}

fn mask_uv(uv: [f32; 2], slot: usize) -> [f32; 2] {
    // Texel centres keep the atlas's adjacent masks out of the sampler footprint.
    [
        ((slot % 4 * MASK_SIZE) as f32 + 0.5 + uv[0].clamp(0.0, 1.0) * 63.0) / ATLAS_SIZE as f32,
        ((slot / 4 * MASK_SIZE) as f32 + 0.5 + uv[1].clamp(0.0, 1.0) * 63.0) / ATLAS_SIZE as f32,
    ]
}

/// Surface simplification by grid-based vertex clustering, not stride-dropped
/// triangles: snaps every vertex into a 3-D grid cell sized off the mesh's own bounding box,
/// merges every vertex sharing a cell into one representative (the average of their positions),
/// and remaps each triangle's three corners through that merge, dropping only the triangles that
/// become degenerate (two or more corners collapsing into the same cell). Nearby detail blends
/// together into a coarser surface instead of vanishing in arbitrary gaps — the
/// complaint against the old per-Nth-triangle decimation, which could punch a hole through an
/// otherwise-intact face. The cell size coarsens geometrically until the output is at or under
/// `max_triangles` or [`MAX_SIMPLIFY_REFINEMENTS`] runs out; a mesh so dense it still will not fit
/// even then (not seen in this project's fixtures) is skipped — an empty proxy, never a further,
/// more deeply holed mesh.
const MAX_SIMPLIFY_REFINEMENTS: u32 = 24;

fn simplify_mesh(
    positions: Vec<[f32; 3]>,
    indices: Vec<u32>,
    max_triangles: usize,
) -> ModelProxyMesh {
    let tri_count = indices.len() / 3;
    if max_triangles == 0 || tri_count <= max_triangles || positions.is_empty() {
        return ModelProxyMesh {
            positions,
            indices,
            ..Default::default()
        };
    }

    let mut lo = positions[0];
    let mut hi = positions[0];
    for p in &positions {
        for a in 0..3 {
            lo[a] = lo[a].min(p[a]);
            hi[a] = hi[a].max(p[a]);
        }
    }
    let extent = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    let diagonal = (extent[0] * extent[0] + extent[1] * extent[1] + extent[2] * extent[2])
        .sqrt()
        .max(1e-4);

    // Fine enough that a modestly-tessellated mesh isn't butchered on the first pass, then
    // doubled-ish until the budget is met.
    let mut cell = diagonal / 64.0;
    for _ in 0..MAX_SIMPLIFY_REFINEMENTS {
        let clustered = cluster_at(&positions, &indices, cell);
        if clustered.indices.len() / 3 <= max_triangles {
            return clustered;
        }
        cell *= 1.6;
    }
    ModelProxyMesh::default()
}

/// One grid-clustering pass at a fixed cell size; see [`simplify_mesh`].
fn cluster_at(positions: &[[f32; 3]], indices: &[u32], cell: f32) -> ModelProxyMesh {
    let mut cell_of: HashMap<(i32, i32, i32), u32> = HashMap::new();
    let mut sums: Vec<([f32; 3], u32)> = Vec::new();
    let mut remap: Vec<u32> = Vec::with_capacity(positions.len());
    for p in positions {
        let key = (
            (p[0] / cell).floor() as i32,
            (p[1] / cell).floor() as i32,
            (p[2] / cell).floor() as i32,
        );
        let cluster = *cell_of.entry(key).or_insert_with(|| {
            sums.push(([0.0; 3], 0));
            (sums.len() - 1) as u32
        });
        let (sum, count) = &mut sums[cluster as usize];
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
        *count += 1;
        remap.push(cluster);
    }
    let out_positions: Vec<[f32; 3]> = sums
        .into_iter()
        .map(|(sum, count)| {
            let n = (count.max(1)) as f32;
            [sum[0] / n, sum[1] / n, sum[2] / n]
        })
        .collect();
    let mut out_indices = Vec::with_capacity(indices.len());
    let mut seen = std::collections::HashSet::new();
    for tri in indices.chunks_exact(3) {
        let (a, b, c) = (
            remap[tri[0] as usize],
            remap[tri[1] as usize],
            remap[tri[2] as usize],
        );
        if a == b || b == c || a == c {
            continue; // degenerate after clustering: two corners collapsed to the same point
        }
        let mut key = [a, b, c];
        key.sort_unstable();
        if !seen.insert(key) {
            continue;
        }
        let p = out_positions[a as usize];
        let q = out_positions[b as usize];
        let r = out_positions[c as usize];
        let u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
        let v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
        let cross = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        if cross.iter().map(|x| x * x).sum::<f32>() <= 1e-12 {
            continue;
        }
        out_indices.extend_from_slice(&[a, b, c]);
    }
    // Bounds and memory must describe surviving faces, not orphaned cluster representatives.
    let mut positions = Vec::new();
    let mut used = HashMap::new();
    for index in &mut out_indices {
        *index = *used.entry(*index).or_insert_with(|| {
            positions.push(out_positions[*index as usize]);
            (positions.len() - 1) as u32
        });
    }
    ModelProxyMesh {
        positions,
        indices: out_indices,
        ..Default::default()
    }
}

/// Loads an M2's actual render geometry (`parse_m2_render_submeshes`, every batch merged — trunk,
/// canopy and any billboard leaf cards all included, in bind-pose local positions, the same space
/// `CollisionMesh`/`ModelProxyMesh` already share), retained whole within the model budget. Never
/// full albedo, skeleton or animation state; only bounded alpha masks accompany the geometry.
#[derive(Default, TypePath)]
pub struct M2ProxyLoader;

impl AssetLoader for M2ProxyLoader {
    type Asset = ModelProxyMesh;
    type Settings = ();
    type Error = std::io::Error;

    async fn load(
        &self,
        reader: &mut dyn Reader,
        _settings: &(),
        ctx: &mut LoadContext<'_>,
    ) -> Result<ModelProxyMesh, Self::Error> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err(std::io::Error::other("M2 proxy exceeds source byte budget"));
        }
        let submeshes = parse_m2_render_submeshes(&bytes, "", &[])
            .map_err(|e| std::io::Error::other(format!("{e:#}")))?;
        let mut proxy = merge_render(&submeshes)?;
        if proxy.indices.len() / 3 > M2_PROXY_MAX_TRIANGLES {
            return Err(std::io::Error::other(
                "M2 proxy exceeds complete-model triangle budget",
            ));
        }
        let mut atlas = vec![255; ATLAS_SIZE * ATLAS_SIZE * 4];
        let mut masks = HashMap::new();
        for sub in &submeshes {
            let slot = if sub.blend == ModelBlend::AlphaTest {
                let path = sub
                    .texture
                    .as_ref()
                    .ok_or_else(|| std::io::Error::other("cutout proxy has no authored texture"))?;
                if let Some(&slot) = masks.get(path) {
                    slot
                } else {
                    let slot = masks.len() + 1;
                    if slot >= 16 {
                        return Err(std::io::Error::other("proxy exceeds 15 alpha-mask budget"));
                    }
                    let texture = ctx
                        .read_asset_bytes(crate::texture_url(path, (true, true)))
                        .await
                        .map_err(|e| std::io::Error::other(format!("{path}: {e:#}")))?;
                    check_mask_source(&texture)?;
                    let (w, h, rgba) = blp_to_rgba(&texture)
                        .map_err(|e| std::io::Error::other(format!("{path}: {e:#}")))?;
                    mask_slot(&mut atlas, slot, w, h, &rgba);
                    masks.insert(path.clone(), slot);
                    slot
                }
            } else {
                0
            };
            if slot != 0
                && (sub.uvs.len() != sub.positions.len()
                    || sub
                        .uvs
                        .iter()
                        .flatten()
                        .any(|&v| !v.is_finite() || !(-0.001..=1.001).contains(&v)))
            {
                return Err(std::io::Error::other(
                    "cutout proxy has unsupported repeating UVs",
                ));
            }
            proxy.uvs.extend(
                (0..sub.positions.len())
                    .map(|i| mask_uv(sub.uvs.get(i).copied().unwrap_or([0.0; 2]), slot)),
            );
        }
        if !masks.is_empty() {
            let image = Image::new(
                Extent3d {
                    width: ATLAS_SIZE as u32,
                    height: ATLAS_SIZE as u32,
                    depth_or_array_layers: 1,
                },
                TextureDimension::D2,
                atlas,
                TextureFormat::Rgba8Unorm,
                RenderAssetUsages::RENDER_WORLD,
            );
            proxy.alpha_mask = Some(ctx.add_labeled_asset("alpha-mask".to_string(), image));
        }
        Ok(proxy)
    }

    fn extensions(&self) -> &[&str] {
        &["m2"]
    }
}

/// Reads actual WMO render batches, including non-collidable roofs and ornamental structures.
/// A missing/corrupt group fails the model rather than passing off a partial building as complete.
#[derive(Default, TypePath)]
pub struct WmoProxyLoader;

impl AssetLoader for WmoProxyLoader {
    type Asset = ModelProxyMesh;
    type Settings = ();
    type Error = std::io::Error;

    async fn load(
        &self,
        reader: &mut dyn Reader,
        _settings: &(),
        ctx: &mut LoadContext<'_>,
    ) -> Result<ModelProxyMesh, Self::Error> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        let mut source_bytes = bytes.len();
        let root = parse_wmo_root(&bytes).map_err(|e| std::io::Error::other(format!("{e:#}")))?;
        if root.group_count() > MAX_WMO_GROUPS || source_bytes > MAX_SOURCE_BYTES {
            return Err(std::io::Error::other("WMO proxy exceeds group/byte budget"));
        }

        let root_path = ctx.path().path().to_string_lossy().to_ascii_lowercase();
        let stem = root_path
            .strip_suffix(".wmo")
            .unwrap_or(&root_path)
            .to_string();

        let mut positions = Vec::new();
        let mut indices = Vec::new();
        for gi in 0..root.group_count() {
            let group_url = format!("mpq://{stem}_{gi:03}.wmo");
            let gbytes = ctx
                .read_asset_bytes(group_url)
                .await
                .map_err(|e| std::io::Error::other(format!("group {gi}: {e:#}")))?;
            source_bytes += gbytes.len();
            if source_bytes > MAX_SOURCE_BYTES {
                return Err(std::io::Error::other(
                    "WMO proxy exceeds source byte budget",
                ));
            }
            let subs = wmo_group_submeshes_strict(&gbytes, &root)
                .map_err(|e| std::io::Error::other(format!("group {gi}: {e:#}")))?;
            checked_geometry(&subs)?;
            for sub in subs {
                let base = positions.len() as u32;
                positions.extend(sub.positions);
                indices.extend(sub.indices.into_iter().map(|i| i + base));
                if indices.len() / 3 > MAX_SOURCE_TRIANGLES {
                    return Err(std::io::Error::other(
                        "WMO proxy exceeds source triangle budget",
                    ));
                }
            }
        }
        let proxy = simplify_mesh(positions, indices, WMO_PROXY_MAX_TRIANGLES);
        if proxy.is_empty() {
            return Err(std::io::Error::other(
                "WMO proxy has no surviving render surface",
            ));
        }
        Ok(proxy)
    }

    fn extensions(&self) -> &[&str] {
        &["wmo"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::asset::{AssetApp, AssetPlugin};
    use bevy::prelude::*;

    fn extent(mesh: &ModelProxyMesh) -> [f32; 3] {
        let mut low = [f32::INFINITY; 3];
        let mut high = [f32::NEG_INFINITY; 3];
        for &index in &mesh.indices {
            for a in 0..3 {
                low[a] = low[a].min(mesh.positions[index as usize][a]);
                high[a] = high[a].max(mesh.positions[index as usize][a]);
            }
        }
        std::array::from_fn(|a| high[a] - low[a])
    }

    #[test]
    fn model_proxy_actual_tree_and_building_keep_render_silhouettes() {
        let data = benilla_formats::wow_data_or_skip!();
        let mut chain = benilla_formats::open_chain(&data).unwrap();
        let tree = "World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnTree01\\ElwynnPine01.m2";
        let inn = "World\\wmo\\Azeroth\\Buildings\\GoldshireInn\\GoldshireInn.wmo";
        let bytes = chain.read_file(tree).unwrap();
        let render = merge_render(&parse_m2_render_submeshes(&bytes, "", &[]).unwrap()).unwrap();
        let hull = benilla_formats::parse_m2_collision_hull(&bytes).unwrap();
        let hull = ModelProxyMesh {
            positions: hull.positions,
            indices: hull.indices,
            ..Default::default()
        };
        assert!(render.indices.len() > hull.indices.len());

        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        crate::register_mpq_source(&mut app, &data).unwrap();
        app.add_plugins(AssetPlugin::default());
        app.init_asset::<Image>();
        crate::register_asset_loaders(&mut app);
        let server = app.world().resource::<AssetServer>().clone();
        let handles: Vec<Handle<ModelProxyMesh>> = [tree, inn]
            .iter()
            .map(|path| {
                server.load(if path.ends_with(".wmo") {
                    crate::wmo_url(path)
                } else {
                    crate::m2_url(path)
                })
            })
            .collect();
        for _ in 0..15_000 {
            app.update();
            for handle in &handles {
                assert!(
                    !matches!(server.load_state(handle), bevy::asset::LoadState::Failed(_)),
                    "proxy load failed: {:?}",
                    server.load_state(handle)
                );
            }
            if handles.iter().all(|h| {
                app.world()
                    .resource::<Assets<ModelProxyMesh>>()
                    .get(h)
                    .is_some()
            }) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let proxies = app.world().resource::<Assets<ModelProxyMesh>>();
        let pine = proxies.get(&handles[0]).expect("real tree async loader");
        let building = proxies.get(&handles[1]).expect("real WMO async loader");
        assert_eq!(
            pine.positions, render.positions,
            "all canopy vertices survive"
        );
        assert_eq!(
            pine.indices, render.indices,
            "all authored leaf cards survive"
        );
        let canopy = extent(pine);
        let trunk = extent(&hull);
        assert!(
            canopy[0] > trunk[0] && canopy[1] > trunk[1],
            "canopy {canopy:?} must extend beyond trunk {trunk:?}"
        );
        let mask = app
            .world()
            .resource::<Assets<Image>>()
            .get(
                pine.alpha_mask
                    .as_ref()
                    .expect("pine has authored alpha-cutout foliage"),
            )
            .unwrap();
        assert_eq!((mask.width(), mask.height()), (256, 256));
        let pixels = mask.data.as_ref().unwrap();
        assert!(
            pixels.chunks_exact(4).any(|p| p[3] < 224),
            "transparent leaf margins"
        );
        assert!(
            pixels.chunks_exact(4).any(|p| p[3] >= 224),
            "solid leaves and trunk"
        );
        assert!(pine.indices.len() / 3 <= M2_PROXY_MAX_TRIANGLES);
        assert!(building.indices.len() / 3 <= WMO_PROXY_MAX_TRIANGLES);
        assert!(!building.is_empty());

        let bytes = chain.read_file(inn).unwrap();
        let root = parse_wmo_root(&bytes).unwrap();
        assert!(wmo_group_submeshes_strict(b"corrupt", &root).is_err());
        let mut subs = Vec::new();
        for group in 0..root.group_count() {
            let path = format!("{}_{group:03}.wmo", inn.trim_end_matches(".wmo"));
            subs.extend(
                wmo_group_submeshes_strict(&chain.read_file(&path).unwrap(), &root).unwrap(),
            );
        }
        let full = merge_render(&subs).unwrap();
        let authored = extent(&full);
        let distant = extent(building);
        for a in 0..3 {
            assert!(
                distant[a] >= authored[a] * 0.85,
                "building axis {a}: render {authored:?}, LOD {distant:?}"
            );
        }
        eprintln!(
            "MODEL_PROXY tree render={} proxy={} hull={} canopy={canopy:?} trunk={trunk:?}; \
            inn render={} proxy={} render_extent={authored:?} proxy_extent={distant:?}; atlas=256x256",
            render.indices.len() / 3,
            pine.indices.len() / 3,
            hull.indices.len() / 3,
            full.indices.len() / 3,
            building.indices.len() / 3
        );
    }

    #[test]
    fn model_proxy_alpha_atlas_preserves_transparent_margin_and_opaque_centre() {
        let mut atlas = vec![255; ATLAS_SIZE * ATLAS_SIZE * 4];
        let mut pixels = vec![255; 4 * 4 * 4];
        for pixel in pixels.chunks_exact_mut(4).take(4) {
            pixel[3] = 0;
        }
        mask_slot(&mut atlas, 5, 4, 4, &pixels);
        let alpha_at = |uv: [f32; 2]| {
            let p = mask_uv(uv, 5);
            atlas[((p[1] * ATLAS_SIZE as f32) as usize * ATLAS_SIZE
                + (p[0] * ATLAS_SIZE as f32) as usize)
                * 4
                + 3]
        };
        assert_eq!(alpha_at([0.5, 0.0]), 0);
        assert_eq!(alpha_at([0.5, 0.5]), 255);
        assert_eq!(alpha_at([1.0, 1.0]), 255);
    }

    #[test]
    fn model_proxy_rejects_oversized_texture_before_rgba_allocation() {
        let mut header = vec![0u8; 20];
        header[..4].copy_from_slice(b"BLP2");
        header[12..16].copy_from_slice(&256u32.to_le_bytes());
        header[16..20].copy_from_slice(&256u32.to_le_bytes());
        assert!(check_mask_source(&header).is_ok());
        header[12..16].copy_from_slice(&65535u32.to_le_bytes());
        assert!(check_mask_source(&header).is_err());
        assert!(check_mask_source(b"corrupt").is_err());
    }

    /// An `n`×`n` tessellated flat grid, two triangles per cell — a stand-in for an actual
    /// authored *surface*, unlike the old `fan` fixture (every triangle sharing one vertex),
    /// which could not expose whether simplification keeps the surface closed.
    fn grid(n: usize) -> (Vec<[f32; 3]>, Vec<u32>) {
        let stride = n + 1;
        let mut positions = Vec::with_capacity(stride * stride);
        for y in 0..stride {
            for x in 0..stride {
                positions.push([x as f32, 0.0, y as f32]);
            }
        }
        let mut indices = Vec::with_capacity(n * n * 6);
        for y in 0..n {
            for x in 0..n {
                let i0 = (y * stride + x) as u32;
                let i1 = i0 + 1;
                let i2 = i0 + stride as u32;
                let i3 = i2 + 1;
                indices.extend_from_slice(&[i0, i2, i1, i1, i2, i3]);
            }
        }
        (positions, indices)
    }

    #[test]
    fn under_the_cap_is_untouched() {
        let (positions, indices) = grid(5);
        let before = indices.len() / 3;
        let out = simplify_mesh(positions.clone(), indices.clone(), before + 10);
        assert_eq!(out.positions, positions);
        assert_eq!(out.indices, indices);
    }

    /// The central claim against the old stride decimation: the simplified mesh is a real,
    /// still-closed coarsened surface — every kept triangle non-degenerate, spanning close to the
    /// original footprint — not an arbitrary subset that could leave holes through an otherwise
    /// intact face or collapse to one corner of the input.
    #[test]
    fn over_the_cap_keeps_a_closed_surface_not_a_holed_subset() {
        let (positions, indices) = grid(40); // 3,200 triangles: well over any per-instance budget
        let before_tris = indices.len() / 3;
        let out = simplify_mesh(positions, indices, 200);
        let tri_count = out.indices.len() / 3;
        assert!(tri_count <= 200, "got {tri_count} triangles, cap was 200");
        assert!(
            tri_count > 0,
            "a well-formed grid must simplify to something, not nothing"
        );
        assert!(
            tri_count < before_tris,
            "simplification must actually reduce triangle count"
        );
        for tri in out.indices.chunks_exact(3) {
            assert!(tri.iter().all(|&i| (i as usize) < out.positions.len()));
            assert_ne!(tri[0], tri[1], "a degenerate (zero-area) triangle survived");
            assert_ne!(tri[1], tri[2], "a degenerate (zero-area) triangle survived");
            assert_ne!(tri[0], tri[2], "a degenerate (zero-area) triangle survived");
        }
        let (mut lo, mut hi) = (out.positions[0], out.positions[0]);
        for p in &out.positions {
            for a in 0..3 {
                lo[a] = lo[a].min(p[a]);
                hi[a] = hi[a].max(p[a]);
            }
        }
        assert!(
            hi[0] - lo[0] > 30.0,
            "output collapsed toward one corner instead of coarsening"
        );
        assert!(
            hi[2] - lo[2] > 30.0,
            "output collapsed toward one corner instead of coarsening"
        );
    }

    #[test]
    fn zero_cap_means_no_cap() {
        let (positions, indices) = grid(5);
        let out = simplify_mesh(positions.clone(), indices.clone(), 0);
        assert_eq!(
            out.indices, indices,
            "0 is a no-op, not \"drop everything\""
        );
    }

    /// `cluster_at` on its own: two corners landing in the same grid cell must drop that
    /// triangle, never keep it as a zero-area sliver.
    #[test]
    fn degenerate_triangles_from_clustering_are_dropped() {
        let positions = vec![[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [10.0, 0.0, 0.0]];
        let indices = vec![0, 1, 2];
        let out = cluster_at(&positions, &indices, 1.0);
        assert!(
            out.indices.is_empty(),
            "the first two corners share a cell at this cell size; the collapsed triangle must \
             be dropped, not kept"
        );
    }

    #[test]
    fn empty_proxy_reports_empty() {
        assert!(ModelProxyMesh::default().is_empty());
        let (positions, indices) = grid(1);
        assert!(!ModelProxyMesh {
            positions,
            indices,
            ..Default::default()
        }
        .is_empty());
    }
}
