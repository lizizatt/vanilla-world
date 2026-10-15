//! Deviation: server-less integration instrument; real rider/mount, terrain, resolver and camera.
use super::*;
use benilla_world::{collision::WorldCollision, rig_anim::RigPose, view::WorldCamera};
use std::sync::atomic::{AtomicBool, Ordering};

static READY: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);
pub(crate) fn probe_ready() -> bool {
    READY.load(Ordering::Relaxed)
}
pub(crate) fn probe_done() -> bool {
    DONE.load(Ordering::Relaxed)
}

#[derive(Component)]
pub(super) struct ProbeRider;

#[derive(Component)]
pub(super) struct ProbeBank(pub f32);

#[derive(Default)]
pub(super) struct Probe {
    root: Option<Entity>,
    dynamics: Option<flats_racer_physics::State>,
    accumulator: f64,
    elapsed: f32,
    frames: u32,
    max_speed: f32,
    max_height: f32,
    min_height: Option<f32>,
    airborne: bool,
    landed: bool,
    reset: bool,
    holds: u32,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn drive(
    mut commands: Commands,
    time: Res<Time>,
    world: WorldCollision,
    progress: Res<benilla_world::terrain_stream::WorldLoadProgress>,
    mut player: ResMut<Player>,
    mut probe: Local<Probe>,
    mut roots: Query<&mut Transform, (With<ProbeRider>, Without<WorldCamera>)>,
    poses: Query<&RigPose>,
    parents: Query<&ChildOf>,
    mounts: Query<(Entity, &crate::entities::mount::MountBody)>,
    mut camera: Query<
        (&mut Transform, &mut super::super::camera::FlyCam),
        (With<WorldCamera>, Without<ProbeRider>),
    >,
    mut rig: ResMut<super::super::camera::CameraControl>,
) {
    let origin = benilla_assets::coords::wow_to_bevy([-6235.0, -3945.0, -57.65]);
    let root =
        *probe.root.get_or_insert_with(|| {
            commands
                .spawn((
                    ProbeRider,
                    crate::net::Guid((0xF130u64 << 48) | 0xF1A75),
                    crate::net::NetEntity {
                        kind: benilla_protocol::EntityKind::Unit,
                        display_id: Some(49),
                        scale: 1.0,
                    },
                    crate::net::ObjectStore(benilla_protocol::messages::ObjectFields::from_pairs(
                        &[(22, 100), (28, 100), (34, 60), (35, 35), (133, DISPLAY_ID)],
                    )),
                    Transform::from_translation(origin),
                    Visibility::default(),
                ))
                .id()
        });
    let Ok((mut camera, mut cam)) = camera.single_mut() else {
        return;
    };
    let Some(mount) = mounts.iter().find(|(_, m)| m.host == root).map(|(e, _)| e) else {
        camera.translation = origin + Vec3::new(0.0, 7.0, 18.0);
        camera.look_at(origin + Vec3::Y * 3.0, Vec3::Y);
        return;
    };
    let seated = poses.get(root).is_ok_and(|pose| {
        let mut ancestor = pose.joints_root;
        for _ in 0..64 {
            if ancestor == mount {
                return true;
            }
            let Ok(parent) = parents.get(ancestor) else {
                return false;
            };
            ancestor = parent.parent();
        }
        false
    });
    let rendered = seated && poses.get(mount).is_ok();
    let supports = collision::supports(&world, origin, 0.0);
    if !READY.load(Ordering::Relaxed) {
        if !rendered || !stream_ready(origin, &progress) || supports.iter().any(Option::is_none) {
            return;
        }
        info!(
            "FLATS_RACER_PREFLIGHT rider={root:?} mount={mount:?} support={supports:?} camera={:?}",
            camera.translation
        );
        probe.dynamics =
            Some(flats_racer_physics::State::new(origin.to_array(), 0.0).expect("finite fixture"));
        READY.store(true, Ordering::Relaxed);
    }
    let t = probe.elapsed;
    if t >= 6.0 && !probe.reset {
        probe
            .dynamics
            .as_mut()
            .expect("preflight initialized")
            .reset(origin.to_array(), 0.0)
            .expect("finite reset fixture");
        probe.accumulator = 0.0;
        probe.reset = true;
    }
    let input = flats_racer_physics::Input {
        throttle: if (1.0..3.5).contains(&t) { 1.0 } else { 0.0 },
        steer: if (2.5..3.5).contains(&t) { 0.7 } else { 0.0 },
        boost: (2.0..2.5).contains(&t),
        drift: (2.5..3.5).contains(&t),
        brake: (3.5..4.5).contains(&t) || t >= 6.0,
        jump: (4.5..4.6).contains(&t),
    };
    // The offline fixture owns its state, never the server-authorized live control resource.
    let probe = &mut *probe;
    let state = probe.dynamics.as_mut().expect("preflight initialized");
    match advance(
        state,
        &mut probe.accumulator,
        input,
        time.delta_secs(),
        &world,
        &progress,
    ) {
        Ok(held) => probe.holds += u32::from(held && time.delta_secs() > 0.0),
        Err(error) => panic!("flats racer integrated probe: {error:?}"),
    }
    if let Ok(mut transform) = roots.get_mut(root) {
        transform.translation = Vec3::from_array(state.position);
        transform.rotation = Quat::from_rotation_y(state.yaw);
    }
    commands.entity(root).insert(ProbeBank(state.bank));
    player.pos = Vec3::from_array(state.position);
    player.active = true;
    player.detached = false;
    let speed = Vec3::from_array(state.velocity).with_y(0.0).length();
    chase_camera(
        player.pos,
        state.yaw,
        speed,
        time.delta_secs(),
        probe.frames == 0,
        &mut camera,
        &mut cam,
        &mut rig,
        &world,
    );
    assert!(camera.translation.is_finite() && camera.rotation.is_finite());
    if time.delta_secs() <= 0.0 || DONE.load(Ordering::Relaxed) {
        return;
    }
    probe.frames += 1;
    probe.elapsed += time.delta_secs();
    probe.max_speed = probe.max_speed.max(speed);
    let height = state.position[1] + 58.75;
    probe.max_height = probe.max_height.max(height);
    probe.min_height = Some(probe.min_height.map_or(height, |old| old.min(height)));
    if !state.grounded && t > 4.5 {
        probe.airborne = true;
    }
    if probe.airborne && state.grounded && t < 6.0 {
        probe.landed = true;
    }
    if probe.elapsed >= 8.0 {
        let body = roots.get(root).expect("fixture root remains");
        let report = format!(
            "{{\"frames\":{},\"seconds\":{},\"max_speed\":{},\"min_height\":{},\"max_height\":{},\"airborne\":{},\"landed\":{},\"reset\":{},\"stream_holds\":{},\"body\":[{},{},{}],\"camera\":[{},{},{}],\"rider_seated\":{},\"mount_rig\":{}}}",
            probe.frames,
            probe.elapsed,
            probe.max_speed,
            probe.min_height.unwrap(),
            probe.max_height,
            probe.airborne,
            probe.landed,
            probe.reset,
            probe.holds,
            body.translation.x,
            body.translation.y,
            body.translation.z,
            camera.translation.x,
            camera.translation.y,
            camera.translation.z,
            seated,
            poses.get(mount).is_ok(),
        );
        info!("FLATS_RACER_PROBE {report}");
        if let Ok(path) = std::env::var("WOW_RACER_PROBE_OUT") {
            std::fs::write(&path, &report)
                .unwrap_or_else(|error| panic!("write probe {path}: {error}"));
        }
        assert!(
            probe.max_speed > 15.0
                && probe.min_height.unwrap() > 0.5
                && probe.max_height < 4.0
                && probe.airborne
                && probe.landed
                && probe.reset
                && probe.holds == 0
                && seated
                && body.translation.distance(origin) < 0.1
        );
        DONE.store(true, Ordering::Relaxed);
    }
}
