//! Deviation: opt-in local hover-racer controls, authorized explicitly by the custom server.
//! Stock walking, mount assets, and Avian's streamed collision geometry remain separate.
//! Deviation: outdoor exploration has no Flats leash; applied handling persists in local state.

use benilla_protocol::messages::ChatMessage;
use benilla_ui::script::UiScript;
use bevy::prelude::*;

use super::Player;

mod audio;
mod camera;
mod collision;
mod hud;
mod input;
mod probe;
mod tuning;
pub(crate) use probe::{probe_done, probe_ready};

pub(crate) const DISPLAY_ID: u32 = 10318;

pub(super) fn supports_map(map: u32) -> bool {
    matches!(map, 0 | 1)
}

pub(super) fn synthetic_input(
    keys: &ButtonInput<KeyCode>,
    hold: &benilla_world::modkeys::SyntheticHold,
) -> ButtonInput<KeyCode> {
    let mut filtered = ButtonInput::default();
    for &key in &hold.0 {
        if keys.pressed(key) {
            filtered.press(key);
            if !keys.just_pressed(key) {
                filtered.clear_just_pressed(key);
            }
        }
    }
    filtered
}

#[derive(Resource)]
pub(crate) struct FlatsRacer {
    pub(super) enabled: bool,
    pub(super) authorized: bool,
    pub(super) reset: bool,
    pub(super) status: &'static str,
    pub(super) speed: f32,
    pub(super) boost: f32,
    tuning: flats_racer_physics::Tuning,
    camera_position_seconds: f32,
    camera_position: camera::PositionFilter,
    pub(super) cockpit: bool,
    camera_toggle_requested: bool,
    tuning_open: bool,
    controls: input::Controls,
    audio: audio::Telemetry,
    dynamics: Option<flats_racer_physics::State>,
    accumulator: f64,
    waiting_since: Option<f32>,
    waiting_reset: Option<f32>,
    safe_start: Option<Vec3>,
    handoff: bool,
    last_report: f32,
}

fn request(net: &crate::net::NetCommands, action: &str) -> bool {
    if let Err(error) = net.0.send(crate::net::ClientCommand::Chat {
        kind: crate::net::ChatKind::Say,
        target: None,
        text: format!(".flatsracer {action}"),
        language: None,
    }) {
        error!("flats racer: command could not be sent: {error}");
        return false;
    }
    true
}

fn yield_control(racer: &mut FlatsRacer, player: &mut Player, net: &crate::net::NetCommands) {
    racer.revoke();
    player.horiz_vel = Vec3::ZERO;
    player.vel_y = 0.0;
    player.airborne_since = None;
    player.autorun = false;
    super::movement_net::park_mover(&net.0, player);
    racer.handoff = false;
}

fn stream_ready(
    position: Vec3,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
) -> bool {
    if !position.is_finite() {
        return false;
    }
    let wow = benilla_assets::coords::bevy_to_wow(position);
    let tile = benilla_formats::world_to_tile(wow[0], wow[1]);
    progress
        .collision_tiles
        .contains(&(tile.0 as i32, tile.1 as i32))
}

fn stream_corridor_ready(
    from: Vec3,
    to: Vec3,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
) -> bool {
    if !from.is_finite() || !to.is_finite() {
        return false;
    }
    // Conservatively prove every tile of the swept rectangle, not just its endpoints.
    // Sphere centers reach 3 yd plus radius 2.6 yd at arbitrary yaw.
    let low = benilla_assets::coords::bevy_to_wow(from.min(to) - Vec3::new(5.6, 0.0, 5.6));
    let high = benilla_assets::coords::bevy_to_wow(from.max(to) + Vec3::new(5.6, 0.0, 5.6));
    let map_half = 32.0 * benilla_formats::TILE_SIZE;
    if [low[0], low[1], high[0], high[1]]
        .into_iter()
        .any(|v| !v.is_finite() || v.abs() >= map_half)
    {
        return false;
    }
    let a = benilla_formats::world_to_tile(low[0], low[1]);
    let b = benilla_formats::world_to_tile(high[0], high[1]);
    (a.0.min(b.0)..=a.0.max(b.0)).all(|x| {
        (a.1.min(b.1)..=a.1.max(b.1))
            .all(|y| progress.collision_tiles.contains(&(x as i32, y as i32)))
    })
}

