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
    supports_with_motion(world, position, yaw, reach, Vec3::ZERO, &|_| None).0
}

pub(super) fn supports_with_motion(
    world: &WorldCollision,
    position: Vec3,
    yaw: f32,
    reach: f32,
    velocity: Vec3,
    water_surface: &impl Fn(Vec3) -> Option<f32>,
) -> ([Option<f32>; 4], f32) {
    let rotation = Quat::from_rotation_y(yaw);
    let mut rise = 0.0_f64;
    let mut count = 0;
    let distances = PROBES.map(|offset| {
        let probe = position + rotation * offset;
        let from = probe + Vec3::Y * 2.0;
        // Relative reach works at any terrain altitude; distant ground cannot supply lift.
        let ground = world
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
                // n dot (vx, terrain-rise, vz) = 0 on the actual collision plane.
                let surface_velocity = -(f64::from(hit.normal.x) * f64::from(velocity.x)
                        + f64::from(hit.normal.z) * f64::from(velocity.z))
                        / f64::from(hit.normal.y);
                Some((distance, surface_velocity))
            });
        let water = water_surface(probe)
            .filter(|height| height.is_finite() && probe.y >= *height - 0.03)
            .map(|height| ((probe.y - height).max(0.0), 0.0));
        let support = match (ground, water) {
            (Some(ground), Some(water)) => Some(if water.0 < ground.0 { water } else { ground }),
            (ground, water) => ground.or(water),
        };
        support.map(|(distance, surface_velocity)| {
            if distance <= reach {
                rise += surface_velocity;
                count += 1;
            }
            distance
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

pub(super) fn land_on_water(
    from: Vec3,
    mut to: Vec3,
    mut velocity: Vec3,
    water_surface: &impl Fn(Vec3) -> Option<f32>,
) -> (Vec3, Vec3) {
    // Catch a fast descent through a wet cell, without lifting a submerged rider or a dry shore.
    if let Some(height) = water_surface(to).filter(|height| height.is_finite()) {
        if from.y >= height && to.y < height && velocity.y < 0.0 {
            to.y = height;
            velocity.y = 0.0;
        }
    }
    (to, velocity)
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

    fn water_patch(kind: benilla_formats::LiquidKind, wet: bool) -> benilla_world::liquid::WaterChunkInfo {
        benilla_world::liquid::WaterChunkInfo::new(
            benilla_world::liquid::LiquidSource::AdtChunk,
            kind,
            [2, 2],
            vec![[-200.0, -200.0, 5.0], [200.0, -200.0, 5.0],
                 [-200.0, 200.0, 5.0], [200.0, 200.0, 5.0]],
            vec![wet],
        )
    }

    #[test]
    fn water_support_uses_wet_cells_and_prefers_a_bridge_above_water() {
        let mut app = fixture();
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(12.0, 1.0, 12.0),
            Transform::from_xyz(-50.0, 7.0, 20.0),
        ));
        app.update();
        app.world_mut().run_system_once(|world: WorldCollision| {
            use benilla_world::liquid::{water_surface_at, LiquidClaim};
            for wet in [false, true] {
                let patch = water_patch(benilla_formats::LiquidKind::Still, wet);
                let water = |point| water_surface_at(
                    [&patch].into_iter(), benilla_assets::coords::bevy_to_wow(point), LiquidClaim::Outdoors,
                );
                let (distances, rise) = supports_with_motion(
                    &world, Vec3::new(-20.0, 6.1, 20.0), 0.0, 1.9, Vec3::Z * 50.0, &water,
                );
                for distance in distances {
                    if wet {
                        assert!((distance.unwrap() - 1.1).abs() < 0.001);
                    } else {
                        assert!(distance.is_none_or(|distance| distance > 1.9));
                    }
                }
                assert_eq!(rise, 0.0);
                let (distances, _) = supports_with_motion(
                    &world, Vec3::new(-50.0, 8.6, 20.0), 0.0, 1.9, Vec3::ZERO, &water,
                );
                for distance in distances {
                    assert!((distance.unwrap() - 1.1).abs() < 0.001);
                }
            }
        }).unwrap();
    }

    #[test]
    fn racer_hovers_drives_and_hops_on_water_without_changing_land_collision() {
        fixture().world_mut().run_system_once(|world: WorldCollision| {
            use benilla_world::liquid::{water_surface_at, LiquidClaim};
            use flats_racer_physics::{Input, State, Tuning};
            let patch = water_patch(benilla_formats::LiquidKind::Still, true);
            let water = |point| water_surface_at(
                [&patch].into_iter(), benilla_assets::coords::bevy_to_wow(point), LiquidClaim::Outdoors,
            );
            let progress = benilla_world::terrain_stream::WorldLoadProgress {
                collision_tiles: (30..=33).flat_map(|x| (30..=33).map(move |y| (x, y))).collect(),
                ..Default::default()
            };
            for hz in [30, 60, 144] {
                let tuning = Tuning::default();
                let mut state = State::new([-20.0, 6.1, 20.0], 0.0).unwrap();
                let mut accumulator = 0.0;
                for frame in 0..hz * 3 {
                    assert!(!super::super::advance_tuned(
                        &mut state, &mut accumulator,
                        Input { throttle: 1.0, jump: (hz..hz + hz / 10).contains(&frame), ..Default::default() },
                        1.0 / hz as f32, &world, &progress, &tuning, &water,
                    ).unwrap());
                    assert!(state.position[1] >= 5.0);
                    if frame == hz + hz / 10 {
                        assert!(state.velocity[1] > 0.0 && !state.grounded, "{hz} Hz: {state:?}");
                    }
                }
                assert!(state.position[2] < 0.0, "must drive across the water");
                assert!(state.grounded);
                assert!((state.position[1] - 6.1).abs() < 0.1);
            }
        }).unwrap();
    }

    #[test]
    fn water_landing_catches_fast_descent_but_not_dry_lava_or_submerged_motion() {
        use benilla_world::liquid::{water_surface_at, LiquidClaim};
        let from = Vec3::new(-20.0, 8.0, 20.0);
        let to = Vec3::new(-20.0, 2.0, 19.0);
        let velocity = Vec3::new(0.0, -500.0, -60.0);
        for (kind, wet, catches) in [
            (benilla_formats::LiquidKind::Still, true, true),
            (benilla_formats::LiquidKind::Ocean, true, true),
            (benilla_formats::LiquidKind::Still, false, false),
            (benilla_formats::LiquidKind::Magma, true, false),
            (benilla_formats::LiquidKind::Slime, true, false),
        ] {
            let patch = water_patch(kind, wet);
            let water = |point| water_surface_at(
                [&patch].into_iter(), benilla_assets::coords::bevy_to_wow(point), LiquidClaim::Outdoors,
            );
            let (position, result) = land_on_water(from, to, velocity, &water);
            assert_eq!(position.y, if catches { 5.0 } else { to.y });
            assert_eq!(result.y, if catches { 0.0 } else { velocity.y });
            assert_eq!(position.z, to.z);
            assert_eq!(result.z, velocity.z);
            assert_eq!(land_on_water(to, to - Vec3::Y, velocity, &water).0, to - Vec3::Y);
        }
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
                                &|_| None,
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
                    &|_| None,
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
                    &|_| None,
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
                    &|_| None,
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
                    &|_| None,
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
                                    &|_| None,
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
                                &|_| None,
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
                                        &|_| None,
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

    /// Integration-level reproduction for "thrust does nothing while airborne": unlike the
    /// `flats-racer-physics` unit tests, this drives `advance_tuned` end to end with real Avian
    /// collision (supports, `clear_turn`, `slide`) over open, fully streamed flat ground, so any
    /// zeroing introduced by the collision/streaming integration layer (not just the physics
    /// crate) would show up here.
    #[test]
    fn airborne_throttle_still_gains_speed_after_a_hop_through_real_collision() {
        fixture()
            .world_mut()
            .run_system_once(|world: WorldCollision| {
                use benilla_world::terrain_stream::WorldLoadProgress;
                use flats_racer_physics::{Input, State, Tuning};
                let tile = benilla_formats::world_to_tile(20.0, 20.0);
                let progress = WorldLoadProgress {
                    total: 1,
                    ready: 1,
                    focus_resident: true,
                    scene_ready: true,
                    complete: true,
                    focus_tile: Some((tile.0 as i32, tile.1 as i32)),
                    collision_tiles: (-1..=1)
                        .flat_map(|x| (-1..=1).map(move |y| (tile.0 as i32 + x, tile.1 as i32 + y)))
                        .collect(),
                    ..Default::default()
                };
                let tuning = Tuning::default();
                let mut state = State::new([20.0, 1.1, 20.0], 0.0).unwrap();
                let mut accumulator = 0.0;
                // Settle onto the ground first so the hop starts from a real grounded state.
                for _ in 0..60 {
                    assert!(!super::super::advance_tuned(
                        &mut state,
                        &mut accumulator,
                        Input::default(),
                        flats_racer_physics::FIXED_DT,
                        &world,
                        &progress,
                        &tuning,
                        &|_| None,
                    )
                    .unwrap());
                }
                assert!(state.grounded, "expected to settle onto open flat ground");
                // Hop, then hold thrust while airborne, exactly like pressing Space then W.
                assert!(!super::super::advance_tuned(
                    &mut state,
                    &mut accumulator,
                    Input {
                        throttle: 1.0,
                        jump: true,
                        ..Default::default()
                    },
                    flats_racer_physics::FIXED_DT,
                    &world,
                    &progress,
                    &tuning,
                    &|_| None,
                )
                .unwrap());
                assert!(!state.grounded, "the hop must leave the racer airborne");
                let speed_after_hop = state.velocity[0].hypot(state.velocity[2]);
                let mut peak_airborne_speed = speed_after_hop;
                for _ in 0..30 {
                    if state.grounded {
                        break;
                    }
                    assert!(!super::super::advance_tuned(
                        &mut state,
                        &mut accumulator,
                        Input {
                            throttle: 1.0,
                            ..Default::default()
                        },
                        flats_racer_physics::FIXED_DT,
                        &world,
                        &progress,
                        &tuning,
                        &|_| None,
                    )
                    .unwrap());
                    peak_airborne_speed = peak_airborne_speed.max(state.velocity[0].hypot(state.velocity[2]));
                }
                assert!(
                    peak_airborne_speed > speed_after_hop + 0.3,
                    "midair thrust had no effect: speed_after_hop={speed_after_hop}, \
                     peak_airborne_speed={peak_airborne_speed}"
                );
            })
            .unwrap();
    }

    /// Same reproduction, but driving straight off a ledge with a sheer drop at the lip, since
    /// the bug report also names "falling off a ledge". A cliff face sitting right under the
    /// departure point is the one geometry where the fore/aft collision sweep in [`slide`] could
    /// plausibly keep re-clipping forward thrust against the wall it just drove past.
    #[test]
    fn airborne_throttle_still_gains_speed_after_driving_off_a_ledge() {
        let mut app = App::new();
        app.add_plugins((
            bevy::MinimalPlugins,
            bevy::transform::TransformPlugin,
            bevy::asset::AssetPlugin::default(),
            bevy::scene::ScenePlugin,
            avian3d::prelude::PhysicsPlugins::new(PostUpdate),
        ));
        app.init_asset::<Mesh>();
        app.init_resource::<benilla_world::collision::MoverTraceExclusions>();
        use avian3d::prelude::RigidBody;
        // Platform the racer drives on, from x=-1000 up to the lip at x=0. `Collider::cuboid`
        // takes full extents (matching `fixture()`'s ground, whose y=-0.5, size-1 top sits at 0).
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(1000.0, 1.0, 2000.0),
            Transform::from_xyz(-500.0, -0.5, 0.0),
        ));
        // A sheer cliff face right under the lip, as if the ground simply ends there.
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(1.0, 1000.0, 2000.0),
            Transform::from_xyz(0.0, -500.0, 0.0),
        ));
        app.finish();
        app.cleanup();
        app.update();
        app.world_mut()
            .run_system_once(|world: WorldCollision| {
                use benilla_world::terrain_stream::WorldLoadProgress;
                use flats_racer_physics::{Input, State, Tuning};
                let tile = benilla_formats::world_to_tile(-20.0, 0.0);
                let progress = WorldLoadProgress {
                    total: 1,
                    ready: 1,
                    focus_resident: true,
                    scene_ready: true,
                    complete: true,
                    focus_tile: Some((tile.0 as i32, tile.1 as i32)),
                    collision_tiles: (-1..=1)
                        .flat_map(|x| (-1..=1).map(move |y| (tile.0 as i32 + x, tile.1 as i32 + y)))
                        .collect(),
                    ..Default::default()
                };
                let tuning = Tuning::default();
                // Forward is +X at this yaw, driving straight toward the lip at x=0.
                let mut state =
                    State::new([-20.0, 1.1, 0.0], -std::f32::consts::FRAC_PI_2).unwrap();
                let mut accumulator = 0.0;
                for _ in 0..60 {
                    assert!(!super::super::advance_tuned(
                        &mut state,
                        &mut accumulator,
                        Input {
                            throttle: 1.0,
                            ..Default::default()
                        },
                        flats_racer_physics::FIXED_DT,
                        &world,
                        &progress,
                        &tuning,
                        &|_| None,
                    )
                    .unwrap());
                }
                assert!(
                    state.grounded,
                    "expected to settle onto the platform: {state:?}"
                );
                assert!(state.position[0] > -20.0, "throttle must move it toward the ledge");
                // Drive the rest of the way to and off the ledge, continuing to hold thrust.
                let mut speed_while_airborne = Vec::new();
                for _ in 0..240 {
                    assert!(!super::super::advance_tuned(
                        &mut state,
                        &mut accumulator,
                        Input {
                            throttle: 1.0,
                            ..Default::default()
                        },
                        flats_racer_physics::FIXED_DT,
                        &world,
                        &progress,
                        &tuning,
                        &|_| None,
                    )
                    .unwrap());
                    if !state.grounded {
                        speed_while_airborne.push(state.velocity[0].hypot(state.velocity[2]));
                    }
                }
                assert!(
                    speed_while_airborne.len() > 10,
                    "expected a sustained fall off the ledge, got {} airborne samples",
                    speed_while_airborne.len()
                );
                let first = speed_while_airborne[0];
                let last = *speed_while_airborne.last().unwrap();
                assert!(
                    last > first + 0.3,
                    "midair thrust had no effect while falling off the ledge: first={first}, last={last}, \
                     samples={speed_while_airborne:?}"
                );
            })
            .unwrap();
    }
}
