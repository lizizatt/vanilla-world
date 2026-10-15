//! Deviation: conservative rocket-car envelope over the existing Avian world queries.

use avian3d::prelude::Collider;
use benilla_world::collision::WorldCollision;
use bevy::prelude::*;

pub(super) const PROBES: [Vec3; 4] = [
    Vec3::new(-1.7, 0.0, -3.0),
    Vec3::new(1.7, 0.0, -3.0),
    Vec3::new(-1.7, 0.0, 3.0),
    Vec3::new(1.7, 0.0, 3.0),
];

pub(super) fn supports(world: &WorldCollision, position: Vec3, yaw: f32) -> [Option<f32>; 4] {
    let rotation = Quat::from_rotation_y(yaw);
    PROBES.map(|offset| {
        let from = position + rotation * offset + Vec3::Y * 2.0;
        world.ray_body(from, Dir3::NEG_Y, 12.0).and_then(|hit| {
            (hit.distance.is_finite() && hit.normal.y > 0.6)
                .then_some((hit.distance - 2.0).max(0.0))
        })
    })
}

pub(super) fn clear_turn(world: &WorldCollision, position: Vec3, old: f32, new: f32) -> bool {
    let sphere = Collider::sphere(2.6);
    let from = Quat::from_rotation_y(old);
    let to = Quat::from_rotation_y(new);
    [-3.0, 3.0].into_iter().all(|z| {
        let offset = Vec3::new(0.0, 2.6, z);
        let movement = to * offset - from * offset;
        movement.length_squared() < 1.0e-10
            || world
                .cast_body(&sphere, position + from * offset, movement, 0.03)
                .is_none()
    })
}

pub(super) fn slide(
    world: &WorldCollision,
    mut position: Vec3,
    mut velocity: Vec3,
    yaw: f32,
    dt: f32,
) -> (Vec3, Vec3) {
    let sphere = Collider::sphere(2.6);
    let rotation = Quat::from_rotation_y(yaw);
    let mut remaining = dt;
    for _ in 0..3 {
        let movement = velocity * remaining;
        let length = movement.length();
        if length < 0.0001 {
            break;
        }
        let hit = [-3.0, 0.0, 3.0]
            .into_iter()
            .filter_map(|z| {
                world.cast_body(
                    &sphere,
                    position + rotation * Vec3::new(0.0, 2.6, z),
                    movement,
                    0.03,
                )
            })
            .min_by(|a, b| a.distance.total_cmp(&b.distance));
        let Some(hit) = hit else {
            position += movement;
            break;
        };
        if !hit.distance.is_finite() || !hit.normal1.is_finite() {
            error!("flats racer: non-finite collision result; freezing body");
            return (position, Vec3::ZERO);
        }
        let fraction = ((hit.distance - 0.03).max(0.0) / length).clamp(0.0, 1.0);
        position += movement * fraction;
        remaining *= 1.0 - fraction;
        velocity = clip_velocity(velocity, hit.normal1);
    }
    (position, velocity)
}

