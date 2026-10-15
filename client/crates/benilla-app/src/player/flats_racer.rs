//! Deviation: opt-in local hover-racer controls, authorized explicitly by the custom server.
//! Stock walking, mount assets, and Avian's streamed collision geometry remain separate.

use benilla_protocol::messages::ChatMessage;
use benilla_ui::script::UiScript;
use bevy::prelude::*;

use super::Player;

mod collision;
mod input;
mod probe;
mod tuning;
pub(crate) use probe::{probe_done, probe_ready};

pub(crate) const DISPLAY_ID: u32 = 10318;

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
    tuning_open: bool,
    controls: input::Controls,
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
    let wow = benilla_assets::coords::bevy_to_wow(position);
    let tile = benilla_formats::world_to_tile(wow[0], wow[1]);
    progress.total > 0
        && progress.focus_resident
        && progress.scene_ready
        && progress.focus_tile == Some((tile.0 as i32, tile.1 as i32))
        && progress.colliders_pending == 0
        && progress.merge_pending == 0
        && progress.placements_pending == 0
}

fn chase_camera(
    position: Vec3,
    yaw: f32,
    speed: f32,
    dt: f32,
    reset: bool,
    camera: &mut Transform,
    cam: &mut super::camera::FlyCam,
    rig: &mut super::camera::CameraControl,
    world: &benilla_world::collision::WorldCollision,
) {
    let blend = 1.0 - (-7.0 * dt.clamp(0.0, 0.1)).exp();
    cam.yaw += crate::creature_anim::wrap_pi(yaw - cam.yaw) * blend;
    cam.pitch = -0.22;
    let pivot = position + Vec3::Y * 3.0;
    let direction = Quat::from_rotation_y(cam.yaw) * Vec3::new(0.0, 0.3, 1.0).normalize();
    let distance = 16.0 + (speed / 80.0).clamp(0.0, 1.0) * 4.0;
    let arm = direction * distance;
    let allowed = world.cast_camera(pivot, arm, false).unwrap_or(distance);
    let wanted = pivot + direction * (allowed - 0.15).max(0.0);
    let candidate = if reset {
        wanted
    } else {
        camera.translation.lerp(wanted, blend)
    };
    let offset = candidate - pivot;
    let clear = world
        .cast_camera(pivot, offset, false)
        .unwrap_or(offset.length());
    camera.translation = pivot + offset.normalize_or_zero() * clear.max(0.0);
    camera.look_at(pivot, Vec3::Y);
    rig.park_distance(distance);
    rig.collision_distance = clear;
    rig.self_fade_alpha = 1.0;
}

