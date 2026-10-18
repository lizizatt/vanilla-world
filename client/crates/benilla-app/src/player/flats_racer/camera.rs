//! Deviation: tunable positional low-pass for the custom racer camera.

use super::*;

pub(super) const DEFAULT_POSITION_SECONDS: f32 = 0.5;

pub(super) fn update_controls(
    cockpit: &mut bool,
    toggle: bool,
    zoom: f32,
    dt: f32,
    max: f32,
    rig: &mut super::super::camera::CameraControl,
) {
    if toggle {
        *cockpit = !*cockpit;
    }
    if !*cockpit {
        super::super::camera_zoom::apply_zoom_scroll(zoom, dt, rig, max);
    }
}

pub(super) fn cockpit_active(racer: Res<FlatsRacer>) -> bool {
    racer.enabled && racer.authorized && racer.cockpit && racer.dynamics.is_some()
}

fn cockpit_pose(frame: GlobalTransform, vehicle: Quat, eye_height: f32) -> Transform {
    Transform::from_translation(frame.transform_point(Vec3::Y * eye_height)).with_rotation(vehicle)
}

pub(super) fn seat_cockpit(
    mut racer: ResMut<FlatsRacer>,
    mut rig: ResMut<super::super::camera::CameraControl>,
    riders: Query<
        (
            Entity,
            &benilla_world::rig_anim::RigPose,
            &super::super::camera::CameraPivot,
            &crate::entities::mount::MountChild,
        ),
        With<crate::net::Embodied>,
    >,
    mut transforms: ParamSet<(
        bevy::transform::helper::TransformHelper,
        Query<(&mut Transform, &mut GlobalTransform), With<benilla_world::view::WorldCamera>>,
    )>,
    world: benilla_world::collision::WorldCollision,
) {
    let pose = riders
        .single()
        .ok()
        .and_then(|(rider, pose, pivot, mount)| {
            if pose.joints_root == rider {
                return None;
            }
            let helper = transforms.p0();
            let frame = helper.compute_global_transform(pose.joints_root).ok()?;
            let vehicle = helper.compute_global_transform(mount.0).ok()?;
            let body = helper.compute_global_transform(rider).ok()?;
            Some((
                cockpit_pose(
                    frame,
                    vehicle.rotation(),
                    super::super::camera::head_height(Some(pivot), 1.0),
                ),
                body.translation(),
            ))
        });
    let Some((mut pose, origin)) = pose else {
        warn!("flats racer: cockpit unavailable until the mounted rider seat and camera pivot are loaded");
        racer.cockpit = false;
        racer.status = "Cockpit unavailable - rider seat still loading";
        racer.camera_position.clear();
        rig.self_fade_alpha = 1.0;
        return;
    };
    let offset = pose.translation - origin;
    let allowed = world
        .cast_camera(origin, offset, false)
        .unwrap_or(offset.length());
    pose.translation = origin + offset.normalize_or_zero() * allowed.max(0.0);
    if let Ok((mut local, mut global)) = transforms.p1().single_mut() {
        *local = pose;
        *global = GlobalTransform::from(pose);
        rig.collision_distance = 0.0;
        rig.self_fade_alpha = 0.0;
    }
}

fn heading(
    cam: &mut super::super::camera::FlyCam,
    yaw: f32,
    dt: f32,
    reset: bool,
    look: Vec2,
    config: super::super::camera::LookConfig,
) {
    // Match the original chase arm's 0.3 rise, now expressed in the ordinary YXZ convention.
    let pitch = -0.3_f32.atan();
    if reset {
        cam.yaw = yaw;
        cam.pitch = pitch;
    } else if look != Vec2::ZERO {
        cam.yaw -= look.x * config.yaw_speed.to_radians() * config.sensitivity * dt;
        if cam.yaw.abs() > std::f32::consts::PI {
            cam.yaw = crate::creature_anim::wrap_pi(cam.yaw);
        }
        let vertical = if config.invert_pitch { -look.y } else { look.y };
        cam.pitch = (cam.pitch
            + vertical * config.pitch_speed.to_radians() * config.sensitivity * dt)
            .clamp(
                -super::super::camera::CAM_PITCH_LIMIT,
                super::super::camera::CAM_PITCH_LIMIT,
            );
    } else {
        let blend = -(-7.0 * dt.max(0.0)).exp_m1();
        cam.yaw += crate::creature_anim::wrap_pi(yaw - cam.yaw) * blend;
        cam.pitch += (pitch - cam.pitch) * blend;
    }
}

#[derive(Default)]
pub(super) struct PositionFilter(Option<Vec3>);

impl PositionFilter {
    pub(super) fn clear(&mut self) {
        self.0 = None;
    }