fn clip_velocity(velocity: Vec3, normal: Vec3) -> Vec3 {
    let normal = normal.normalize_or_zero();
    velocity - normal * velocity.dot(normal).min(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use avian3d::prelude::{PhysicsPlugins, RigidBody};
    use bevy::ecs::system::RunSystemOnce;

    pub(in crate::player::flats_racer) fn fixture() -> App {
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            bevy::transform::TransformPlugin,
            bevy::asset::AssetPlugin::default(),
            bevy::scene::ScenePlugin,
            PhysicsPlugins::new(PostUpdate),
        ));
        app.init_asset::<Mesh>();
        app.init_resource::<benilla_world::collision::MoverTraceExclusions>();
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(1000.0, 1.0, 1000.0),
            Transform::from_xyz(0.0, -0.5, 0.0),
        ));
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(0.1, 20.0, 100.0),
            Transform::from_xyz(10.0, 5.0, 0.0),
        ));
        app.finish();
        app.cleanup();
        app.update();
        app
    }

    #[test]
    fn avian_sweep_stops_a_boosted_body_at_a_thin_wall_and_slides() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                let (position, velocity) = slide(
                    &world,
                    Vec3::new(6.0, 1.1, 0.0),
                    Vec3::new(50.0, 0.0, 12.0),
                    0.0,
                    0.1,
                );
                assert!(position.x < 7.5 && position.x >= 6.0, "{position:?}");
                assert!(
                    position.z > 0.9 && velocity.x.abs() < 0.01,
                    "{position:?} {velocity:?}"
                );
                assert!(!clear_turn(
                    &world,
                    Vec3::new(6.0, 1.1, 0.0),
                    0.0,
                    std::f32::consts::FRAC_PI_2
                ));
            })
            .expect("Avian fixture runs");
    }

    #[test]
    fn avian_four_supports_measure_center_relative_height() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                for distance in supports(&world, Vec3::Y * 1.1, 0.7) {
                    assert!((distance.expect("floor under every probe") - 1.1).abs() < 0.001);
                }
            })
            .expect("Avian fixture runs");
    }

    #[test]
    fn integrated_fixed_step_is_frame_rate_independent_and_missing_tiles_freeze() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                use benilla_world::terrain_stream::WorldLoadProgress;
                use flats_racer_physics::{Input, State};
                let tile = benilla_formats::world_to_tile(0.0, 0.0);
                let mut progress = WorldLoadProgress {
                    total: 1,
                    ready: 1,
                    focus_resident: true,
                    scene_ready: true,
                    colliders_pending: 0,
                    merge_pending: 0,
                    placements_pending: 0,
                    gx_pending: 0,
                    focus_tile: Some((tile.0 as i32, tile.1 as i32)),
                    complete: true,
                };
                // Stay inside one streamer focus tile so the test measures the actual accumulator.
                let origin = [20.0, 1.1, 20.0];
                let states = [30, 60, 144].map(|fps| {
                    let mut state = State::new(origin, 0.0).unwrap();
                    let mut accumulator = 0.0;
                    for _ in 0..fps {
                        assert!(!super::super::advance(
                            &mut state,
                            &mut accumulator,
                            Input {
                                throttle: 1.0,
                                ..Default::default()
                            },
                            1.0 / fps as f32,
                            &world,
                            &progress
                        )
                        .unwrap());
                    }
                    state
                });
                assert_eq!(states[0].position, states[1].position);
                assert_eq!(states[0].position, states[2].position);
                assert!(states[0].velocity[2].abs() > 15.0);
                let mut crossing = State::new([20.0, 1.1, 0.1], 0.0).unwrap();
                crossing.velocity[2] = -20.0;
                let current = benilla_formats::world_to_tile(-0.1, -20.0);
                let ahead = benilla_formats::world_to_tile(4.9, -20.0);
                assert_ne!(current, ahead);
                progress.focus_tile = Some((current.0 as i32, current.1 as i32));
                assert!(!super::super::advance(
                    &mut crossing,
                    &mut 0.0,
                    Input::default(),
                    flats_racer_physics::FIXED_DT,
                    &world,
                    &progress
                )
                .unwrap());
                assert!(crossing.position[2] < 0.0);
                progress.focus_tile = Some((tile.0 as i32, tile.1 as i32));
                let mut state = states[0].clone();
                let before = state.position;
                progress.colliders_pending = 1;
                assert!(super::super::advance(
                    &mut state,
                    &mut 0.0,
                    Input::default(),
                    0.1,
                    &world,
                    &progress
                )
                .unwrap());
                assert_eq!(state.position, before);
                assert_eq!(state.velocity, [0.0; 3]);
            })
            .expect("Avian fixture runs");
    }

    #[test]
    fn collision_removes_only_velocity_into_wall() {
        assert_eq!(
            clip_velocity(Vec3::new(-80.0, -2.0, 7.0), Vec3::X),
            Vec3::new(0.0, -2.0, 7.0)
        );
        assert_eq!(clip_velocity(Vec3::X * 40.0, Vec3::X), Vec3::X * 40.0);
    }

    #[test]
    fn four_probes_span_the_vehicle() {
        assert_eq!(PROBES.len(), 4);
        assert_eq!(PROBES.into_iter().sum::<Vec3>(), Vec3::ZERO);
    }
}
