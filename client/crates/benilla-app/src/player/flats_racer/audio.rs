//! Deviation: original synthesized cockpit engines for the explicitly authorized custom racer.

use bevy::prelude::*;
use kira::Frame;
use kira::sound::static_sound::{StaticSoundData, StaticSoundHandle};
use kira::sound::PlaybackState;
use kira::Decibels;

use crate::sound::{mixer, SoundConfig, SoundOutput};

const LAYERS: usize = 3;
const SAMPLE_RATE: u32 = 24_000;
const RELEASE_MS: u64 = 180;

#[derive(Default, Clone, Copy)]
pub(super) struct Telemetry {
    thrust: f32,
    boosting: bool,
    held: bool,
}

impl Telemetry {
    pub(super) fn new(input: flats_racer_physics::Input, held: bool, boosting: bool) -> Self {
        Self {
            thrust: if held || input.brake {
                0.0
            } else {
                unit(input.throttle.abs())
            },
            boosting: boosting && !held,
            held,
        }
    }
}

fn unit(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

#[derive(Default)]
struct Envelope {
    speed: f32,
    thrust: f32,
    boost: f32,
}

impl Envelope {
    fn advance(&mut self, speed: f32, telemetry: Telemetry, dt: f32) {
        let dt = if dt.is_finite() { dt.max(0.0) } else { 0.0 };
        let follow = 1.0 - (-dt / 0.22).exp();
        let speed = if telemetry.held {
            0.0
        } else {
            unit(speed / 120.0)
        };
        self.speed += (speed - self.speed) * follow;
        self.thrust += (telemetry.thrust - self.thrust) * follow;
        let boost = if telemetry.boosting { 1.0 } else { 0.0 };
        let boost_follow = 1.0 - (-dt / if boost > self.boost { 0.09 } else { 0.25 }).exp();
        self.boost += (boost - self.boost) * boost_follow;
    }

    fn layers(&self) -> [(f32, f32); LAYERS] {
        [
            (
                0.075 + 0.035 * self.thrust,
                0.8 + 0.7 * self.speed + 0.2 * self.thrust,
            ),
            (
                0.008 + 0.022 * self.thrust + 0.010 * self.speed,
                0.65 + 1.0 * self.speed + 0.4 * self.thrust,
            ),
            (
                0.035 * self.boost,
                0.9 + 0.7 * self.speed + 0.3 * self.boost,
            ),
        ]
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Wait,
    Start,
    Feed,
    Stop,
}

#[derive(Default)]
struct Lifecycle {
    retiring: bool,
    retry: f32,
}

impl Lifecycle {
    fn action(&mut self, active: bool, voices: usize, dt: f32) -> Action {
        self.retry = (self.retry - dt.max(0.0)).max(0.0);
        if voices == 0 {
            self.retiring = false;
            if active && self.retry == 0.0 {
                // Refused voices retry slowly, never once per frame.
                self.retry = 2.0;
                return Action::Start;
            }
        } else if !self.retiring {
            if active && voices == LAYERS {
                return Action::Feed;
            }
            self.retiring = true;
            self.retry = 0.0;
            return Action::Stop;
        }
        Action::Wait
    }
}

#[derive(Resource, Default)]
struct RacerAudio {
    samples: Option<[StaticSoundData; LAYERS]>,
    voices: Vec<StaticSoundHandle>,
    envelope: Envelope,
    lifecycle: Lifecycle,
}

impl Drop for RacerAudio {
    fn drop(&mut self) {
        for voice in &mut self.voices {
            voice.stop(mixer::declick());
        }
    }
}

fn tone(hz: f32, t: f32) -> f32 {
    (std::f32::consts::TAU * hz * t).sin()
}

fn sample(layer: usize, t: f32) -> Frame {
    match layer {
        0 => {
            // Integer-Hz partials make the two-second beds seamless, including the pulse.
            let engine = |fundamental| {
                (0.64 * tone(fundamental, t)
                    + 0.22 * tone(fundamental * 2.0, t)
                    + 0.09 * tone(fundamental * 3.0, t))
                    * (0.85 + 0.15 * tone(7.0, t))
            };
            let left = engine(47.0);
            let right = engine(49.0);
            Frame::new(0.8 * left + 0.2 * right, 0.2 * left + 0.8 * right)
        }
        1 => Frame::from_mono(0.7 * tone(360.0, t) + 0.2 * tone(720.0, t) + 0.08 * tone(1080.0, t)),
        _ => Frame::new(
            (0.65 * tone(610.0, t) + 0.25 * tone(1220.0, t)) * (0.85 + 0.15 * tone(11.0, t)),
            (0.65 * tone(613.0, t) + 0.25 * tone(1226.0, t)) * (0.85 + 0.15 * tone(11.0, t)),
        ),
    }
}

fn synthesize() -> [StaticSoundData; LAYERS] {
    std::array::from_fn(|layer| StaticSoundData {
        sample_rate: SAMPLE_RATE,
        frames: (0..SAMPLE_RATE * 2)
            .map(|i| sample(layer, i as f32 / SAMPLE_RATE as f32))
            .collect(),
        settings: Default::default(),
        slice: None,
    })
}

fn live(racer: &super::FlatsRacer, in_world: bool, seated: bool, world_hold: bool) -> bool {
    racer.enabled
        && racer.authorized
        && racer.dynamics.is_some()
        && in_world
        && seated
        && !world_hold
}

fn drive(
    racer: Res<super::FlatsRacer>,
    player: Res<super::Player>,
    client: Res<State<crate::char_select::ClientState>>,
    config: Res<SoundConfig>,
    mut out: NonSendMut<SoundOutput>,
    mut audio: ResMut<RacerAudio>,
    time: Res<Time>,
) {
    audio
        .voices
        .retain(|voice| voice.state() != PlaybackState::Stopped);
    out.racer_voices = audio.voices.len();
    let active = out.mixer.is_some()
        && live(
            &racer,
            *client.get() == crate::char_select::ClientState::InWorld,
            player.active,
            config.world_hold,
        );
    let action = audio
        .lifecycle
        .action(active, out.racer_voices, time.delta_secs());
    match action {
        Action::Start => {
            if out.live_voices() + LAYERS > crate::sound::SOFTWARE_CHANNELS {
                return;
            }
            let samples = audio.samples.get_or_insert_with(synthesize).clone();
            audio.envelope = Envelope::default();
            let mixer = out.mixer.as_mut().expect("active audio has a mixer");
            for (data, (_, rate)) in samples.into_iter().zip(audio.envelope.layers()) {
                match mixer.play_2d(
                    data.loop_region(..)
                        .volume(Decibels::SILENCE)
                        .playback_rate(rate as f64),
                ) {
                    Ok(voice) => audio.voices.push(voice),
                    Err(error) => {
                        warn!("racer audio: could not start engine layer: {error:#}");
                        // Keep every fading handle until stopped, even on a partial start.
                        for voice in &mut audio.voices {
                            voice.stop(mixer::declick());
                        }
                        audio.lifecycle.retiring = true;
                        break;
                    }
                }
            }
        }
        Action::Feed => {
            audio
                .envelope
                .advance(racer.speed, racer.audio, time.delta_secs());
            let effects = if config.enabled {
                unit(config.sfx)
            } else {
                0.0
            };
            let layers = audio.envelope.layers();
            for (voice, (amp, rate)) in audio.voices.iter_mut().zip(layers) {
                voice.set_volume(mixer::amp_to_db(amp * effects), mixer::glide());
                voice.set_playback_rate(rate as f64, mixer::glide());
            }
        }
        Action::Stop => {
            for voice in &mut audio.voices {
                voice.stop(mixer::fade(RELEASE_MS));
            }
        }
        Action::Wait => {}
    }
    out.racer_voices = audio.voices.len();
}

pub(super) fn plugin(app: &mut App) {
    app.init_resource::<RacerAudio>().add_systems(
        Update,
        // Keep ticking outside InWorld so logout/dismount can retire every loop.
        drive.in_set(benilla_world::schedule::WorldStage::Present),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_never_restarts_live_or_retiring_voices() {
        let mut lifecycle = Lifecycle::default();
        assert_eq!(lifecycle.action(false, 0, 0.0), Action::Wait);
        assert_eq!(lifecycle.action(true, 0, 0.0), Action::Start);
        assert_eq!(lifecycle.action(true, 0, 0.01), Action::Wait);
        assert_eq!(lifecycle.action(true, LAYERS, 0.01), Action::Feed);
        assert_eq!(lifecycle.action(false, LAYERS, 0.01), Action::Stop);
        assert_eq!(lifecycle.action(true, LAYERS, 0.01), Action::Wait);
        assert_eq!(lifecycle.action(true, 1, 0.01), Action::Wait);
        assert_eq!(lifecycle.action(true, 0, 0.01), Action::Start);
        assert_eq!(lifecycle.action(true, LAYERS - 1, 0.01), Action::Stop);
        assert_eq!(lifecycle.action(true, LAYERS - 1, 3.0), Action::Wait);
        assert_eq!(lifecycle.action(false, 0, 0.01), Action::Wait);
    }

    #[test]
    fn only_authorized_seated_world_racer_can_sound() {
        let mut racer = super::super::FlatsRacer {
            enabled: true,
            authorized: true,
            dynamics: Some(flats_racer_physics::State::new([0.0; 3], 0.0).unwrap()),
            ..Default::default()
        };
        assert!(live(&racer, true, true, false));
        assert!(!live(&racer, false, true, false));
        assert!(!live(&racer, true, false, false));
        assert!(!live(&racer, true, true, true));
        racer.enabled = false;
        assert!(!live(&racer, true, true, false));
        racer.enabled = true;
        racer.authorized = false;
        assert!(!live(&racer, true, true, false));
        racer.authorized = true;
        racer.dynamics = None;
        assert!(!live(&racer, true, true, false));
    }

    #[test]
    fn thrust_reverse_brake_and_stream_hold_map_to_engine_load() {
        let input = flats_racer_physics::Input {
            throttle: -0.6,
            ..Default::default()
        };
        assert_eq!(Telemetry::new(input, false, false).thrust, 0.6);
        assert_eq!(Telemetry::new(input, true, true).thrust, 0.0);
        assert!(!Telemetry::new(input, true, true).boosting);
        assert_eq!(
            Telemetry::new(
                flats_racer_physics::Input {
                    brake: true,
                    ..input
                },
                false,
                false
            )
            .thrust,
            0.0
        );
        assert!(!Telemetry::new(input, false, false).boosting);
    }

    #[test]
    fn envelope_is_frame_rate_independent_and_has_bounded_headroom() {
        let telemetry = Telemetry {
            thrust: 1.0,
            boosting: true,
            held: false,
        };
        let mut results = Vec::new();
        for hz in [30, 60, 144] {
            let mut envelope = Envelope::default();
            for _ in 0..hz {
                envelope.advance(120.0, telemetry, 1.0 / hz as f32);
            }
            results.push(envelope.layers());
            assert!(envelope.layers().iter().map(|(amp, _)| amp).sum::<f32>() < 0.19);
            assert!(envelope
                .layers()
                .iter()
                .all(|(_, rate)| *rate > 0.0 && *rate < 2.1));
        }
        for result in &results[1..] {
            for (a, b) in result.iter().zip(results[0]) {
                assert!((a.0 - b.0).abs() < 1e-6);
                assert!((a.1 - b.1).abs() < 1e-5);
            }
        }
        let mut releasing = Envelope {
            speed: 1.0,
            thrust: 1.0,
            boost: 1.0,
        };
        releasing.advance(0.0, Telemetry::default(), 0.25);
        assert!((releasing.boost - (-1.0_f32).exp()).abs() < 1e-6);
        assert!(releasing.thrust > 0.0 && releasing.thrust < 1.0);
        let mut envelope = Envelope::default();
        envelope.advance(f32::INFINITY, Telemetry::default(), f32::NAN);
        assert!(envelope
            .layers()
            .iter()
            .all(|(amp, rate)| amp.is_finite() && rate.is_finite()));
    }

    #[test]
    fn original_beds_are_periodic_zero_centered_and_below_full_scale() {
        let beds = synthesize();
        for (layer, bed) in beds.iter().enumerate() {
            let mut sum = [0.0_f64; 2];
            for frame in bed.frames.iter() {
                assert!(frame.left.is_finite() && frame.right.is_finite());
                assert!(frame.left.abs() < 1.0 && frame.right.abs() < 1.0);
                sum[0] += frame.left as f64;
                sum[1] += frame.right as f64;
            }
            assert!(sum
                .into_iter()
                .all(|sum| (sum / bed.frames.len() as f64).abs() < 1e-5));
            let start = sample(layer, 0.0);
            let end = sample(layer, 2.0);
            assert!((start.left - end.left).abs() < 0.002);
            assert!((start.right - end.right).abs() < 0.002);
        }
    }
}
