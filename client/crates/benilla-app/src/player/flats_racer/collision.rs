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

pub(super) fn supports(
    world: &WorldCollision,
    position: Vec3,
    yaw: f32,
    reach: f32,
) -> [Option<f32>; 4] {
    supports_with_motion(world, position, yaw, reach, Vec3::ZERO).0
}

pub(super) fn supports_with_motion(
    world: &WorldCollision,
    position: Vec3,
    yaw: f32,
    reach: f32,
    velocity: Vec3,
) -> ([Option<f32>; 4], f32) {
    let rotation = Quat::from_rotation_y(yaw);
    let mut rise = 0.0_f64;
    let mut count = 0;
    let distances = PROBES.map(|offset| {
        let from = position + rotation * offset + Vec3::Y * 2.0;
        // Relative reach works at any terrain altitude; distant ground cannot supply lift.
        world
            .ray_body(
                from,
                Dir3::NEG_Y,
                (f64::from(reach) + 2.0).min(f64::from(f32::MAX)) as f32,
            )
            .and_then(|hit| {
                if !hit.distance.is_finite() || !hit.normal.is_finite() || hit.normal.y <= 0.6 {
                    return None;
                }
                if benilla_assets::trace::enabled_for("racer-support") {
                    benilla_assets::trace::line(
                        "racer-support",
                        &format!(
                            "from={from:?} distance={} normal={:?}",
                            hit.distance, hit.normal
                        ),
                    );
                }
                let distance = (hit.distance - 2.0).max(0.0);
                if distance <= reach {
                    // n dot (vx, terrain-rise, vz) = 0 on the actual collision plane.
                    rise -= (f64::from(hit.normal.x) * f64::from(velocity.x)
                        + f64::from(hit.normal.z) * f64::from(velocity.z))
                        / f64::from(hit.normal.y);
                    count += 1;
                }
                Some(distance)
            })
    });
    (
        distances,
        if count > 0 {
            (rise / f64::from(count)) as f32
        } else {
            0.0
        },
    )
}