fn trace_hold(
    state: &flats_racer_physics::State,
    desired: Vec3,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
) {
    if benilla_assets::trace::enabled_for("racer") {
        benilla_assets::trace::line("racer", &format!(
            "stream-hold pos={:?} actual={:?} desired={desired:?} focus={:?} collision_tiles={} queues=collider:{},merge:{},placement:{}",
            state.position, state.velocity, progress.focus_tile, progress.collision_tiles.len(),
            progress.colliders_pending, progress.merge_pending, progress.placements_pending
        ));
    }
}

fn motion_flags(velocity: Vec3, yaw: f32, held: bool) -> u32 {
    use crate::creature_anim::move_flags::{BACKWARD, FORWARD};
    let horizontal = velocity.with_y(0.0);
    if held || horizontal.length() <= 0.1 {
        0
    } else if horizontal.dot(Quat::from_rotation_y(yaw) * Vec3::NEG_Z) < 0.0 {
        BACKWARD
    } else {
        FORWARD
    }
}

impl FlatsRacer {
    pub(super) fn stream_velocity(&self) -> Option<[f32; 2]> {
        self.dynamics
            .filter(|_| self.enabled && self.authorized)
            .map(|s| [-s.velocity[2], -s.velocity[0]])
    }
}

impl Default for FlatsRacer {
    fn default() -> Self {
        let enabled = std::env::var("WOW_FLATS_RACER").as_deref() == Ok("1");
        let mut tuning = Default::default();
        let mut camera_seconds = camera::DEFAULT_POSITION_SECONDS;
        let mut status = "F8 to request mount (local world exploration)";
        if enabled {
            match tuning::load() {
                Ok(Some((saved, seconds))) => {
                    tuning = saved;
                    camera_seconds = seconds;
                }
                Ok(None) => {}
                Err(error) => {
                    warn!("racer tuning: {error}; using defaults");
                    status = "Saved tuning unreadable - defaults loaded; see log";
                }
            }
        }
        Self {
            enabled,
            authorized: false,
            reset: false,
            status,
            speed: 0.0,
            boost: 1.0,
            tuning,
            camera_position_seconds: camera_seconds,
            camera_position: Default::default(),
            cockpit: false,
            camera_toggle_requested: false,
            tuning_open: false,
            controls: Default::default(),
            audio: Default::default(),
            dynamics: None,
            accumulator: 0.0,
            waiting_since: None,
            waiting_reset: None,
            safe_start: None,
            handoff: false,
            last_report: 0.0,
        }
    }
}

impl FlatsRacer {
    pub(super) fn camera_mode(&self) -> &'static str {
        if self.cockpit {
            "Cockpit"
        } else {
            "Chase"
        }
    }

    pub(super) fn request_camera_toggle(&mut self) {
        self.camera_toggle_requested = true;
    }

    pub(crate) fn server_chat(&mut self, message: &ChatMessage) {
        if !self.enabled || message.chat_type != 0x0a || message.sender_guid != 0 {
            return;
        }
        match message.text.as_str() {
            "FLATS_RACER ON" => {
                benilla_assets::trace::line("racer", "server-authority=ON");
                self.authorized = true;
                self.reset = true;
                self.waiting_since = None;
                self.status = "Mounting";
            }
            "FLATS_RACER OFF" => {
                benilla_assets::trace::line("racer", "server-authority=OFF");
                self.revoke();
            }
            "FLATS_RACER RESET" if self.authorized => {
                self.reset = true;
                self.status = "Resetting";
            }
            _ => {}
        }
    }

    pub(crate) fn revoke(&mut self) {
        self.audio = Default::default();
        self.camera_position.clear();
        self.cockpit = false;
        self.camera_toggle_requested = false;
        self.handoff |= self.dynamics.is_some();
        self.authorized = false;
        self.reset = true;
        self.speed = 0.0;
        self.dynamics = None;
        self.accumulator = 0.0;
        self.waiting_since = None;
        self.waiting_reset = None;
        self.safe_start = None;
        self.status = "Unmounted - F8 to request mount";
    }
}