    fn candidate(&self, wanted: Vec3, dt: f32, seconds: f32, snap: bool) -> Vec3 {
        let Some(previous) = self.0.filter(|_| !snap && seconds > 0.0) else {
            return wanted;
        };
        // exp_m1 retains precision even for very long time constants.
        let blend = -(-f64::from(dt.max(0.0)) / f64::from(seconds)).exp_m1();
        previous.as_dvec3().lerp(wanted.as_dvec3(), blend).as_vec3()
    }
}

pub(super) fn chase(
    position: Vec3,
    yaw: f32,
    distance: f32,
    dt: f32,
    reset: bool,
    look: Vec2,
    look_config: super::super::camera::LookConfig,
    seconds: f32,
    filter: &mut PositionFilter,
    camera: &mut Transform,
    cam: &mut super::super::camera::FlyCam,
    rig: &mut super::super::camera::CameraControl,
    world: &benilla_world::collision::WorldCollision,
) {
    heading(cam, yaw, dt, reset, look, look_config);
    let pivot = position + Vec3::Y * 3.0;
    let direction = Quat::from_euler(EulerRot::YXZ, cam.yaw, cam.pitch, 0.0) * Vec3::Z;
    let allowed = world
        .cast_camera(pivot, direction * distance, false)
        .unwrap_or(distance);
    let wanted = pivot + direction * (allowed - 0.15).max(0.0);
    let candidate = filter.candidate(wanted, dt, seconds, reset);
    // Clip AFTER filtering too: an old seat can be behind a newly intruding wall.
    let offset = candidate - pivot;
    let clear = world
        .cast_camera(pivot, offset, false)
        .unwrap_or(offset.length());
    camera.translation = pivot + offset.normalize_or_zero() * clear.max(0.0);
    filter.0 = Some(camera.translation);
    if offset.length_squared() > f32::EPSILON {
        camera.look_at(pivot, Vec3::Y);
    } else {
        camera.rotation = Quat::from_euler(EulerRot::YXZ, cam.yaw, cam.pitch, 0.0);
    }
    rig.collision_distance = clear;
    rig.self_fade_alpha = 1.0;
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ecs::system::RunSystemOnce;

    #[test]
    fn zoom_uses_existing_bounds_and_cockpit_preserves_chase_target() {
        let mut rig = super::super::super::camera::CameraControl::default();
        rig.park_distance(12.0);
        let mut cockpit = false;
        update_controls(&mut cockpit, false, 2.0, 1.0, 45.0, &mut rig);
        assert_eq!(rig.target_distance, 10.0);
        update_controls(&mut cockpit, true, 100.0, 1.0, 45.0, &mut rig);
        assert!(cockpit);
        assert_eq!((rig.distance, rig.target_distance), (10.0, 10.0));
        update_controls(&mut cockpit, false, -100.0, 1.0, 45.0, &mut rig);
        assert_eq!(rig.target_distance, 10.0);
        update_controls(&mut cockpit, true, 0.0, 1.0, 45.0, &mut rig);
        assert!(!cockpit);
        assert_eq!(rig.target_distance, 10.0);
        update_controls(&mut cockpit, false, -100.0, 1.0, 45.0, &mut rig);
        assert_eq!(rig.target_distance, 45.0);
        update_controls(&mut cockpit, false, 100.0, 1.0, 45.0, &mut rig);
        assert_eq!(rig.target_distance, 0.0);
    }

    #[test]
    fn cockpit_follows_live_seat_and_vehicle_rotation_without_chase_lag() {
        use crate::net::Embodied;
        use benilla_world::rig_anim::RigPose;
        let mut app = super::super::collision::tests::fixture();
        app.insert_resource(FlatsRacer {
            enabled: true,
            authorized: true,
            cockpit: true,
            dynamics: Some(flats_racer_physics::State::new([-50.0, 1.1, 0.0], 0.0).unwrap()),
            ..Default::default()
        });
        let mut rig = super::super::super::camera::CameraControl::default();
        rig.park_distance(12.0);
        app.insert_resource(rig);
        let rider = app
            .world_mut()
            .spawn((Transform::from_xyz(-50.0, 1.1, 0.0), Embodied))
            .id();
        let mount = app.world_mut().spawn(Transform::default()).id();
        let seat = app
            .world_mut()
            .spawn(Transform::from_xyz(0.0, 1.0, 0.0))
            .id();
        app.world_mut().entity_mut(rider).add_child(mount);
        app.world_mut().entity_mut(mount).add_child(seat);
        let pose = RigPose::new(
            seat,
            &benilla_assets::ModelSkeleton {
                joints: vec![],
                spine_bone: None,
                head_bone: None,
            },
        );
        app.world_mut().entity_mut(rider).insert((
            pose,
            crate::entities::mount::MountChild(mount),
            super::super::super::camera::CameraPivot {
                height_local: 1.5,
                swim_drop_local: 0.0,
            },
        ));
        let camera = app
            .world_mut()
            .spawn((benilla_world::view::WorldCamera, Transform::default()))
            .id();
        for frame in 0..10 {
            let rotation = Quat::from_euler(EulerRot::YXZ, frame as f32 * 0.2, 0.1, 0.05);
            let body = Transform::from_xyz(-50.0 + frame as f32, 1.1, 0.0).with_rotation(rotation);
            *app.world_mut().get_mut::<Transform>(rider).unwrap() = body;
            app.world_mut().run_system_once(seat_cockpit).unwrap();
            let actual = app.world().get::<Transform>(camera).unwrap();
            assert!(
                actual
                    .translation
                    .distance(body.transform_point(Vec3::Y * 2.5))
                    < 0.0001
            );
            assert!(actual.rotation.angle_between(rotation) < 0.001);
            assert_eq!(
                app.world()
                    .get::<GlobalTransform>(camera)
                    .unwrap()
                    .translation(),
                actual.translation
            );
            let rig = app
                .world()
                .resource::<super::super::super::camera::CameraControl>();
            assert_eq!(rig.target_distance, 12.0);
            assert_eq!(rig.self_fade_alpha, 0.0);
        }
        *app.world_mut().get_mut::<Transform>(rider).unwrap() = Transform::from_xyz(0.0, 1.1, 0.0);
        app.world_mut()
            .get_mut::<Transform>(seat)
            .unwrap()
            .translation = Vec3::X * 100.0;
        app.world_mut().run_system_once(seat_cockpit).unwrap();
        assert!(app.world().get::<Transform>(camera).unwrap().translation.x < 10.0);
        app.world_mut().resource_mut::<FlatsRacer>().revoke();
        assert!(!app.world_mut().run_system_once(cockpit_active).unwrap());
    }

    #[test]
    fn stick_orbit_and_release_recenter_are_frame_rate_independent() {
        let config = super::super::super::camera::LookConfig::default();
        for steps in [
            vec![1.0 / 30.0; 30],
            vec![1.0 / 60.0; 60],
            vec![1.0 / 144.0; 144],
            vec![0.001, 0.199, 0.3, 0.5],
        ] {
            let mut cam = super::super::super::camera::FlyCam {
                yaw: 0.0,
                pitch: 0.0,
                speed: 0.0,
            };
            heading(&mut cam, 0.0, 0.0, true, Vec2::ZERO, config);
            let neutral = cam.pitch;
            for &dt in &steps {
                // A conflicting vehicle heading must not recenter while the stick owns the view.
                heading(&mut cam, 1.0, dt, false, Vec2::new(0.25, 0.25), config);
            }
            let wanted_yaw = -config.yaw_speed.to_radians() * 0.25;
            let wanted_pitch = neutral + config.pitch_speed.to_radians() * 0.25;
            assert!((cam.yaw - wanted_yaw).abs() < 0.00001);
            assert!((cam.pitch - wanted_pitch).abs() < 0.00001);
            for &dt in &steps {
                heading(&mut cam, 0.0, dt, false, Vec2::ZERO, config);
            }
            assert!((cam.yaw - wanted_yaw * (-7.0_f32).exp()).abs() < 0.00001);
            assert!(
                (cam.pitch - neutral - (wanted_pitch - neutral) * (-7.0_f32).exp()).abs() < 0.00001
            );
        }
    }

    #[test]
    fn pitch_respects_inversion_limit_and_reset_restores_original_arm() {
        let mut cam = super::super::super::camera::FlyCam {
            yaw: 2.0,
            pitch: 0.0,
            speed: 0.0,
        };
        let mut config = super::super::super::camera::LookConfig::default();
        heading(&mut cam, 0.0, 10.0, false, Vec2::Y, config);
        assert_eq!(cam.pitch, super::super::super::camera::CAM_PITCH_LIMIT);
        config.invert_pitch = true;
        heading(&mut cam, 0.0, 10.0, false, Vec2::Y, config);
        assert_eq!(cam.pitch, -super::super::super::camera::CAM_PITCH_LIMIT);
        heading(&mut cam, 0.0, 10.0, false, Vec2::X, config);
        assert!(cam.yaw.abs() <= std::f32::consts::PI);
        heading(&mut cam, 0.7, 1.0, true, Vec2::ONE, config);
        assert_eq!(cam.yaw, 0.7);
        let direction = Quat::from_euler(EulerRot::YXZ, cam.yaw, cam.pitch, 0.0) * Vec3::Z;
        let original = Quat::from_rotation_y(0.7) * Vec3::new(0.0, 0.3, 1.0).normalize();
        assert!(direction.distance(original) < 0.000001);
    }

    #[test]
    fn positional_response_is_frame_rate_independent_including_hitches_and_off() {
        let run = |steps: Vec<f32>| {
            let mut filter = PositionFilter(Some(Vec3::ZERO));
            for dt in steps {
                filter.0 = Some(filter.candidate(Vec3::splat(10.0), dt, 0.25, false));
            }
            filter.0.unwrap()
        };
        let expected = Vec3::splat(10.0 * (1.0 - (-4.0_f32).exp()));
        for fps in [30, 60, 144] {
            assert!(run(vec![1.0 / fps as f32; fps]).distance(expected) < 0.0001);
        }
        assert!(run(vec![0.001, 0.199, 0.3, 0.5]).distance(expected) < 0.0001);
        let mut filter = PositionFilter(Some(Vec3::splat(-1000.0)));
        assert_eq!(filter.candidate(Vec3::ONE, 0.01, 0.0, false), Vec3::ONE);
        assert_eq!(filter.candidate(Vec3::ONE, 0.01, 1000.0, true), Vec3::ONE);
        filter.clear();
        assert_eq!(filter.candidate(Vec3::ONE, 0.01, 1000.0, false), Vec3::ONE);
        filter.0 = Some(Vec3::ZERO);
        assert!(filter
            .candidate(Vec3::ONE, 0.01, f32::MAX, false)
            .is_finite());
    }

    #[test]
    fn positional_filter_attenuates_injected_alternating_target_jitter() {
        let mut filter = PositionFilter(Some(Vec3::ZERO));
        let mut filtered_energy = 0.0;
        for frame in 0..600 {
            let wanted = Vec3::Y * if frame % 2 == 0 { 0.1 } else { -0.1 };
            let candidate = filter.candidate(wanted, 1.0 / 60.0, 0.15, false);
            filtered_energy += candidate.length_squared();
            filter.0 = Some(candidate);
        }
        let rms = (filtered_energy / 600.0_f32).sqrt();
        assert!(rms < 0.007);
        println!("injected position jitter RMS: input=0.100000 yd, filtered={rms:.6} yd");
    }

    #[test]
    fn collision_clips_old_seat_after_filtering_and_reset_snaps_heading_and_position() {
        super::super::collision::tests::fixture()
            .world_mut()
            .run_system_once(|world: benilla_world::collision::WorldCollision| {
                let mut transform = Transform::default();
                let mut cam = super::super::super::camera::FlyCam {
                    yaw: 0.0,
                    pitch: 0.0,
                    speed: 0.0,
                };
                let mut rig = super::super::super::camera::CameraControl::default();
                // The fixture's wall is x=10; old seat is on its far side.
                let mut filter = PositionFilter(Some(Vec3::new(20.0, 7.0, 0.0)));
                chase(
                    Vec3::Y * 1.1,
                    0.0,
                    16.0,
                    1.0 / 60.0,
                    false,
                    Vec2::X,
                    Default::default(),
                    1000.0,
                    &mut filter,
                    &mut transform,
                    &mut cam,
                    &mut rig,
                    &world,
                );
                assert!(
                    transform.translation.x < 10.0,
                    "{:?}",
                    transform.translation
                );
                assert_eq!(filter.0, Some(transform.translation));
                let target = Vec3::new(-200.0, 1.1, 0.0);
                chase(
                    target,
                    1.0,
                    16.0,
                    1.0 / 60.0,
                    true,
                    Vec2::ZERO,
                    Default::default(),
                    1000.0,
                    &mut filter,
                    &mut transform,
                    &mut cam,
                    &mut rig,
                    &world,
                );
                assert!(transform.translation.distance(target) < 21.0);
                assert_eq!(cam.yaw, 1.0);
                rig.park_distance(12.0);
                rig.target_distance = 14.0;
                chase(
                    target,
                    1.0,
                    0.0,
                    1.0 / 60.0,
                    true,
                    Vec2::ZERO,
                    Default::default(),
                    0.0,
                    &mut filter,
                    &mut transform,
                    &mut cam,
                    &mut rig,
                    &world,
                );
                assert!(transform.rotation.is_finite());
                assert_eq!(transform.translation, target + Vec3::Y * 3.0);
                assert_eq!(
                    rig.target_distance, 14.0,
                    "seating must not overwrite the zoom target"
                );
            })
            .unwrap();
    }
}