pub(super) fn clear_turn(world: &WorldCollision, position: Vec3, old: f32, travel: f32) -> bool {
    let sphere = Collider::sphere(2.6);
    // Any additional full revolutions visit the same envelope. Bounded arc sweeps
    // cover it without turning a high requested yaw rate into an unbounded loop.
    let travel = travel.clamp(-std::f32::consts::TAU, std::f32::consts::TAU);
    let steps = (travel.abs() / (std::f32::consts::PI / 12.0))
        .ceil()
        .max(1.0) as usize;
    (0..steps).all(|step| {
        let from = Quat::from_rotation_y(old + travel * step as f32 / steps as f32);
        let to = Quat::from_rotation_y(old + travel * (step + 1) as f32 / steps as f32);
        [-3.0, 3.0].into_iter().all(|z| {
            let offset = Vec3::new(0.0, 2.6, z);
            let movement = to * offset - from * offset;
            movement.length_squared() < 1.0e-10
                || world
                    .cast_body(&sphere, position + from * offset, movement, 0.03)
                    .is_none()
        })
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
        if benilla_assets::trace::enabled_for("racer") {
            benilla_assets::trace::line("racer", &format!(
                "collision pos={position:?} actual={velocity:?} distance={} normal={:?} fraction={fraction}",
                hit.distance, hit.normal1
            ));
        }
        position += movement * fraction;
        remaining *= 1.0 - fraction;
        velocity = clip_velocity(velocity, hit.normal1);
    }
    (position, velocity)
}

fn clip_velocity(velocity: Vec3, normal: Vec3) -> Vec3 {
    let normal = normal.normalize_or_zero().as_dvec3();
    let velocity = velocity.as_dvec3();
    (velocity - normal * velocity.dot(normal).min(0.0)).as_vec3()
}

#[cfg(test)]
pub(super) mod tests {
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
    fn stopped_racer_can_turn_away_from_a_head_on_wall() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                for height in [1.1, 8.0] {
                    let mut state = flats_racer_physics::State::new(
                        [4.2, height, 0.0],
                        -std::f32::consts::FRAC_PI_2,
                    )
                    .unwrap();
                    let tuning = flats_racer_physics::Tuning {
                        air_control: 0.8,
                        ..Default::default()
                    };
                    let old = state.yaw;
                    state
                        .step_with_tuning(
                            flats_racer_physics::Input {
                                steer: 1.0,
                                ..Default::default()
                            },
                            if height < 2.0 {
                                [Some(1.1); 4]
                            } else {
                                [None; 4]
                            },
                            flats_racer_physics::FIXED_DT,
                            &tuning,
                        )
                        .unwrap();
                    assert!(state.yaw > old);
                    assert!(clear_turn(
                        &world,
                        Vec3::new(4.2, height, 0.0),
                        old,
                        state.yaw_rate * flats_racer_physics::FIXED_DT,
                    ));
                }
            })
            .expect("Avian fixture runs");
    }

    #[test]
    fn avian_four_supports_measure_center_relative_height() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                for distance in supports(&world, Vec3::Y * 1.1, 0.7, 1.9) {
                    assert!((distance.expect("floor under every probe") - 1.1).abs() < 0.001);
                }
                for distance in supports(&world, Vec3::Y * 40.0, 0.7, 41.0) {
                    assert!(
                        (distance.expect("floor remains visible during high hops") - 40.0).abs()
                            < 0.001
                    );
                }
            })
            .expect("Avian fixture runs");
    }

    #[test]
    fn sustained_slope_motion_keeps_thrust_and_hover_across_render_rates() {
        let mut results = Vec::new();
        for (hz, direction) in [
            (30, 1.0),
            (60, 1.0),
            (144, 1.0),
            (30, -1.0),
            (60, -1.0),
            (144, -1.0),
        ] {
            let mut app = fixture();
            let angle = 20.0_f32.to_radians();
            app.world_mut().spawn((
                RigidBody::Static,
                Collider::cuboid(1000.0, 1.0, 1000.0),
                Transform::from_xyz(200.0, 100.0 - 0.5 / angle.cos(), 20.0)
                    .with_rotation(Quat::from_rotation_z(angle)),
            ));
            app.update();
            let result = app
                .world_mut()
                .run_system_once(move |world: WorldCollision| {
                    let mut state = flats_racer_physics::State::new(
                        [
                            200.0 - 40.0 * direction,
                            100.0 - 40.0 * direction * angle.tan() + 2.2,
                            20.0,
                        ],
                        -std::f32::consts::FRAC_PI_2 * direction,
                    )
                    .unwrap();
                    state.velocity = [20.0 * direction, 20.0 * direction * angle.tan(), 0.0];
                    let tuning = flats_racer_physics::Tuning {
                        max_speed: 80.0,
                        boost_max_speed: 80.0,
                        drag: 0.0,
                        ..Default::default()
                    };
                    let mut progress = benilla_world::terrain_stream::WorldLoadProgress {
                        total: 1,
                        ready: 1,
                        focus_resident: true,
                        scene_ready: true,
                        complete: true,
                        focus_tile: Some((32, 32)),
                        collision_tiles: (31..=33).flat_map(|x| (31..=33).map(move |y| (x,y))).collect(),
                        ..Default::default()
                    };
                    let mut accumulator = 0.0;
                    let mut grounded = 0;
                    for frame in 0..hz * 3 {
                        let wow = benilla_assets::coords::bevy_to_wow(Vec3::from_array(state.position));
                        let tile = benilla_formats::world_to_tile(wow[0], wow[1]);
                        progress.focus_tile = Some((tile.0 as i32, tile.1 as i32));
                        assert!(
                            !super::super::advance_tuned(
                                &mut state,
                                &mut accumulator,
                                flats_racer_physics::Input {
                                    throttle: 1.0,
                                    ..Default::default()
                                },
                                1.0 / hz as f32,
                                &world,
                                &progress,
                                &tuning,
                            )
                            .unwrap(),
                            "{hz}Hz direction={direction}, frame={frame}, position={:?}", state.position
                        );
                        if frame >= hz {
                            grounded += usize::from(state.grounded);
                            let clearance =
                                state.position[1] - 100.0 - (state.position[0] - 200.0) * angle.tan();
                            assert!((0.7..2.5).contains(&clearance), "{hz}Hz: {clearance}");
                        }
                    }
                    assert!(
                        grounded > (hz * 2 * 9 / 10) as usize,
                        "{hz}Hz: {grounded} supported"
                    );
                    assert!(state.velocity[0] * direction > 65.0, "{hz}Hz: {:?}", state.velocity);
                    println!("{hz}Hz slope direction={direction}: position={:?}, velocity={:?}, grounded frames={grounded}", state.position, state.velocity);
                    state.position
                })
                .unwrap();
            results.push(result);
        }
        for group in results.chunks_exact(3) {
            for result in &group[1..] {
                assert!(Vec3::from_array(*result).distance(Vec3::from_array(group[0])) < 0.01);
            }
        }
    }

    #[test]
    fn steep_faces_cannot_supply_hover_or_terrain_motion() {
        let mut app = fixture();
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(100.0, 1.0, 100.0),
            Transform::from_xyz(0.0, 99.0, 0.0)
                .with_rotation(Quat::from_rotation_z(60.0_f32.to_radians())),
        ));
        app.update();
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                let (distances, rise) = supports_with_motion(
                    &world,
                    Vec3::new(0.0, 101.1, 0.0),
                    0.0,
                    1.9,
                    Vec3::X * 500.0,
                );
                assert_eq!(distances, [None; 4]);
                assert_eq!(rise, 0.0);
            })
            .unwrap();
    }

    #[test]
    fn support_rays_are_altitude_independent_and_distant_ground_does_not_hover() {
        let mut app = fixture();
        for height in [-500.0, 1500.0] {
            app.world_mut().spawn((
                RigidBody::Static,
                Collider::cuboid(100.0, 1.0, 100.0),
                Transform::from_xyz(height, height - 0.5, 0.0),
            ));
        }
        app.update();
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                for height in [-500.0, 1500.0] {
                    for distance in supports(&world, Vec3::new(height, height + 1.1, 0.0), 0.0, 1.9)
                    {
                        assert!((distance.unwrap() - 1.1).abs() < 0.001);
                    }
                }
                assert_eq!(supports(&world, Vec3::Y * 40.0, 0.0, 1.9), [None; 4]);
            })
            .unwrap();
    }

    #[test]
    fn high_requested_speed_is_swept_and_full_revolutions_check_the_entire_body_arc() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                let (position, velocity) = slide(
                    &world,
                    Vec3::new(6.0, 1.1, 0.0),
                    Vec3::new(5000.0, 0.0, 0.0),
                    0.0,
                    flats_racer_physics::FIXED_DT,
                );
                assert!(position.x < 7.5 && position.x >= 6.0, "{position:?}");
                assert!(velocity.x.abs() < 0.01);
                assert!(!clear_turn(&world, Vec3::new(6.0, 1.1, 0.0), 0.0, 1000.0));
            })
            .unwrap();
    }

    #[test]
    fn newly_accelerated_frontier_crossing_holds_before_committing_the_step() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                let tile = benilla_formats::world_to_tile(-20.0, -20.0);
                let progress = benilla_world::terrain_stream::WorldLoadProgress {
                    total: 1,
                    ready: 1,
                    focus_resident: true,
                    scene_ready: true,
                    focus_tile: Some((tile.0 as i32, tile.1 as i32)),
                    collision_tiles: [(tile.0 as i32, tile.1 as i32)].into_iter().collect(),
                    ..Default::default()
                };
                let mut state = flats_racer_physics::State::new([20.0, 1.1, 20.0], 0.0).unwrap();
                let tuning = flats_racer_physics::Tuning {
                    max_speed: 1.0e9,
                    boost_max_speed: 1.0e9,
                    acceleration: 1.0e9,
                    ..Default::default()
                };
                let mut accumulator = 0.0;
                assert!(super::super::advance_tuned(
                    &mut state,
                    &mut accumulator,
                    flats_racer_physics::Input {
                        throttle: 1.0,
                        ..Default::default()
                    },
                    flats_racer_physics::FIXED_DT,
                    &world,
                    &progress,
                    &tuning,
                )
                .unwrap());
                assert_eq!(state.position, [20.0, 1.1, 20.0]);
                assert_eq!(state.velocity, [0.0; 3]);
                assert_eq!(accumulator, 0.0);
            })
            .unwrap();
    }

    #[test]
    fn long_frame_discards_backlog_without_stopping_airborne_momentum() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                let progress = benilla_world::terrain_stream::WorldLoadProgress {
                    collision_tiles: (31..=33)
                        .flat_map(|x| (31..=33).map(move |y| (x, y)))
                        .collect(),
                    ..Default::default()
                };
                let mut state = flats_racer_physics::State::new([20.0, 100.0, 20.0], 0.0).unwrap();
                state.velocity = [0.0, 0.0, 500.0];
                let tuning = flats_racer_physics::Tuning {
                    max_speed: 500.0,
                    boost_max_speed: 500.0,
                    drag: 0.0,
                    ..Default::default()
                };
                let mut accumulator = 0.0;
                assert!(!super::super::advance_tuned(
                    &mut state,
                    &mut accumulator,
                    Default::default(),
                    0.4,
                    &world,
                    &progress,
                    &tuning,
                )
                .unwrap());
                assert!((state.position[2] - 70.0).abs() < 0.01);
                assert!((state.velocity[2] - 500.0).abs() < 0.01);
                assert!(accumulator < 1.0 / 120.0);
                let before = state.position[2];
                assert!(!super::super::advance_tuned(
                    &mut state,
                    &mut accumulator,
                    Default::default(),
                    1.0 / 60.0,
                    &world,
                    &progress,
                    &tuning,
                )
                .unwrap());
                assert!((state.position[2] - before - 500.0 / 60.0).abs() < 0.01);
            })
            .unwrap();
    }

    #[test]
    fn streaming_holds_preserve_ground_and_air_momentum_without_catchup() {
        for hz in [30, 60, 144] {
            for speed in [250.0, 500.0] {
                for y in [1.1, 100.0] {
                    fixture()
                        .world_mut()
                        .run_system_once(move |world: WorldCollision| {
                            let mut state = flats_racer_physics::State::new(
                                [20.0, y, 20.0],
                                std::f32::consts::PI,
                            )
                            .unwrap();
                            state.velocity = [0.0, 7.0, speed];
                            state.yaw_rate = 0.5;
                            let before = state;
                            let mut accumulator = 0.0;
                            let mut progress =
                                benilla_world::terrain_stream::WorldLoadProgress::default();
                            let tuning = flats_racer_physics::Tuning {
                                max_speed: speed,
                                boost_max_speed: speed,
                                drag: 0.0,
                                ..Default::default()
                            };
                            for _ in 0..hz * 2 {
                                assert!(super::super::advance_tuned(
                                    &mut state,
                                    &mut accumulator,
                                    Default::default(),
                                    1.0 / hz as f32,
                                    &world,
                                    &progress,
                                    &tuning,
                                )
                                .unwrap());
                                assert_eq!(state.position, before.position);
                                assert_eq!(state.velocity, before.velocity);
                                assert_eq!(state.yaw_rate, before.yaw_rate);
                                assert_eq!(accumulator, 0.0);
                            }
                            progress.collision_tiles = (31..=33)
                                .flat_map(|x| (31..=33).map(move |y| (x, y)))
                                .collect();
                            assert!(!super::super::advance_tuned(
                                &mut state,
                                &mut accumulator,
                                Default::default(),
                                1.0 / 30.0,
                                &world,
                                &progress,
                                &tuning,
                            )
                            .unwrap());
                            let displacement = Vec3::from_array(state.position)
                                .distance(Vec3::from_array(before.position));
                            assert!(
                                displacement > 1.0 && displacement < speed / 30.0 + 1.0,
                                "{hz}Hz, speed={speed}, y={y}: resume moved {displacement}"
                            );
                            assert!(
                                state.velocity[2] > speed * 0.99,
                                "resume must not rebuild horizontal momentum: {:?}",
                                state.velocity
                            );
                        })
                        .unwrap();
                }
            }
        }
    }

    #[test]
    fn high_speed_ground_and_air_ignore_distant_backlog_at_all_frame_rates() {
        for speed in [250.0, 500.0] {
            for y in [1.1, 100.0] {
                let positions = [30, 60, 144].map(|hz| {
                    fixture()
                        .world_mut()
                        .run_system_once(move |world: WorldCollision| {
                            let mut state = flats_racer_physics::State::new(
                                [20.0, y, 20.0],
                                std::f32::consts::PI,
                            )
                            .unwrap();
                            state.velocity = [0.0, 0.0, speed];
                            let progress = benilla_world::terrain_stream::WorldLoadProgress {
                                collision_tiles: (31..=34)
                                    .flat_map(|x| (31..=34).map(move |y| (x, y)))
                                    .collect(),
                                colliders_pending: 100,
                                placements_pending: 100,
                                merge_pending: 100,
                                ..Default::default()
                            };
                            let tuning = flats_racer_physics::Tuning {
                                max_speed: speed,
                                boost_max_speed: speed,
                                drag: 0.0,
                                ..Default::default()
                            };
                            let mut accumulator = 0.0;
                            for frame in 0..hz {
                                assert!(
                                    !super::super::advance_tuned(
                                        &mut state,
                                        &mut accumulator,
                                        flats_racer_physics::Input {
                                            throttle: 1.0,
                                            ..Default::default()
                                        },
                                        1.0 / hz as f32,
                                        &world,
                                        &progress,
                                        &tuning,
                                    )
                                    .unwrap(),
                                    "{hz}Hz frame={frame}"
                                );
                                assert!(
                                    state.velocity[2] > speed * 0.99,
                                    "{hz}Hz frame={frame} speed={speed} y={y}: {:?}",
                                    state.velocity
                                );
                            }
                            assert!((state.position[2] - 20.0 - speed).abs() < 0.02);
                            state.position
                        })
                        .unwrap()
                });
                for position in &positions[1..] {
                    assert!(
                        Vec3::from_array(*position).distance(Vec3::from_array(positions[0])) < 0.01
                    );
                }
            }
        }
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
                    collision_tiles: (31..=33)
                        .flat_map(|x| (31..=33).map(move |y| (x, y)))
                        .collect(),
                    ..Default::default()
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
                progress.merge_pending = 200;
                progress.placements_pending = 200;
                assert!(!super::super::advance(
                    &mut state,
                    &mut 0.0,
                    Input::default(),
                    0.1,
                    &world,
                    &progress,
                )
                .unwrap());
                assert_ne!(state.position, before);
                progress.collision_tiles.clear();
                let before = state;
                assert!(super::super::advance(
                    &mut state,
                    &mut 0.0,
                    Input::default(),
                    0.1,
                    &world,
                    &progress
                )
                .unwrap());
                assert_eq!(state.position, before.position);
                assert_eq!(state.velocity, before.velocity);
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