fn advance(
    state: &mut flats_racer_physics::State,
    accumulator: &mut f64,
    input: flats_racer_physics::Input,
    dt: f32,
    world: &benilla_world::collision::WorldCollision,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
) -> Result<bool, flats_racer_physics::StepError> {
    advance_tuned(
        state,
        accumulator,
        input,
        dt,
        world,
        progress,
        &Default::default(),
        &|_| None,
    )
}

fn advance_tuned(
    state: &mut flats_racer_physics::State,
    accumulator: &mut f64,
    input: flats_racer_physics::Input,
    dt: f32,
    world: &benilla_world::collision::WorldCollision,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
    tuning: &flats_racer_physics::Tuning,
    water_surface: &impl Fn(Vec3) -> Option<f32>,
) -> Result<bool, flats_racer_physics::StepError> {
    if !dt.is_finite() || dt < 0.0 {
        return Err(flats_racer_physics::StepError::InvalidDt);
    }
    let position = Vec3::from_array(state.position);
    if !stream_ready(position, progress) || !stream_corridor_ready(position, position, progress) {
        trace_hold(state, Vec3::from_array(state.velocity), progress);
        *accumulator = 0.0;
        return Ok(true);
    }
    if dt > 0.1 && benilla_assets::trace::enabled_for("racer") {
        benilla_assets::trace::line(
            "racer",
            &format!(
                "frame-backlog dt={dt} discarded={} actual={:?}",
                dt - 0.1,
                state.velocity
            ),
        );
    }
    let fixed = flats_racer_physics::FIXED_DT;
    let clock_step = 1.0 / 120.0;
    *accumulator += f64::from(dt.clamp(0.0, 0.1));
    let mut held = false;
    for _ in 0..12 {
        if *accumulator + 1.0e-9 < clock_step {
            break;
        }
        *accumulator -= clock_step;
        let position = Vec3::from_array(state.position);
        let (supports, surface_velocity) = collision::supports_with_motion(
            world,
            position,
            state.yaw,
            tuning.support_reach(),
            Vec3::from_array(state.velocity),
            water_surface,
        );
        let mut next = *state;
        next.step_with_surface_motion(input, supports, surface_velocity, fixed, tuning)?;
        let movement = Vec3::from_array(next.velocity) * fixed;
        let endpoint = position + movement;
        if !endpoint.is_finite() || !movement.length_squared().is_finite() {
            return Err(flats_racer_physics::StepError::NonFiniteResult);
        }
        if !stream_ready(position, progress) || !stream_corridor_ready(position, endpoint, progress)
        {
            trace_hold(state, Vec3::from_array(next.velocity), progress);
            // Keep the entire pre-step state, including airborne momentum. Wall time is
            // discarded: loading must never build up a catch-up teleport.
            *accumulator = 0.0;
            held = true;
            break;
        }
        let old_yaw = state.yaw;
        *state = next;
        if !collision::clear_turn(world, position, old_yaw, state.yaw_rate * fixed) {
            state.yaw = old_yaw;
            state.yaw_rate = 0.0;
        }
        let (next_position, velocity) = collision::slide(
            world,
            position,
            Vec3::from_array(state.velocity),
            state.yaw,
            fixed,
        );
        let (position, velocity) =
            collision::land_on_water(position, next_position, velocity, water_surface);
        state.position = position.to_array();
        state.velocity = velocity.to_array();
    }

    Ok(held)
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn motion_flags_follow_actual_velocity_not_reverse_trigger_intent() {
        use crate::creature_anim::move_flags::{BACKWARD, FORWARD};
        for yaw in [0.0, 1.0, -2.0] {
            let forward = Quat::from_rotation_y(yaw) * Vec3::NEG_Z;
            assert_eq!(motion_flags(forward, yaw, false), FORWARD);
            assert_eq!(motion_flags(-forward, yaw, false), BACKWARD);
            assert_eq!(motion_flags(-forward, yaw, true), 0);
            assert_eq!(motion_flags(forward * 0.05, yaw, false), 0);
            assert_eq!(motion_flags(Vec3::Y, yaw, false), 0);
        }
    }

    #[test]
    fn projected_envelope_cannot_skip_the_furnished_window() {
        let position = Vec3::new(3945.0, -57.65, 6235.0);
        let wow = benilla_assets::coords::bevy_to_wow(position);
        let tile = benilla_formats::world_to_tile(wow[0], wow[1]);
        let mut progress = benilla_world::terrain_stream::WorldLoadProgress {
            focus_tile: Some((tile.0 as i32, tile.1 as i32)),
            collision_tiles: (-1..=1)
                .flat_map(|x| (-1..=1).map(move |y| (tile.0 as i32 + x, tile.1 as i32 + y)))
                .collect(),
            ..Default::default()
        };
        assert!(stream_corridor_ready(
            position,
            position + Vec3::X * 100.0,
            &progress
        ));
        assert!(!stream_corridor_ready(
            position,
            position + Vec3::X * 2000.0,
            &progress
        ));
        assert!(!stream_corridor_ready(
            position,
            Vec3::splat(f32::MAX),
            &progress
        ));
        let end = position + Vec3::X * 2000.0;
        let wow = benilla_assets::coords::bevy_to_wow(end);
        let far = benilla_formats::world_to_tile(wow[0], wow[1]);
        progress
            .collision_tiles
            .insert((far.0 as i32, far.1 as i32));
        assert!(
            !stream_corridor_ready(position, end, &progress),
            "loaded endpoints cannot bridge an unloaded middle tile"
        );
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn control(
    racer: &mut FlatsRacer,
    player: &mut Player,
    keys: &ButtonInput<KeyCode>,
    accepts_input: bool,
    look_config: super::camera::LookConfig,
    zoom: f32,
    zoom_max: f32,
    nearclip: f32,
    eligible: bool,
    mounted: bool,
    dt: f32,
    now: f32,
    net: &crate::net::NetCommands,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
    world: &benilla_world::collision::WorldCollision,
    liquid: &benilla_world::world_point::WorldPoint,
    camera: &mut Transform,
    cam: &mut super::camera::FlyCam,
    rig: &mut super::camera::CameraControl,
    body: &mut super::BodyQuery,
    landing: &mut MessageWriter<crate::creature_anim::HardLanding>,
    speed_acks: &[crate::net::SpeedChangeMessage],
) -> bool {
    let ui_camera_toggle = std::mem::take(&mut racer.camera_toggle_requested);
    racer.audio = Default::default();
    if !racer.enabled {
        return false;
    }
    if player.active && racer.controls.tuning && (accepts_input || racer.tuning_open) {
        racer.tuning_open = !racer.tuning_open;
    }
    let accepts_input = accepts_input && !racer.tuning_open;
    if accepts_input && player.active && (keys.just_pressed(KeyCode::F8) || racer.controls.mount) {
        let action = if racer.authorized { "off" } else { "on" };
        if request(net, action) {
            racer.status = "Waiting for server";
            racer.waiting_since = Some(now);
        }
        if racer.authorized {
            racer.revoke();
            player.horiz_vel = Vec3::ZERO;
            player.vel_y = 0.0;
        }
    }
    if !racer.authorized {
        if racer.waiting_since.is_some_and(|since| now - since > 5.0) {
            racer.status = "No server grant - see chat; F8 to retry";
            racer.waiting_since = None;
        }
        if racer.handoff {
            player.horiz_vel = Vec3::ZERO;
            player.vel_y = 0.0;
            player.airborne_since = None;
            player.autorun = false;
            super::movement_net::park_mover(&net.0, player);
            racer.handoff = false;
        }
        return false;
    }
    let corrected = racer
        .dynamics
        .as_ref()
        .is_some_and(|state| Vec3::from_array(state.position).distance(player.pos) > 3.0);
    if !eligible || (corrected && !racer.reset && racer.waiting_reset.is_none()) {
        warn!("flats racer: yielding eligible={eligible} corrected={corrected} body={:?} simulated={:?}",
            player.pos, racer.dynamics.map(|s| s.position));
        if benilla_assets::trace::enabled_for("racer") {
            benilla_assets::trace::line(
                "racer",
                &format!(
                    "yield eligible={eligible} corrected={corrected} body={:?} simulated={:?}",
                    player.pos,
                    racer.dynamics.map(|s| s.position)
                ),
            );
        }
        request(net, "off");
        yield_control(racer, player, net);
        return false;
    }
    if !mounted {
        let since = *racer.waiting_since.get_or_insert(now);
        if racer.dynamics.is_some() || now - since > 3.0 {
            warn!("flats racer: mount disappeared or did not arrive; revoking local simulation");
            request(net, "off");
            yield_control(racer, player, net);
        }
        return false;
    }
    racer.waiting_since = None;
    if accepts_input && (keys.just_pressed(KeyCode::F9) || racer.controls.reset) {
        if request(net, "reset") {
            racer.status = "Waiting for safe reset";
            racer.waiting_reset = Some(now);
            racer.reset = false;
        }
    }
    if let Some(since) = racer.waiting_reset {
        if racer.reset
            && racer
                .safe_start
                .is_some_and(|safe| player.pos.distance(safe) < 2.0)
        {
            racer.waiting_reset = None;
        } else if now - since > 5.0 {
            warn!("flats racer: safe reset did not arrive; yielding to normal movement");
            request(net, "off");
            yield_control(racer, player, net);
            return false;
        } else {
            player.horiz_vel = Vec3::ZERO;
            player.vel_y = 0.0;
            racer.speed = 0.0;
            return true;
        }
    }
    let reset = racer.reset || racer.dynamics.is_none();
    if reset {
        racer.safe_start.get_or_insert(player.pos);
        match flats_racer_physics::State::new(player.pos.to_array(), player.face_yaw) {
            Ok(state) => racer.dynamics = Some(state),
            Err(error) => {
                error!("flats racer: invalid starting pose: {error:?}");
                request(net, "off");
                yield_control(racer, player, net);
                return false;
            }
        }
        racer.reset = false;
        racer.accumulator = 0.0;
        player.airborne_since = None;
        player.horiz_vel = Vec3::ZERO;
        player.vel_y = 0.0;
        player.autorun = false;
    }
    let input = input::driving(keys, &racer.controls, accepts_input);
    let state = racer.dynamics.as_mut().expect("initialized racer state");
    let frame_start = Vec3::from_array(state.position);
    let was_grounded = state.grounded;
    let held = match advance_tuned(
        state,
        &mut racer.accumulator,
        input,
        dt,
        world,
        progress,
        &racer.tuning,
        &|point| {
            liquid.water_surface_at(
                benilla_world::world_point::Subject::Player,
                benilla_assets::coords::bevy_to_wow(point),
            )
        },
    ) {
        Ok(held) => {
            racer.status = if held {
                "Waiting for streamed collision"
            } else if !state.grounded {
                "Airborne"
            } else if input.drift {
                "Drifting"
            } else {
                "Hovering"
            };
            held
        }
        Err(error) => {
            error!("flats racer: simulation rejected state: {error:?}; lower F10 tuning values before remounting");
            request(net, "off");
            yield_control(racer, player, net);
            return false;
        }
    };
    player.pos = Vec3::from_array(state.position);
    player.face_yaw = state.yaw;
    player.model_yaw = state.yaw;
    let velocity = Vec3::from_array(state.velocity);
    player.horiz_vel = Vec3::new(velocity.x, 0.0, velocity.z);
    player.vel_y = velocity.y;
    racer.speed = player.horiz_vel.length();
    racer.audio = audio::Telemetry::new(input, held, racer.boost > state.boost_reserve);
    racer.boost = state.boost_reserve;
    let flags = motion_flags(velocity, state.yaw, held);
    super::body_pose::drive(
        player,
        body,
        landing,
        false,
        0.0,
        flags,
        flags,
        !was_grounded && state.grounded,
        0,
    );
    let (toggle, zoom) = input::camera_input(&racer.controls, zoom, accepts_input);
    let toggle = toggle || (ui_camera_toggle && accepts_input);
    let camera_reset = reset || toggle;
    if toggle {
        racer.camera_position.clear();
    }
    camera::update_controls(&mut racer.cockpit, toggle, zoom, dt, zoom_max, rig);
    camera::chase(
        player.pos,
        state.yaw,
        rig.distance,
        dt,
        camera_reset,
        input::looking(&racer.controls, accepts_input && !racer.cockpit),
        look_config,
        racer.camera_position_seconds,
        &mut racer.camera_position,
        camera,
        cam,
        rig,
        world,
    );
    rig.self_fade_alpha = if racer.cockpit {
        0.0
    } else {
        benilla_world::model_fade::self_model_fade_alpha(
            (camera.translation - (player.pos + Vec3::Y * 3.0)).length(),
            nearclip,
            benilla_world::model_fade::SELF_FADE_WINDOW,
        )
    };
    // Deviation: physical hops remain local; only this server-authorized mode uses grounded wire poses.
    let report_due = now - racer.last_report >= 0.1;
    if report_due && benilla_assets::trace::enabled_for("racer") {
        let frame_motion = if dt > 0.0 {
            (player.pos - frame_start) / dt
        } else {
            Vec3::ZERO
        };
        benilla_assets::trace::line(
            "racer",
            &format!(
            "motion pos={:?} actual={:?} frame_motion={frame_motion:?} throttle={} boost={} grounded={} held={} accumulator={}",
            state.position, state.velocity, input.throttle, input.boost, state.grounded, held,
            racer.accumulator,
        ),
        );
    }
    if report_due || flags != player.move_flags || !speed_acks.is_empty() {
        super::movement_net::stream_self_movement(
            &net.0,
            player,
            flags,
            0.0,
            super::movement_net::ArcEdges {
                jumped: false,
                wire_launch: false,
                air_nudged: false,
                landed: false,
                fall_time: 0,
            },
            now,
            speed_acks,
            None,
            None,
            super::movement_net::SkipClock {
                dt,
                held: false,
                mover: None,
            },
        );
    }
    if report_due && player.last_heartbeat != now {
        let pos = benilla_assets::coords::bevy_to_wow(player.pos);
        if let Err(error) = net.0.send(crate::net::ClientCommand::Move {
            kind: crate::net::MoveKind::Heartbeat,
            flags,
            pos,
            orientation: state.yaw.rem_euclid(std::f32::consts::TAU),
            pitch: 0.0,
            fall_time: 0,
            jump: None,
            transport: None,
        }) {
            error!("flats racer: heartbeat send failed: {error}");
        }
        player.last_heartbeat = now;
        player.last_pos = pos;
    }
    if report_due {
        racer.last_report = now;
    }
    true
}

pub(super) fn plugin(app: &mut App) {
    audio::plugin(app);
    app.init_resource::<FlatsRacer>()
        .add_systems(Update, hud::update.in_set(crate::ui_script::UiFeed))
        .add_systems(
            Update,
            input::sample
                .after(crate::ui_script::UiInput)
                .after(crate::video::apply_present_mode)
                .after(crate::video::apply_window_mode)
                .before(super::PlayerControlSet),
        )
        .add_systems(
            Update,
            camera::seat_cockpit
                .after(super::PlayerControlSet)
                .in_set(benilla_world::schedule::WorldStage::Input)
                .before(super::apply_self_model_fade)
                .run_if(camera::cockpit_active),
        )
        .add_systems(
            PostUpdate,
            camera::seat_cockpit
                .after(bevy::transform::TransformSystems::Propagate)
                .before(benilla_world::billboard::BillboardPlace)
                .before(bevy::camera::visibility::VisibilitySystems::UpdateFrusta)
                .run_if(camera::cockpit_active),
        )
        .add_systems(
            PostUpdate,
            bank_mount
                .in_set(CosmeticBank)
                .before(bevy::app::AnimationSystems),
        );
    if std::env::var("WOW_CAPTURE").as_deref() == Ok("flats-racer") {
        app.add_systems(
            Update,
            probe::drive
                .after(super::PlayerControlSet)
                .before(benilla_world::schedule::WorldStage::Present),
        );
    }
}

#[derive(Component)]
struct Banked;

#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct CosmeticBank;

fn bank_mount(
    mut commands: Commands,
    racer: Res<FlatsRacer>,
    riders: Query<(Has<crate::net::Embodied>, Option<&probe::ProbeBank>)>,
    mut mounts: Query<
        (
            Entity,
            &crate::entities::mount::MountBody,
            &mut Transform,
            Has<Banked>,
        ),
        Without<benilla_world::view::WorldCamera>,
    >,
) {
    for (entity, mount, mut transform, banked) in &mut mounts {
        let bank = riders.get(mount.host).ok().and_then(|(embodied, probe)| {
            probe.map(|bank| bank.0).or_else(|| {
                (racer.authorized && embodied)
                    .then(|| racer.dynamics.as_ref().map_or(0.0, |state| state.bank))
            })
        });
        if let Some(bank) = bank {
            transform.rotation = Quat::from_rotation_z(bank);
            if !banked {
                commands.entity(entity).insert(Banked);
            }
        } else if banked {
            transform.rotation = Quat::IDENTITY;
            commands.entity(entity).remove::<Banked>();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hud_camera_request_is_latched_once_and_handoff_clears_it() {
        let mut racer = FlatsRacer::default();
        assert_eq!(racer.camera_mode(), "Chase");
        racer.request_camera_toggle();
        racer.request_camera_toggle();
        assert!(std::mem::take(&mut racer.camera_toggle_requested));
        assert!(!std::mem::take(&mut racer.camera_toggle_requested));
        racer.cockpit = true;
        assert_eq!(racer.camera_mode(), "Cockpit");
        racer.request_camera_toggle();
        racer.revoke();
        assert_eq!(racer.camera_mode(), "Chase");
        assert!(!racer.camera_toggle_requested);
    }

    #[test]
    fn exploration_admits_both_continents_but_not_instances() {
        assert!(supports_map(0) && supports_map(1));
        for map in [2, 30, 33, 489, u32::MAX] {
            assert!(!supports_map(map));
        }
    }

    #[test]
    fn racer_systems_respect_the_world_and_ui_schedule_contract() {
        use crate::ui_script::{UiFeed, UiInput, UiPaint};
        use benilla_world::schedule::WorldStage;

        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .configure_sets(
                Update,
                (
                    WorldStage::Net,
                    WorldStage::Input,
                    WorldStage::Stream,
                    WorldStage::Present,
                )
                    .chain(),
            )
            .configure_sets(
                Update,
                (
                    UiFeed.after(WorldStage::Net),
                    UiInput.before(WorldStage::Input),
                    UiPaint,
                )
                    .chain(),
            )
            .add_systems(
                Update,
                (|| {})
                    .in_set(super::super::PlayerControlSet)
                    .in_set(WorldStage::Input),
            );
        plugin(&mut app);
        app.world_mut().schedule_scope(Update, |world, schedule| {
            schedule
                .initialize(world)
                .expect("racer ordering must be acyclic");
        });
    }

    #[test]
    fn unattended_input_only_admits_synthetic_keys_and_preserves_edges() {
        let mut keys = ButtonInput::default();
        keys.press(KeyCode::KeyW);
        keys.press(KeyCode::F8);
        let hold = benilla_world::modkeys::SyntheticHold(vec![KeyCode::F8]);
        let filtered = synthetic_input(&keys, &hold);
        assert!(!filtered.pressed(KeyCode::KeyW));
        assert!(filtered.just_pressed(KeyCode::F8));
        keys.clear_just_pressed(KeyCode::F8);
        let filtered = synthetic_input(&keys, &hold);
        assert!(filtered.pressed(KeyCode::F8));
        assert!(!filtered.just_pressed(KeyCode::F8));
    }

    #[test]
    fn relinquishing_custom_motion_preserves_normal_walking_state() {
        let (sender, _receiver) = crossbeam_channel::unbounded();
        let mut player = Player::default();
        player.pos = Vec3::new(11.0, 2.0, 9.0);
        player.face_yaw = 0.7;
        player.walking = true;
        player.horiz_vel = Vec3::X * 50.0;
        player.vel_y = 4.0;
        player.airborne_since = Some(1.0);
        player.autorun = true;
        let mut racer = FlatsRacer::default();
        racer.authorized = true;
        racer.handoff = true;
        yield_control(&mut racer, &mut player, &crate::net::NetCommands(sender));
        assert!(!racer.authorized && racer.dynamics.is_none() && !racer.handoff);
        assert_eq!(player.horiz_vel, Vec3::ZERO);
        assert_eq!(player.vel_y, 0.0);
        assert!(player.airborne_since.is_none() && !player.autorun);
        assert!(player.walking);
        assert_eq!(player.pos, Vec3::new(11.0, 2.0, 9.0));
        assert_eq!(player.face_yaw, 0.7);
    }

    fn marker(kind: u8, sender: u64, text: &str) -> ChatMessage {
        ChatMessage {
            chat_type: kind,
            language: 0,
            sender_guid: sender,
            target_guid: 0,
            sender_name: None,
            channel: None,
            text: text.into(),
            chat_tag: 0,
        }
    }

    #[test]
    fn ordinary_chat_and_disabled_mode_cannot_authorize_vehicle() {
        let mut racer = FlatsRacer {
            enabled: false,
            ..Default::default()
        };
        racer.server_chat(&marker(0x0a, 0, "FLATS_RACER ON"));
        assert!(!racer.authorized);
        racer.enabled = true;
        for message in [
            marker(0, 0, "FLATS_RACER ON"),
            marker(0x0a, 7, "FLATS_RACER ON"),
            marker(0x0a, 0, "FLATS_RACER ON "),
            marker(0x0a, 0, "prefix FLATS_RACER ON"),
        ] {
            racer.server_chat(&message);
            assert!(!racer.authorized);
        }
        racer.server_chat(&marker(0x0a, 0, "FLATS_RACER RESET"));
        assert!(!racer.authorized);
        racer.server_chat(&marker(0x0a, 0, "FLATS_RACER ON"));
        assert!(racer.authorized && racer.reset);
        racer.server_chat(&marker(0x0a, 0, "FLATS_RACER OFF"));
        assert!(!racer.authorized);
        assert_eq!(racer.speed, 0.0);
    }

    #[test]
    fn a_completed_load_for_another_tile_cannot_unfreeze_the_racer() {
        use benilla_world::terrain_stream::WorldLoadProgress;
        let position = Vec3::new(3945.0, -57.55, 6235.0);
        let mut progress = WorldLoadProgress {
            ready: 9,
            total: 9,
            focus_resident: true,
            scene_ready: true,
            colliders_pending: 0,
            merge_pending: 0,
            placements_pending: 0,
            gx_pending: 0,
            focus_tile: None,
            complete: true,
            ..Default::default()
        };
        assert!(!stream_ready(position, &progress));
        let tile = benilla_formats::world_to_tile(-6235.0, -3945.0);
        progress.focus_tile = Some((tile.0 as i32, tile.1 as i32));
        assert!(
            !stream_ready(position, &progress),
            "render readiness is not collision proof"
        );
        progress
            .collision_tiles
            .insert((tile.0 as i32, tile.1 as i32));
        assert!(stream_ready(position, &progress));
        progress.colliders_pending = 1;
        progress.merge_pending = 100;
        progress.placements_pending = 100;
        assert!(
            stream_ready(position, &progress),
            "unrelated backlog must not stop a ready tile"
        );
        progress.collision_tiles.clear();
        assert!(!stream_ready(position, &progress));
    }
}
