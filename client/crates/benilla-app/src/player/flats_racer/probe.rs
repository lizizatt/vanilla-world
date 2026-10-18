//! Deviation: server-less integration instrument; real rider/mount, terrain, resolver and camera.
use super::*;
use benilla_world::{collision::WorldCollision, rig_anim::RigPose, view::WorldCamera};
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

static READY: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);
const STREAM_RUN_SECONDS: f32 = 5.0;
const STREAM_RUN_WALL_LIMIT_SECONDS: f64 = 30.0;
const STREAM_PROBE_WALL_LIMIT_SECONDS: f64 = 135.0;

#[derive(Clone, Copy)]
struct StreamRunSpec {
    speed: f32,
    airborne: bool,
    northbound: bool,
}

const STREAM_RUNS: [StreamRunSpec; 4] = [
    StreamRunSpec {
        speed: 250.0,
        airborne: false,
        northbound: true,
    },
    StreamRunSpec {
        speed: 500.0,
        airborne: false,
        northbound: false,
    },
    StreamRunSpec {
        speed: 250.0,
        airborne: true,
        northbound: true,
    },
    StreamRunSpec {
        speed: 500.0,
        airborne: true,
        northbound: false,
    },
];

#[derive(Default)]
struct StreamRun {
    spec: Option<StreamRunSpec>,
    tuning: flats_racer_physics::Tuning,
    started_at: Option<Instant>,
    wall_ms: f64,
    held_since: Option<Instant>,
    seconds: f32,
    frames: u64,
    hold_frames: u32,
    hold_events: u32,
    hold_after_advance_frames: u32,
    held_wall_ms: f64,
    max_hold_ms: f64,
    max_velocity_delta: f32,
    hold_velocity_pairs: Vec<([f32; 3], [f32; 3])>,
    max_advance_ms: f64,
    max_frame_ms: f64,
    max_frame_delta_ms: f64,
    frame_time_not_replayed_ms: f64,
    max_resident_tiles: usize,
    max_requested_tiles: usize,
    max_collision_tiles: usize,
    support_samples: u64,
    support_hits: u64,
    grounded_samples: u64,
    ground_below_hits: u32,
    missing_body_tile_frames: u32,
    tile_changes: u32,
    last_tile: Option<(i32, i32)>,
    tiles_seen: HashSet<(i32, i32)>,
    reset_verified: bool,
    start_position: [f32; 3],
    start_velocity: [f32; 3],
    start_tile: (i32, i32),
    start_tile_ready: bool,
    camera_start: [f32; 3],
    end_position: [f32; 3],
    end_velocity: [f32; 3],
    camera_position: [f32; 3],
    final_tile: (i32, i32),
    final_tile_ready: bool,
}

