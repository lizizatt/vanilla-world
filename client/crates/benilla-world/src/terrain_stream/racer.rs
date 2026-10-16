//! Deviation: bounded, body-centred collision prefetch for the opt-in racer.

use std::collections::HashSet;

use avian3d::{
    collider_tree::{ColliderTreeProxyKey, ColliderTrees},
    prelude::Collider,
};
use benilla_formats::{world_to_tile, TILE_SIZE};
use bevy::prelude::*;

use super::{HullWelds, PendingCollider, Placements, TerrainStreamer, WorldLoadProgress};

/// The game publishes actual horizontal velocity in WoW coordinates, not camera velocity.
#[derive(Resource, Default)]
pub struct RacerPrefetch {
    pub active: bool,
    pub wow_velocity: [f32; 2],
}

/// Two seconds ahead at 500 yd/s; faster handling remains legal but may reach the safety hold.
pub const LOOKAHEAD_SECONDS: f32 = 2.0;
pub const MAX_LOOKAHEAD_YD: f32 = 2.0 * TILE_SIZE;
pub const MAX_RESIDENT_TILES: usize = 40;

/// At most 21 tiles: a 3x3 body ring swept at most two tile coordinates forward.
pub(super) fn wanted(center: [f32; 3], velocity: [f32; 2]) -> Vec<(i32, i32)> {
    if !center.iter().chain(velocity.iter()).all(|v| v.is_finite()) {
        error!("racer prefetch rejected non-finite center/velocity: {center:?}/{velocity:?}");
        return Vec::new();
    }
    let (x, y) = world_to_tile(center[0], center[1]);
    let body = (x as i32, y as i32);
    let vx = f64::from(velocity[0]);
    let vy = f64::from(velocity[1]);
    let length = vx.hypot(vy);
    let scale = if length.is_finite() && length > 0.0 {
        f64::from(LOOKAHEAD_SECONDS).min(f64::from(MAX_LOOKAHEAD_YD) / length)
    } else {
        0.0
    };
    let (ax, ay) = world_to_tile(
        center[0] + (vx * scale) as f32,
        center[1] + (vy * scale) as f32,
    );
    let delta = (
        (ax as i32 - body.0).clamp(-2, 2),
        (ay as i32 - body.1).clamp(-2, 2),
    );
    let steps = delta.0.abs().max(delta.1.abs());
    let mut tiles = HashSet::new();
    for step in 0..=steps {
        let at = if steps == 0 {
            body
        } else {
            (
                body.0 + delta.0 * step / steps,
                body.1 + delta.1 * step / steps,
            )
        };
        for dx in -1..=1 {
            for dy in -1..=1 {
                let tile = (at.0 + dx, at.1 + dy);
                if (0..64).contains(&tile.0) && (0..64).contains(&tile.1) {
                    tiles.insert(tile);
                }
            }
        }
    }
    let mut tiles: Vec<_> = tiles.into_iter().collect();
    let ahead = (body.0 + delta.0, body.1 + delta.1);
    tiles.sort_unstable_by_key(|&(tx, ty)| {
        (
            (tx - body.0).abs().max((ty - body.1).abs()),
            (tx - ahead.0).abs().max((ty - ahead.1).abs()),
            tx,
            ty,
        )
    });
    tiles
}

