//! Bounded racer far-draw copies of real, already-loaded transport render batches.
//! No new model requests, transforms, timetable, network entities or collision objects.

use super::*;
use crate::interact::PickMesh;
use crate::model_render::{ModelKind, ModelPart};
use benilla_assets::materials::WowModelMaterial;
use std::collections::HashSet;

/// Opt-in on an actual timetable-driven network transport, never ordinary GameObjects.
#[derive(Component)]
pub struct RacerTransport;

#[derive(Component)]
pub(super) struct TransportPart;

#[derive(Default)]
pub(super) struct TransportCopies {
    copies: HashMap<Entity, (Entity, Handle<WdlMaterial>)>,
    warned: HashSet<Entity>,
}

const MAX_TRANSPORTS: usize = 16;
const MAX_PARTS: usize = 256;
const MAX_TRIANGLES: usize = 128_000;
const BUILDS_PER_FRAME: usize = 4;

fn in_range(position: Vec3, camera: Vec3, visible: bool) -> bool {
    visible && position.distance_squared(camera) < RacerWdl::FAR * RacerWdl::FAR
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(super) fn stream_transports(
    mut commands: Commands,
    racer: Option<Res<RacerWdl>>,
    streamer: Option<Res<WdlStreamer>>,
    camera: Query<&GlobalTransform, With<WorldCamera>>,
    roots: Query<(Entity, &GlobalTransform, &Visibility), With<RacerTransport>>,
    children: Query<&Children>,
    parts: Query<
        (
            &ModelPart,
            &Mesh3d,
            &GlobalTransform,
            &PickMesh,
            &MeshMaterial3d<WowModelMaterial>,
        ),
        Without<TransportPart>,
    >,
    mut copies: Local<TransportCopies>,
    model_materials: Res<Assets<WowModelMaterial>>,
    mut materials: ResMut<Assets<WdlMaterial>>,
) {
    let mut desired = HashSet::new();
    let mut builds = 0;
    let mut triangles = 0;
    copies.warned.retain(|root| roots.get(*root).is_ok());
    if let (Some(_), Some(streamer), Ok(camera)) = (racer, streamer, camera.single()) {
        let camera = camera.translation();
        let mut ordered: Vec<_> = roots
            .iter()
            .filter(|(_, pose, vis)| {
                in_range(pose.translation(), camera, **vis != Visibility::Hidden)
            })
            .collect();
        ordered.sort_unstable_by(|a, b| {
            a.1.translation()
                .distance_squared(camera)
                .total_cmp(&b.1.translation().distance_squared(camera))
        });
        for (root, _, _) in ordered.into_iter().take(MAX_TRANSPORTS) {
            // Bound traversal too: a malformed or exotic transport cannot walk an unbounded scene.
            let descendants: Vec<_> = children
                .iter_descendants(root)
                .take(MAX_PARTS + 1)
                .collect();
            if descendants.len() > MAX_PARTS {
                if copies.warned.insert(root) {
                    warn!("Racer transport {root:?} exceeds descendant budget");
                }
                continue;
            }
            let source: Vec<_> = descendants
                .into_iter()
                .filter_map(|entity| parts.get(entity).ok().map(|part| (entity, part)))
                .filter(|(_, (part, _, _, _, _))| part.kind == ModelKind::GameObject)
                .collect();
            let cost: usize = source
                .iter()
                .map(|(_, (_, _, _, pick, _))| pick.0.indices.len() / 3)
                .sum();
            // Admit a whole vessel, not whichever arbitrary triangles/batches happen to fit.
            if desired.len() + source.len() > MAX_PARTS || triangles + cost > MAX_TRIANGLES {
                if copies.warned.insert(root) {
                    warn!("Racer transport {root:?} exceeds far geometry budget");
                }
                continue;
            }
            triangles += cost;
            for (source, (part, mesh, pose, _, material)) in source {
                desired.insert(source);
                if let Some((entity, _)) = copies.copies.get(&source) {
                    commands.entity(*entity).insert((
                        *pose,
                        pose.compute_transform(),
                        mesh.clone(),
                    ));
                } else if builds < BUILDS_PER_FRAME {
                    let Some(template) = materials.get(&streamer.building_material) else {
                        continue;
                    };
                    let mut distant = template.clone();
                    // Existing authored alpha also keeps sail/rigging cutouts; no new texture IO.
                    if part.blend == benilla_formats::ModelBlend::AlphaTest {
                        if let Some(texture) = model_materials
                            .get(&material.0)
                            .and_then(|m| m.base.base_color_texture.as_ref())
                        {
                            distant.extension.ground_tile = texture.clone();
                        }
                    }
                    let material = materials.add(distant);
                    let entity = commands
                        .spawn((
                            mesh.clone(),
                            MeshMaterial3d(material.clone()),
                            *pose,
                            pose.compute_transform(),
                            TransportPart,
                            NoFrustumCulling,
                            crate::exterior_cull::ExteriorScene,
                        ))
                        .id();
                    copies.copies.insert(source, (entity, material));
                    builds += 1;
                }
            }
        }
    }
    copies.copies.retain(|source, (entity, material)| {
        if desired.contains(source) {
            return true;
        }
        commands.entity(*entity).despawn();
        materials.remove(material.id());
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn racer_transports_are_map_visibility_and_radial_range_gated() {
        let camera = Vec3::ZERO;
        assert!(in_range(Vec3::new(2500.0, 0.0, 0.0), camera, true));
        assert!(!in_range(Vec3::new(2500.0, 0.0, 0.0), camera, false));
        assert!(!in_range(Vec3::new(6000.0, 0.0, 0.0), camera, true));
        assert!(!in_range(Vec3::new(4500.0, 0.0, 4500.0), camera, true));
    }
}