#[derive(Default)]
pub(super) struct StreamProbe {
    started_at: Option<Instant>,
    last_frame_at: Option<Instant>,
    startup_latency_ms: Option<f64>,
    run_index: usize,
    run: StreamRun,
    completed: Vec<StreamRun>,
    frames: u64,
    last_preflight_report: u64,
    horizon_tiles_max: usize,
    horizon_mesh_bytes_max: usize,
}

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
    camera_position: camera::PositionFilter,
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
    mut racer: ResMut<FlatsRacer>,
    mut prefetch: ResMut<benilla_world::terrain_stream::RacerPrefetch>,
    streaming: (
        Res<benilla_world::terrain_stream::TerrainStreamer>,
        Option<Res<benilla_world::wdl::RacerWdl>>,
        Res<benilla_world::wdl::WdlTelemetry>,
    ),
    mut stream_probe: Local<StreamProbe>,
) {
    let (terrain, horizon, horizon_stats) = streaming;
    let stream_mode = std::env::var("WOW_RACER_STREAM_PROBE").as_deref() == Ok("1");
    prefetch.active = !DONE.load(Ordering::Relaxed);
    prefetch.wow_velocity = probe
        .dynamics
        .as_ref()
        .map_or([0.0; 2], |state| [-state.velocity[2], -state.velocity[0]]);
    let now = Instant::now();
    let frame_dt = stream_probe
        .last_frame_at
        .replace(now)
        .map_or(0.0, |previous| now.duration_since(previous).as_secs_f32());
    if stream_mode {
        stream_probe.horizon_tiles_max = stream_probe
            .horizon_tiles_max
            .max(horizon_stats.resident_tiles);
        stream_probe.horizon_mesh_bytes_max = stream_probe
            .horizon_mesh_bytes_max
            .max(horizon_stats.resident_mesh_bytes);
        if horizon.is_none() {
            commands.insert_resource(benilla_world::wdl::RacerWdl);
        }
        let started_at = *stream_probe.started_at.get_or_insert_with(Instant::now);
        if !READY.load(Ordering::Relaxed)
            && started_at.elapsed().as_secs_f64() >= STREAM_PROBE_WALL_LIMIT_SECONDS
        {
            let report = format!(
                "{{\"schema\":\"flats-racer-stream-probe-v1\",\"status\":\"preflight-timeout\",\"wall_ms\":{:.3},\"completed_runs\":0,\"runs\":[]}}",
                started_at.elapsed().as_secs_f64() * 1000.0
            );
            info!("FLATS_RACER_STREAM_PROBE {report}");
            if let Ok(path) = std::env::var("WOW_RACER_PROBE_OUT") {
                std::fs::write(&path, &report)
                    .unwrap_or_else(|error| panic!("write stream probe {path}: {error}"));
            }
            DONE.store(true, Ordering::Relaxed);
            panic!("flats racer streaming probe preflight exceeded its finite deadline");
        }
    }
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
        if stream_mode {
            let seconds = stream_probe.started_at.unwrap().elapsed().as_secs();
            if seconds >= stream_probe.last_preflight_report + 10 {
                stream_probe.last_preflight_report = seconds;
                warn!("RACER_PREFLIGHT waiting for mount body on rider {root:?}");
            }
        }
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
    let supports = collision::supports(
        &world,
        origin,
        0.0,
        flats_racer_physics::Tuning::default().support_reach(),
    );
    if !READY.load(Ordering::Relaxed) {
        if !rendered || !stream_ready(origin, &progress) || supports.iter().any(Option::is_none) {
            if stream_mode {
                let seconds = stream_probe.started_at.unwrap().elapsed().as_secs();
                if seconds >= stream_probe.last_preflight_report + 10 {
                    stream_probe.last_preflight_report = seconds;
                    warn!(
                        "RACER_PREFLIGHT waiting rendered={rendered} seated={seated} support={supports:?} stream_ready={} collision_tiles={} ready={}/{} colliders_pending={} placements_pending={}",
                        stream_ready(origin, &progress),
                        progress.collision_tiles.len(),
                        progress.ready,
                        progress.total,
                        progress.colliders_pending,
                        progress.placements_pending,
                    );
                }
            }
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
    if stream_mode {
        if DONE.load(Ordering::Relaxed) {
            return;
        }
        drive_stream_probe(
            &mut stream_probe,
            &mut probe,
            root,
            origin,
            frame_dt,
            &world,
            &progress,
            &terrain,
            &mut prefetch,
            &mut player,
            &mut commands,
            &mut roots,
            &mut camera,
            &mut cam,
            &mut rig,
            &mut racer,
        );
        return;
    }
    let t = probe.elapsed;
    if t >= 7.0 && std::env::var("WOW_RACER_TUNING_CAPTURE").as_deref() == Ok("1") {
        racer.tuning_open = true;
    }
    let resetting = t >= 6.0 && !probe.reset;
    if resetting {
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
    prefetch.wow_velocity = [-state.velocity[2], -state.velocity[0]];
    if let Ok(mut transform) = roots.get_mut(root) {
        transform.translation = Vec3::from_array(state.position);
        transform.rotation = Quat::from_rotation_y(state.yaw);
    }
    commands.entity(root).insert(ProbeBank(state.bank));
    player.pos = Vec3::from_array(state.position);
    player.active = true;
    player.detached = false;
    let speed = Vec3::from_array(state.velocity).with_y(0.0).length();
    camera::chase(
        player.pos,
        state.yaw,
        16.0 + (speed / 80.0).clamp(0.0, 1.0) * 4.0,
        time.delta_secs(),
        probe.frames == 0 || resetting,
        Vec2::ZERO,
        Default::default(),
        racer.camera_position_seconds,
        &mut probe.camera_position,
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
        prefetch.active = false;
    }
}

#[allow(clippy::too_many_arguments)]
fn drive_stream_probe(
    stream: &mut StreamProbe,
    probe: &mut Probe,
    root: Entity,
    origin: Vec3,
    dt: f32,
    world: &WorldCollision,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
    terrain: &benilla_world::terrain_stream::TerrainStreamer,
    prefetch: &mut benilla_world::terrain_stream::RacerPrefetch,
    player: &mut Player,
    commands: &mut Commands,
    roots: &mut Query<&mut Transform, (With<ProbeRider>, Without<WorldCamera>)>,
    camera_transform: &mut Transform,
    cam: &mut super::super::camera::FlyCam,
    rig: &mut super::super::camera::CameraControl,
    racer: &mut FlatsRacer,
) {
    if stream.run.spec.is_none() {
        if stream.run_index == STREAM_RUNS.len() {
            prefetch.active = false;
            finish_stream_probe(stream);
            return;
        }
        if stream
            .started_at
            .is_some_and(|at| at.elapsed().as_secs_f64() >= STREAM_PROBE_WALL_LIMIT_SECONDS)
        {
            finish_stream_probe(stream);
            return;
        }
        // Segment resets are teleports: reacquire the origin before imposing velocity.
        player.pos = origin;
        player.active = true;
        player.detached = false;
        prefetch.active = true;
        prefetch.wow_velocity = [0.0; 2];
        if let Ok(mut transform) = roots.get_mut(root) {
            transform.translation = origin;
        }
        camera_transform.translation = origin + Vec3::new(0.0, 7.0, 18.0);
        camera_transform.look_at(origin + Vec3::Y * 3.0, Vec3::Y);
        if !stream_ready(origin, progress)
            || collision::supports(world, origin, 0.0, racer.tuning.support_reach())
                .iter()
                .any(Option::is_none)
        {
            return;
        }
        if stream.startup_latency_ms.is_none() {
            stream.startup_latency_ms = stream
                .started_at
                .map(|at| at.elapsed().as_secs_f64() * 1000.0);
        }
        begin_stream_run(
            stream,
            probe,
            origin,
            &world,
            progress,
            racer.tuning,
            STREAM_RUNS[stream.run_index],
        );
    }

    let frame_started = Instant::now();
    let state = probe.dynamics.as_mut().expect("preflight initialized");
    let spec = stream.run.spec.expect("active stream run");
    let tuning = stream.run.tuning;
    prefetch.active = true;
    prefetch.wow_velocity = [-state.velocity[2], -state.velocity[0]];
    let velocity_before = state.velocity;
    let position_before = state.position;
    let step_dt = dt.clamp(0.0, 0.1);
    if stream.run.seconds == 0.0 {
        stream.run.camera_start = camera_transform.translation.to_array();
    }
    let advance_started = Instant::now();
    let held = advance_tuned(
        state,
        &mut probe.accumulator,
        flats_racer_physics::Input::default(),
        step_dt,
        world,
        progress,
        &tuning,
        &|_| None,
    )
    .unwrap_or_else(|error| panic!("flats racer streaming probe: {error:?}"));
    let advance_ms = advance_started.elapsed().as_secs_f64() * 1000.0;
    stream.run.max_advance_ms = stream.run.max_advance_ms.max(advance_ms);
    if held {
        // A frame may advance safe substeps before its first blocked substep.
        if state.position == position_before {
            let delta =
                Vec3::from_array(state.velocity).distance(Vec3::from_array(velocity_before));
            stream.run.max_velocity_delta = stream.run.max_velocity_delta.max(delta);
            if stream.run.hold_velocity_pairs.len() < 16 {
                stream
                    .run
                    .hold_velocity_pairs
                    .push((velocity_before, state.velocity));
            }
        } else {
            stream.run.hold_after_advance_frames += 1;
        }
        stream.run.hold_frames += 1;
        if stream.run.held_since.is_none() {
            stream.run.hold_events += 1;
            stream.run.held_since = Some(Instant::now());
        }
    } else if let Some(held_since) = stream.run.held_since.take() {
        let held_ms = held_since.elapsed().as_secs_f64() * 1000.0;
        stream.run.held_wall_ms += held_ms;
        stream.run.max_hold_ms = stream.run.max_hold_ms.max(held_ms);
    }

    let position = Vec3::from_array(state.position);
    let tile = stream_tile(position);
    if !progress.collision_tiles.contains(&tile) {
        stream.run.missing_body_tile_frames += 1;
        assert!(
            held && state.position == position_before && state.velocity == velocity_before,
            "missing body collision proof must hold position and preserve velocity"
        );
    }
    if stream.run.last_tile.is_some_and(|last| last != tile) {
        stream.run.tile_changes += 1;
    }
    stream.run.last_tile = Some(tile);
    stream.run.tiles_seen.insert(tile);
    let supports = collision::supports(world, position, state.yaw, tuning.support_reach());
    stream.run.support_hits += supports.iter().filter(|hit| hit.is_some()).count() as u64;
    if supports.iter().any(Option::is_some) {
        stream.run.support_samples += 1;
    }
    if state.grounded {
        stream.run.grounded_samples += 1;
    }
    stream.run.final_tile = tile;
    stream.run.final_tile_ready = progress.collision_tiles.contains(&tile);
    let (resident_tiles, requested_tiles) = terrain.residency();
    stream.run.max_resident_tiles = stream.run.max_resident_tiles.max(resident_tiles);
    stream.run.max_requested_tiles = stream.run.max_requested_tiles.max(requested_tiles);
    stream.run.max_collision_tiles = stream
        .run
        .max_collision_tiles
        .max(progress.collision_tiles.len());

    if let Ok(mut transform) = roots.get_mut(root) {
        transform.translation = position;
        transform.rotation = Quat::from_rotation_y(state.yaw);
    }
    commands.entity(root).insert(ProbeBank(state.bank));
    player.pos = position;
    player.active = true;
    player.detached = false;
    prefetch.active = true;
    prefetch.wow_velocity = [-state.velocity[2], -state.velocity[0]];
    let speed = Vec3::from_array(state.velocity).with_y(0.0).length();
    camera::chase(
        player.pos,
        state.yaw,
        16.0 + (speed / 80.0).clamp(0.0, 1.0) * 4.0,
        dt,
        stream.run.seconds == 0.0,
        Vec2::ZERO,
        Default::default(),
        racer.camera_position_seconds,
        &mut probe.camera_position,
        camera_transform,
        cam,
        rig,
        world,
    );
    assert!(
        camera_transform.translation.is_finite() && camera_transform.rotation.is_finite(),
        "stream probe camera became non-finite"
    );
    stream.run.max_frame_ms = stream
        .run
        .max_frame_ms
        .max(frame_started.elapsed().as_secs_f64() * 1000.0);
    stream.run.max_frame_delta_ms = stream
        .run
        .max_frame_delta_ms
        .max(f64::from(dt.max(0.0)) * 1000.0);
    stream.run.frame_time_not_replayed_ms += f64::from((dt - step_dt).max(0.0)) * 1000.0;
    stream.run.seconds += step_dt;
    stream.run.end_position = state.position;
    stream.run.end_velocity = state.velocity;
    stream.run.camera_position = camera_transform.translation.to_array();
    stream.run.frames += 1;
    stream.frames += 1;

    let run_wall_seconds = stream
        .run
        .started_at
        .map_or(0.0, |at| at.elapsed().as_secs_f64());
    let total_wall_seconds = stream
        .started_at
        .map_or(0.0, |at| at.elapsed().as_secs_f64());
    if stream.run.seconds >= STREAM_RUN_SECONDS
        || run_wall_seconds >= STREAM_RUN_WALL_LIMIT_SECONDS
        || total_wall_seconds >= STREAM_PROBE_WALL_LIMIT_SECONDS
    {
        if let Some(held_since) = stream.run.held_since.take() {
            let held_ms = held_since.elapsed().as_secs_f64() * 1000.0;
            stream.run.held_wall_ms += held_ms;
            stream.run.max_hold_ms = stream.run.max_hold_ms.max(held_ms);
        }
        stream.run.wall_ms = run_wall_seconds * 1000.0;
        info!(
            "FLATS_RACER_STREAM_RUN speed={} airborne={} tiles={} holds={} support_hits={}",
            spec.speed,
            spec.airborne,
            stream.run.tile_changes,
            stream.run.hold_events,
            stream.run.support_hits
        );
        stream.completed.push(std::mem::take(&mut stream.run));
        stream.run_index += 1;
        if total_wall_seconds >= STREAM_PROBE_WALL_LIMIT_SECONDS
            || stream.run_index == STREAM_RUNS.len()
        {
            prefetch.active = false;
            finish_stream_probe(stream);
            // Survey the terrain for the final artifact; traversal camera metrics remain above.
            camera_transform.translation = position + Vec3::new(0.0, 100.0, 100.0);
            camera_transform.look_at(position + Vec3::new(0.0, -450.0, -1000.0), Vec3::Y);
        }
    }
}

fn begin_stream_run(
    stream: &mut StreamProbe,
    probe: &mut Probe,
    origin: Vec3,
    world: &WorldCollision,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
    mut tuning: flats_racer_physics::Tuning,
    spec: StreamRunSpec,
) {
    let yaw = if spec.northbound {
        0.0
    } else {
        std::f32::consts::PI
    };
    let state = probe.dynamics.as_mut().expect("preflight initialized");
    state
        .reset(origin.to_array(), yaw)
        .expect("finite stream-probe reset");
    probe.accumulator = 0.0;
    let mut ground_below_hits = 0;
    if spec.airborne {
        state.position[1] += 80.0;
        state.velocity[1] = 120.0;
        ground_below_hits = collision::supports(world, Vec3::from_array(state.position), yaw, 128.0)
            .iter()
            .filter(|hit| hit.is_some())
            .count() as u32;
    }
    state.velocity[2] = if spec.northbound {
        -spec.speed
    } else {
        spec.speed
    };
    tuning.max_speed = spec.speed;
    tuning.boost_max_speed = spec.speed;
    tuning.acceleration = 0.0;
    tuning.boost_acceleration = 0.0;
    tuning.braking = 0.0;
    tuning.drag = 0.0;
    tuning.turn_rate = 0.0;
    tuning.turn_response = 0.0;
    tuning.grip = 0.0;
    tuning.drift_grip = 0.0;
    tuning.air_control = 0.0;
    tuning
        .validate()
        .expect("valid high-speed streaming probe tuning");
    stream.run = StreamRun {
        spec: Some(spec),
        tuning,
        started_at: Some(Instant::now()),
        start_position: state.position,
        start_velocity: state.velocity,
        start_tile: stream_tile(Vec3::from_array(state.position)),
        end_position: state.position,
        end_velocity: state.velocity,
        final_tile: stream_tile(Vec3::from_array(state.position)),
        start_tile_ready: progress
            .collision_tiles
            .contains(&stream_tile(Vec3::from_array(state.position))),
        final_tile_ready: false,
        ground_below_hits,
        reset_verified: (0..3).all(|i| {
            (state.position[i] - (origin[i] + if spec.airborne && i == 1 { 80.0 } else { 0.0 }))
                .abs()
                < 1.0e-4
        }),
        ..Default::default()
    };
    let tile = stream_tile(Vec3::from_array(state.position));
    stream.run.last_tile = Some(tile);
    stream.run.tiles_seen.insert(tile);
}

fn stream_tile(position: Vec3) -> (i32, i32) {
    let wow = benilla_assets::coords::bevy_to_wow(position);
    let tile = benilla_formats::world_to_tile(wow[0], wow[1]);
    (tile.0 as i32, tile.1 as i32)
}

fn finish_stream_probe(stream: &mut StreamProbe) {
    let runs = stream
        .completed
        .iter()
        .map(|run| {
            let spec = run.spec.expect("completed stream run has a specification");
            let run_wall_ms = run.wall_ms;
            let mut tiles_seen: Vec<_> = run.tiles_seen.iter().copied().collect();
            tiles_seen.sort_unstable();
            let tiles_seen = tiles_seen
                .iter()
                .map(|(x, y)| format!("[{x},{y}]"))
                .collect::<Vec<_>>()
                .join(",");
            let hold_velocity_pairs = run
                .hold_velocity_pairs
                .iter()
                .map(|(before, after)| {
                    format!(
                        "{{\"before\":[{:.3},{:.3},{:.3}],\"after\":[{:.3},{:.3},{:.3}]}}",
                        before[0], before[1], before[2], after[0], after[1], after[2]
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{{\"speed_yd_s\":{:.1},\"airborne\":{},\"northbound\":{},\"attempted_sim_seconds\":{:.3},\"run_wall_ms\":{:.3},\"frames\":{},\"tile_changes\":{},\"terrain_tiles\":[{}],\"hold_events\":{},\"hold_frames\":{},\"hold_after_advance_frames\":{},\"hold_velocity_pairs\":[{}],\"held_wall_ms\":{:.3},\"max_hold_ms\":{:.3},\"max_velocity_delta_on_hold\":{:.6},\"max_advance_ms\":{:.3},\"max_frame_ms\":{:.3},\"max_frame_delta_ms\":{:.3},\"frame_time_not_replayed_ms\":{:.3},\"resident_tiles_max\":{},\"requested_tiles_max\":{},\"collision_tiles_max\":{},\"support_samples\":{},\"support_hits\":{},\"grounded_samples\":{},\"ground_below_hits\":{},\"missing_body_tile_frames\":{},\"reset_verified\":{},\"start_tile\":[{},{}],\"start_tile_ready\":{},\"final_tile\":[{},{}],\"final_tile_ready\":{},\"body_start\":[{:.3},{:.3},{:.3}],\"body_end\":[{:.3},{:.3},{:.3}],\"velocity_start\":[{:.3},{:.3},{:.3}],\"velocity_end\":[{:.3},{:.3},{:.3}],\"camera_start\":[{:.3},{:.3},{:.3}],\"camera_end\":[{:.3},{:.3},{:.3}]}}",
                spec.speed,
                spec.airborne,
                spec.northbound,
                run.seconds,
                run_wall_ms,
                run.frames,
                run.tile_changes,
                tiles_seen,
                run.hold_events,
                run.hold_frames,
                run.hold_after_advance_frames,
                hold_velocity_pairs,
                run.held_wall_ms,
                run.max_hold_ms,
                run.max_velocity_delta,
                run.max_advance_ms,
                run.max_frame_ms,
                run.max_frame_delta_ms,
                run.frame_time_not_replayed_ms,
                run.max_resident_tiles,
                run.max_requested_tiles,
                run.max_collision_tiles,
                run.support_samples,
                run.support_hits,
                run.grounded_samples,
                run.ground_below_hits,
                run.missing_body_tile_frames,
                run.reset_verified,
                run.start_tile.0,
                run.start_tile.1,
                run.start_tile_ready,
                run.final_tile.0,
                run.final_tile.1,
                run.final_tile_ready,
                run.start_position[0],
                run.start_position[1],
                run.start_position[2],
                run.end_position[0],
                run.end_position[1],
                run.end_position[2],
                run.start_velocity[0],
                run.start_velocity[1],
                run.start_velocity[2],
                run.end_velocity[0],
                run.end_velocity[1],
                run.end_velocity[2],
                run.camera_start[0],
                run.camera_start[1],
                run.camera_start[2],
                run.camera_position[0],
                run.camera_position[1],
                run.camera_position[2],
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let total_wall_ms = stream
        .started_at
        .map_or(0.0, |at| at.elapsed().as_secs_f64() * 1000.0);
    let report = format!(
        "{{\"schema\":\"flats-racer-stream-probe-v1\",\"terrain_provenance\":{{\"source\":\"installed terrain via TerrainStreamer and WorldCollision\",\"probe_origin_wow\":[-6235.0,-3945.0,-57.65],\"terrain_tiles_coordinate_system\":\"WoW terrain tile indices\"}},\"horizon_tiles_max\":{},\"horizon_mesh_bytes_per_copy_max\":{},\"startup_latency_ms\":{:.3},\"wall_ms\":{:.3},\"frames\":{},\"completed_runs\":{},\"runs\":[{}]}}",
        stream.horizon_tiles_max,
        stream.horizon_mesh_bytes_max,
        stream.startup_latency_ms.unwrap_or_default(),
        total_wall_ms,
        stream.frames,
        stream.completed.len(),
        runs
    );
    info!("FLATS_RACER_STREAM_PROBE {report}");
    if let Ok(path) = std::env::var("WOW_RACER_PROBE_OUT") {
        std::fs::write(&path, &report)
            .unwrap_or_else(|error| panic!("write stream probe {path}: {error}"));
    }
    assert_eq!(
        stream.completed.len(),
        STREAM_RUNS.len(),
        "stream probe exceeded its finite deadline before all runs completed"
    );
    assert!(
        stream
            .completed
            .iter()
            .all(|run| { run.reset_verified && run.start_tile_ready }),
        "stream probe reset or initial collision-tile proof failed"
    );
    assert!(
        stream.completed.iter().all(|run| run.tile_changes > 0),
        "each stream segment must cross an actual terrain tile boundary"
    );
    assert!(
        stream.completed.iter().all(|run| {
            let spec = run.spec.expect("completed stream run has a specification");
            (run.start_velocity[2]
                - if spec.northbound {
                    -spec.speed
                } else {
                    spec.speed
                })
            .abs()
                <= 1.0e-3
                && run.start_velocity[0].abs() <= 1.0e-3
                && (run.start_velocity[1] - if spec.airborne { 120.0 } else { 0.0 }).abs() <= 1.0e-3
        }),
        "stream probe did not begin each run at its requested velocity"
    );
    assert!(
        stream
            .completed
            .iter()
            .all(|run| run.max_velocity_delta <= 1.0e-4),
        "a stream hold changed the racer velocity"
    );
    assert!(
        stream
            .completed
            .iter()
            .filter(|run| { run.spec.is_some_and(|spec| spec.airborne) })
            .all(|run| run.ground_below_hits > 0),
        "airborne segment preflight found no actual terrain below"
    );
    assert!(
        stream.completed.iter().all(|run| {
            run.spec.is_some_and(|spec| {
                spec.airborne || (run.support_hits > 0 && run.grounded_samples > 0)
            })
        }),
        "ground segment did not exercise actual terrain support"
    );
    DONE.store(true, Ordering::Relaxed);
}