/// Runs after spawning/welding and deferred command application. A distant pending collider
/// cannot invalidate a complete tile, but every collider it owns must be in Avian's query tree.
pub(super) fn publish_collision_tiles(
    state: Res<TerrainStreamer>,
    placements: Res<Placements>,
    welds: Res<HullWelds>,
    pending: Query<Entity, With<PendingCollider>>,
    colliders: Query<(Entity, Option<&ColliderTreeProxyKey>), With<Collider>>,
    trees: Res<ColliderTrees>,
    parents: Query<&ChildOf>,
    assets: Res<AssetServer>,
    mut progress: ResMut<WorldLoadProgress>,
    racer: Res<RacerPrefetch>,
) {
    progress.collision_tiles.clear();
    if !racer.active {
        return;
    }
    let mut blocked = HashSet::new();
    // Check query registration itself rather than inferring it from ECS shape presence.
    let unindexed = colliders.iter().filter_map(|(entity, key)| {
        let indexed = key
            .and_then(|key| trees.get_proxy(*key))
            .is_some_and(|proxy| proxy.collider == entity);
        (!indexed).then_some(entity)
    });
    for entity in pending.iter().chain(unindexed) {
        blocked.insert(entity);
        for ancestor in parents.iter_ancestors(entity) {
            blocked.insert(ancestor);
        }
    }
    let owner_ready = |owner: &(i32, i32)| {
        !welds.tile_pending(*owner)
            && state
                .tiles
                .get(owner)
                .is_some_and(|t| t.welds.iter().all(|e| !blocked.contains(e)))
    };
    for (&key, tile) in &state.tiles {
        let ready = tile.furnished
            && tile.entity.is_some_and(|e| !blocked.contains(&e))
            && tile.wall.map_or(true, |e| !blocked.contains(&e))
            && owner_ready(&key)
            && tile.placements.iter().all(|uid| {
                placements.by_id.get(uid).is_some_and(|p| {
                    let model = match &p.model {
                        super::ModelHandle::M2(h) => h.id().untyped(),
                        super::ModelHandle::Wmo(h) => h.id().untyped(),
                    };
                    p.spawned
                        && !assets.load_state(model).is_failed()
                        && p.doodads
                            .iter()
                            .all(|d| d.spawned && !assets.load_state(d.handle.id()).is_failed())
                        && !welds.prop_pending(*uid)
                        && p.entities.iter().all(|e| !blocked.contains(e))
                        && (matches!(p.model, super::ModelHandle::Wmo(_))
                            || super::weld::hull_weld_disabled()
                            || owner_ready(&p.owner))
                })
            });
        if ready {
            progress.collision_tiles.insert(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::TileState;
    use super::*;
    use avian3d::prelude::Collider;

    fn proof_fixture() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, bevy::asset::AssetPlugin::default()))
            .init_resource::<TerrainStreamer>()
            .init_resource::<Placements>()
            .init_resource::<HullWelds>()
            .init_resource::<ColliderTrees>()
            .init_resource::<WorldLoadProgress>()
            .insert_resource(RacerPrefetch {
                active: true,
                wow_velocity: [0.0; 2],
            })
            .add_systems(Update, publish_collision_tiles);
        app
    }

    #[test]
    fn racer_collision_proof_accepts_queryable_colliders_without_a_fixed_tick() {
        use avian3d::prelude::{PhysicsPlugins, RigidBody, SpatialQuery, SpatialQueryFilter};
        use bevy::ecs::system::RunSystemOnce;
        use bevy::time::TimeUpdateStrategy;
        use std::time::Duration;

        let mut app = proof_fixture();
        app.add_plugins((
            bevy::transform::TransformPlugin,
            bevy::scene::ScenePlugin,
            PhysicsPlugins::default(),
        ))
        .init_asset::<Mesh>()
        .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
        let root = app
            .world_mut()
            .spawn((
                Transform::from_xyz(100.0, 10.0, 100.0),
                RigidBody::Static,
                Collider::cuboid(100.0, 1.0, 100.0),
            ))
            .id();
        app.world_mut()
            .resource_mut::<TerrainStreamer>()
            .tiles
            .insert(
                (32, 32),
                TileState {
                    handle: Handle::default(),
                    entity: Some(root),
                    material: None,
                    next_cell: 16,
                    furnished: true,
                    placements: vec![],
                    liquid: vec![],
                    wall: None,
                    clutter: vec![],
                    welds: vec![],
                    merged: vec![],
                },
            );
        app.finish();
        app.cleanup();
        for _ in 0..3 {
            app.update();
            assert!(
                app.world()
                    .resource::<WorldLoadProgress>()
                    .collision_tiles
                    .contains(&(32, 32)),
                "Avian's insertion observer can register static colliders without a fixed tick"
            );
            let hit = app
                .world_mut()
                .run_system_once(|query: SpatialQuery| {
                    query.cast_ray(
                        Vec3::new(100.0, 20.0, 100.0),
                        Dir3::NEG_Y,
                        20.0,
                        true,
                        &SpatialQueryFilter::default(),
                    )
                })
                .unwrap();
            assert_eq!(hit.map(|hit| hit.entity), Some(root));
        }
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
            1.0 / 30.0,
        )));
        app.update();
        assert!(
            app.world()
                .resource::<WorldLoadProgress>()
                .collision_tiles
                .contains(&(32, 32)),
            "the production fixed physics schedule must publish the collider"
        );
    }

    #[test]
    fn collision_proof_is_local_and_waits_for_pending_descendants() {
        let mut app = proof_fixture();
        let root = app.world_mut().spawn_empty().id();
        let distant = app
            .world_mut()
            .spawn(PendingCollider::ready(Collider::sphere(1.0), None, true))
            .id();
        app.world_mut()
            .resource_mut::<TerrainStreamer>()
            .tiles
            .insert(
                (32, 32),
                TileState {
                    handle: Handle::default(),
                    entity: Some(root),
                    material: None,
                    next_cell: 16,
                    furnished: true,
                    placements: vec![],
                    liquid: vec![],
                    wall: None,
                    clutter: vec![],
                    welds: vec![],
                    merged: vec![],
                },
            );
        app.update();
        assert!(app
            .world()
            .resource::<WorldLoadProgress>()
            .collision_tiles
            .contains(&(32, 32)));
        let child = app
            .world_mut()
            .spawn((
                ChildOf(root),
                PendingCollider::ready(Collider::sphere(1.0), None, true),
            ))
            .id();
        app.update();
        assert!(app
            .world()
            .resource::<WorldLoadProgress>()
            .collision_tiles
            .is_empty());
        app.world_mut()
            .entity_mut(child)
            .remove::<PendingCollider>();
        app.update();
        let ready = &app.world().resource::<WorldLoadProgress>().collision_tiles;
        assert!(ready.contains(&(32, 32)));
        assert!(
            !ready.contains(&(33, 32)),
            "absent terrain must never be ready"
        );
        assert!(app.world().get::<PendingCollider>(distant).is_some());
        app.world_mut()
            .entity_mut(child)
            .insert(Collider::sphere(1.0));
        app.update();
        assert!(
            app.world()
                .resource::<WorldLoadProgress>()
                .collision_tiles
                .is_empty(),
            "attached geometry is not safe until Avian indexes its collider"
        );
        app.world_mut().entity_mut(child).remove::<Collider>();
        app.world_mut()
            .resource_mut::<TerrainStreamer>()
            .tiles
            .get_mut(&(32, 32))
            .unwrap()
            .wall = Some(distant);
        app.update();
        assert!(
            app.world()
                .resource::<WorldLoadProgress>()
                .collision_tiles
                .is_empty(),
            "impassable fences must finish even though they are not root descendants"
        );
        app.world_mut()
            .resource_mut::<TerrainStreamer>()
            .tiles
            .get_mut(&(32, 32))
            .unwrap()
            .wall = None;
        app.world_mut().resource_mut::<HullWelds>().add_tile(
            (32, 32),
            vec![Vec3::ZERO, Vec3::X, Vec3::Z],
            vec![[0, 1, 2]],
        );
        app.update();
        assert!(
            app.world()
                .resource::<WorldLoadProgress>()
                .collision_tiles
                .is_empty(),
            "unflushed hulls must block traversal even before PendingCollider exists"
        );
        app.world_mut().resource_mut::<HullWelds>().clear();
        app.update();
        assert!(app
            .world()
            .resource::<WorldLoadProgress>()
            .collision_tiles
            .contains(&(32, 32)));
        app.world_mut()
            .resource_mut::<TerrainStreamer>()
            .tiles
            .get_mut(&(32, 32))
            .unwrap()
            .placements
            .push(7);
        app.world_mut().resource_mut::<Placements>().by_id.insert(
            7,
            super::super::Placement {
                model: super::super::ModelHandle::M2(Handle::default()),
                transform: Transform::IDENTITY,
                entities: vec![],
                spawned: true,
                doodad_set: 0,
                name_set: 0,
                doodads: vec![],
                portal_instance: None,
                refs: 1,
                owner: (31, 32),
            },
        );
        app.update();
        assert_eq!(
            app.world()
                .resource::<WorldLoadProgress>()
                .collision_tiles
                .contains(&(32, 32)),
            super::super::weld::hull_weld_disabled(),
            "tile-owned hulls cannot outlive their unloaded owner"
        );
        app.world_mut()
            .resource_mut::<Placements>()
            .by_id
            .get_mut(&7)
            .unwrap()
            .owner = (32, 32);
        app.update();
        assert!(app
            .world()
            .resource::<WorldLoadProgress>()
            .collision_tiles
            .contains(&(32, 32)));
    }

    #[test]
    fn body_ring_and_fast_lookahead_are_bounded_and_prioritized() {
        let center = [-6235.0, -3945.0, -58.75];
        for velocity in [
            [0.0, 0.0],
            [250.0, 0.0],
            [500.0, 0.0],
            [500.0, 500.0],
            [f32::MAX, f32::MAX],
        ] {
            let tiles = wanted(center, velocity);
            assert!(tiles.len() <= 21, "{velocity:?}: {}", tiles.len());
            let (x, y) = world_to_tile(center[0], center[1]);
            assert_eq!(tiles[0], (x as i32, y as i32));
            for dx in -1..=1 {
                for dy in -1..=1 {
                    assert!(tiles.contains(&(x as i32 + dx, y as i32 + dy)));
                }
            }
        }
        assert_eq!(wanted(center, [0.0; 2]).len(), 9);
        assert!(wanted(center, [500.0, 0.0]).len() > 9);
    }

    #[test]
    fn map_edges_never_request_off_grid_tiles() {
        for tile in wanted([17065.0, -17065.0, 0.0], [500.0, -500.0]) {
            assert!((0..64).contains(&tile.0) && (0..64).contains(&tile.1));
        }
    }

    #[test]
    fn invalid_telemetry_cannot_request_a_bogus_origin_window() {
        assert!(wanted([0.0; 3], [f32::NAN, 0.0]).is_empty());
        assert!(wanted([f32::INFINITY, 0.0, 0.0], [0.0; 2]).is_empty());
    }
}