impl Default for FlatsRacer {
    fn default() -> Self {
        Self {
            enabled: std::env::var("WOW_FLATS_RACER").as_deref() == Ok("1"),
            authorized: false,
            reset: false,
            status: "F8 to request mount (Shimmering Flats only)",
            speed: 0.0,
            boost: 1.0,
            tuning: Default::default(),
            tuning_open: false,
            controls: Default::default(),
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
    pub(crate) fn server_chat(&mut self, message: &ChatMessage) {
        if !self.enabled || message.chat_type != 0x0a || message.sender_guid != 0 {
            return;
        }
        match message.text.as_str() {
            "FLATS_RACER ON" => {
                self.authorized = true;
                self.reset = true;
                self.waiting_since = None;
                self.status = "Mounting";
            }
            "FLATS_RACER OFF" => self.revoke(),
            "FLATS_RACER RESET" if self.authorized => {
                self.reset = true;
                self.status = "Resetting";
            }
            _ => {}
        }
    }

    pub(crate) fn revoke(&mut self) {
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
) -> Result<bool, flats_racer_physics::StepError> {
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
        let velocity = Vec3::from_array(state.velocity);
        let ahead = position + velocity * 0.25;
        let supports = collision::supports(world, position, state.yaw);
        // Ahead probes prove collision residency across tile edges; requiring the future tile
        // to equal the current streaming focus would stop the racer before it could cross.
        if !stream_ready(position, progress)
            || supports.iter().any(Option::is_none)
            || collision::supports(world, ahead, state.yaw)
                .iter()
                .any(Option::is_none)
        {
            state.velocity = [0.0; 3];
            state.yaw_rate = 0.0;
            *accumulator = 0.0;
            held = true;
            break;
        }
        let old_yaw = state.yaw;
        state.step_with_tuning(input, supports, fixed, tuning)?;
        if !collision::clear_turn(world, position, old_yaw, state.yaw) {
            state.yaw = old_yaw;
            state.yaw_rate = 0.0;
        }
        let (position, velocity) = collision::slide(
            world,
            position,
            Vec3::from_array(state.velocity),
            state.yaw,
            fixed,
        );
        state.position = position.to_array();
        state.velocity = velocity.to_array();
    }
    Ok(held)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn control(
    racer: &mut FlatsRacer,
    player: &mut Player,
    keys: &ButtonInput<KeyCode>,
    accepts_input: bool,
    eligible: bool,
    mounted: bool,
    dt: f32,
    now: f32,
    net: &crate::net::NetCommands,
    progress: &benilla_world::terrain_stream::WorldLoadProgress,
    world: &benilla_world::collision::WorldCollision,
    camera: &mut Transform,
    cam: &mut super::camera::FlyCam,
    rig: &mut super::camera::CameraControl,
    body: &mut super::BodyQuery,
    landing: &mut MessageWriter<crate::creature_anim::HardLanding>,
    speed_acks: &[crate::net::SpeedChangeMessage],
) -> bool {
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
    let was_grounded = state.grounded;
    match advance_tuned(
        state,
        &mut racer.accumulator,
        input,
        dt,
        world,
        progress,
        &racer.tuning,
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
            }
        }
        Err(error) => {
            error!("flats racer: simulation rejected state: {error:?}");
            request(net, "off");
            yield_control(racer, player, net);
            return false;
        }
    }
    player.pos = Vec3::from_array(state.position);
    player.face_yaw = state.yaw;
    player.model_yaw = state.yaw;
    let velocity = Vec3::from_array(state.velocity);
    player.horiz_vel = Vec3::new(velocity.x, 0.0, velocity.z);
    player.vel_y = velocity.y;
    racer.speed = player.horiz_vel.length();
    racer.boost = state.boost_reserve;
    let flags = if racer.speed > 0.1 {
        crate::creature_anim::move_flags::FORWARD
    } else {
        0
    };
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
    chase_camera(
        player.pos,
        state.yaw,
        racer.speed,
        dt,
        reset,
        camera,
        cam,
        rig,
        world,
    );
    // Deviation: physical hops remain local; only this server-authorized mode uses grounded wire poses.
    let report_due = now - racer.last_report >= 0.1;
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
    app.init_resource::<FlatsRacer>()
        .add_systems(Update, hud.in_set(crate::ui_script::UiFeed))
        .add_systems(
            Update,
            input::sample
                .after(crate::ui_script::UiInput)
                .after(crate::video::apply_present_mode)
                .after(crate::video::apply_window_mode)
                .before(super::PlayerControlSet),
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

fn hud(
    mut racer: ResMut<FlatsRacer>,
    player: Res<Player>,
    time: Res<Time>,
    script: Option<NonSend<UiScript>>,
    mut next: Local<crate::ui_script::VmMemo<f32>>,
) {
    let Some(script) = script else { return };
    let next = next.get(&script);
    if time.elapsed_secs() < *next {
        return;
    }
    *next = time.elapsed_secs() + 0.1;
    if !racer.enabled || !player.active {
        racer.tuning_open = false;
        crate::ui_script::run_or_warn(&script, "if FlatsRacerHUD then FlatsRacerHUD:Hide() end if FlatsRacerTuning then for i=1,17 do getglobal('FlatsRacerTuneBox'..i):ClearFocus() end FlatsRacerTuning:Hide() end");
        return;
    }
    tuning::update(&script, &mut racer);
    crate::ui_script::run_or_warn(
        &script,
        &format!(
            r#"
if not FlatsRacerHUD then
    local f = CreateFrame("Frame", "FlatsRacerHUD", UIParent)
    f:SetWidth(660) f:SetHeight(82) f:SetPoint("TOP", UIParent, "TOP", 0, -58)
    local t = f:CreateFontString("FlatsRacerHUDText", "OVERLAY", "GameFontNormal")
    t:SetAllPoints(f)
    local b=CreateFrame("Button","FlatsRacerTuneToggle",f)
    b:SetWidth(90) b:SetHeight(25)
    b:SetPoint("TOPRIGHT",f,"TOPRIGHT",95,0)
    local caption=b:CreateFontString(nil,"OVERLAY","GameFontNormal")
    caption:SetPoint("CENTER",b,"CENTER",0,0)
    caption:SetText("[Tuning]")
    b:SetScript("OnClick",function() FlatsRacerTuneCommand="toggle" end)
end
FlatsRacerHUD:Show()
FlatsRacerHUDText:SetText("FLATS RACER | {status} | {speed:.1} yd/s | boost {boost:.0}%\n{tutorial}")
"#,
            status = racer.status,
            speed = racer.speed,
            boost = racer.boost * 100.0,
            tutorial = racer.controls.device.tutorial(),
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

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
        };
        assert!(!stream_ready(position, &progress));
        let tile = benilla_formats::world_to_tile(-6235.0, -3945.0);
        progress.focus_tile = Some((tile.0 as i32, tile.1 as i32));
        assert!(stream_ready(position, &progress));
        progress.colliders_pending = 1;
        assert!(!stream_ready(position, &progress));
        progress.colliders_pending = 0;
        progress.total = 0;
        assert!(!stream_ready(position, &progress));
    }
}
