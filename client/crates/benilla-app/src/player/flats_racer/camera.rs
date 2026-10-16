//! Deviation: session-only positional low-pass for the custom racer camera.

use super::*;

pub(super) const DEFAULT_POSITION_SECONDS: f32 = 0.15;

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
    speed: f32,
    dt: f32,
    reset: bool,
    seconds: f32,
    filter: &mut PositionFilter,
    camera: &mut Transform,
    cam: &mut super::super::camera::FlyCam,
    rig: &mut super::super::camera::CameraControl,
    world: &benilla_world::collision::WorldCollision,
) {
    let blend = 1.0 - (-7.0 * dt.clamp(0.0, 0.1)).exp();
    if reset {
        cam.yaw = yaw;
    } else {
        cam.yaw += crate::creature_anim::wrap_pi(yaw - cam.yaw) * blend;
    }
    cam.pitch = -0.22;
    let pivot = position + Vec3::Y * 3.0;
    let direction = Quat::from_rotation_y(cam.yaw) * Vec3::new(0.0, 0.3, 1.0).normalize();
    let distance = 16.0 + (speed / 80.0).clamp(0.0, 1.0) * 4.0;
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
    camera.look_at(pivot, Vec3::Y);
    rig.park_distance(distance);
    rig.collision_distance = clear;
    rig.self_fade_alpha = 1.0;
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ecs::system::RunSystemOnce;

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
                    0.0,
                    1.0 / 60.0,
                    false,
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
                    0.0,
                    1.0 / 60.0,
                    true,
                    1000.0,
                    &mut filter,
                    &mut transform,
                    &mut cam,
                    &mut rig,
                    &world,
                );
                assert!(transform.translation.distance(target) < 21.0);
                assert_eq!(cam.yaw, 1.0);
            })
            .unwrap();
    }
}
