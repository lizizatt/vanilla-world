//! Custom vehicle inputs only; ordinary walking remains keyboard/mouse.

use super::*;
use std::collections::HashMap;

#[derive(Default, Clone, Copy, PartialEq, Eq)]
pub(super) enum Device {
    #[default]
    Keyboard,
    Controller,
}

impl Device {
    pub(super) fn tutorial(self) -> &'static str {
        match self {
            Self::Keyboard => {
                "F8 mount/off   F9 safe reset   F10 tuning   W thrust   S brake\\nA/D steer   Shift boost   Ctrl drift   Space hop\\nMouse wheel zoom   Ctrl+Alt+V cockpit"
            }
            Self::Controller => {
                "Start/Menu mount/off   Y/Triangle reset   Back/View tuning\\nLeft stick steer   Right stick camera   RT/R2 thrust   LT/L2 reverse\\nA/Cross hop   RB/R1 boost   LB/L1 drift   R3 cockpit   D-pad up/down zoom"
            }
        }
    }
}

#[derive(Default)]
pub(super) struct Controls {
    pub device: Device,
    pub pad: flats_racer_physics::Input,
    pub look: Vec2,
    pub cockpit: bool,
    pub zoom: f32,
    pub mount: bool,
    pub reset: bool,
    pub tuning: bool,
    active: Option<Entity>,
}

fn axis(value: f32, deadzone: f32) -> f32 {
    if !value.is_finite() || value.abs() <= deadzone {
        0.0
    } else {
        value.signum() * ((value.abs().min(1.0) - deadzone) / (1.0 - deadzone))
    }
}

fn read(pad: &Gamepad) -> flats_racer_physics::Input {
    flats_racer_physics::Input {
        throttle: axis(pad.get(GamepadButton::RightTrigger2).unwrap_or(0.0), 0.08).max(0.0)
            - axis(pad.get(GamepadButton::LeftTrigger2).unwrap_or(0.0), 0.08).max(0.0),
        steer: -axis(pad.left_stick().x, 0.18),
        brake: false,
        boost: pad.pressed(GamepadButton::RightTrigger),
        drift: pad.pressed(GamepadButton::LeftTrigger),
        jump: pad.pressed(GamepadButton::South),
    }
}

fn read_look(pad: &Gamepad) -> Vec2 {
    let stick = pad.right_stick();
    Vec2::new(axis(stick.x, 0.18), axis(stick.y, 0.18))
}

fn cockpit_key(keys: &ButtonInput<KeyCode>) -> bool {
    keys.just_pressed(KeyCode::KeyV)
        && keys.any_pressed([KeyCode::ControlLeft, KeyCode::ControlRight])
        && keys.any_pressed([KeyCode::AltLeft, KeyCode::AltRight])
        && !keys.any_pressed([KeyCode::ShiftLeft, KeyCode::ShiftRight])
}

pub(super) fn camera_input(controls: &Controls, zoom: f32, accepts_input: bool) -> (bool, f32) {
    if accepts_input {
        (controls.cockpit, zoom + controls.zoom)
    } else {
        (false, 0.0)
    }
}

pub(super) fn looking(controls: &Controls, accepts_input: bool) -> Vec2 {
    if accepts_input && controls.device == Device::Controller {
        controls.look
    } else {
        Vec2::ZERO
    }
}

pub(super) fn driving(
    keys: &ButtonInput<KeyCode>,
    controls: &Controls,
    accepts_input: bool,
) -> flats_racer_physics::Input {
    if !accepts_input {
        return flats_racer_physics::Input {
            brake: true,
            ..Default::default()
        };
    }
    if controls.device == Device::Controller {
        return controls.pad;
    }
    flats_racer_physics::Input {
        throttle: if keys.pressed(KeyCode::KeyW) {
            1.0
        } else {
            0.0
        },
        steer: if keys.pressed(KeyCode::KeyA) {
            1.0
        } else {
            0.0
        } - if keys.pressed(KeyCode::KeyD) {
            1.0
        } else {
            0.0
        },
        brake: keys.pressed(KeyCode::KeyS),
        boost: keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight),
        drift: keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight),
        jump: keys.pressed(KeyCode::Space),
    }
}

fn analog_activity(previous: [f32; 5], current: [f32; 5]) -> bool {
    previous
        .into_iter()
        .zip(current)
        .any(|(before, after)| after != 0.0 && (after - before).abs() > 0.04)
}

pub(super) fn sample(
    mut racer: ResMut<FlatsRacer>,
    keys: Res<ButtonInput<KeyCode>>,
    gamepads: Query<(Entity, &Gamepad)>,
    windows: Query<&Window, With<bevy::window::PrimaryWindow>>,
    mut previous: Local<HashMap<Entity, [f32; 5]>>,
    script: Option<NonSend<UiScript>>,
    capture: Option<Res<crate::ui_script::UiKeyboardCapture>>,
) {
    if !racer.enabled {
        return;
    }
    let focused = windows.iter().any(|window| window.focused);
    let requested = focused
        && cockpit_key(&keys)
        && !capture
            .as_ref()
            .is_some_and(|capture| capture.typing || capture.consumed.contains(&KeyCode::KeyV));
    let bound = requested
        && script.as_ref().is_some_and(|script| {
            script
                .binding_keys()
                .iter()
                .any(|(key, _)| matches!(key.as_str(), "CTRL-ALT-V" | "ALT-CTRL-V"))
        });
    if bound {
        warn!("flats racer: Ctrl+Alt+V is already bound; cockpit toggle ignored");
        racer.status = "Cockpit shortcut already bound - use R3 or unbind Ctrl+Alt+V";
    }
    let controls = &mut racer.controls;
    controls.mount = false;
    controls.reset = false;
    controls.tuning = false;
    controls.pad = Default::default();
    controls.look = Vec2::ZERO;
    controls.cockpit = false;
    controls.zoom = 0.0;
    controls.tuning = focused && keys.just_pressed(KeyCode::F10);
    controls.cockpit = focused && requested && !bound;
    if focused && keys.get_just_pressed().next().is_some() {
        controls.device = Device::Keyboard;
    }
    previous.retain(|entity, _| gamepads.get(*entity).is_ok());
    if controls
        .active
        .is_some_and(|entity| gamepads.get(entity).is_err())
    {
        controls.active = None;
        controls.device = Device::Keyboard;
    }
    for (entity, gamepad) in &gamepads {
        let look = read_look(gamepad);
        let analog = [
            axis(gamepad.left_stick().x, 0.18),
            axis(
                gamepad.get(GamepadButton::RightTrigger2).unwrap_or(0.0),
                0.08,
            ),
            axis(
                gamepad.get(GamepadButton::LeftTrigger2).unwrap_or(0.0),
                0.08,
            ),
            look.x,
            look.y,
        ];
        let before = previous.insert(entity, analog).unwrap_or([0.0; 5]);
        let activity =
            gamepad.get_just_pressed().next().is_some() || analog_activity(before, analog);
        if focused && activity {
            controls.active = Some(entity);
            controls.device = Device::Controller;
        }
    }
    if focused {
        if let Some((_, pad)) = controls.active.and_then(|entity| gamepads.get(entity).ok()) {
            if controls.device == Device::Controller {
                controls.pad = read(pad);
                controls.look = read_look(pad);
                controls.mount = pad.just_pressed(GamepadButton::Start);
                controls.reset = pad.just_pressed(GamepadButton::North);
                controls.tuning |= pad.just_pressed(GamepadButton::Select);
                controls.cockpit |= pad.just_pressed(GamepadButton::RightThumb);
                controls.zoom = u8::from(pad.just_pressed(GamepadButton::DPadUp)) as f32
                    - u8::from(pad.just_pressed(GamepadButton::DPadDown)) as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cockpit_chord_requires_modifiers_and_camera_actions_respect_input_gate() {
        let mut keys = ButtonInput::default();
        keys.press(KeyCode::KeyV);
        assert!(!cockpit_key(&keys));
        keys.press(KeyCode::ControlLeft);
        assert!(!cockpit_key(&keys));
        keys.press(KeyCode::AltLeft);
        assert!(cockpit_key(&keys));
        keys.clear_just_pressed(KeyCode::KeyV);
        assert!(!cockpit_key(&keys));
        let controls = Controls {
            cockpit: true,
            zoom: 1.0,
            ..Default::default()
        };
        assert_eq!(camera_input(&controls, -1.0, true), (true, 0.0));
        assert_eq!(camera_input(&controls, 4.0, false), (false, 0.0));
    }

    #[test]
    fn pad_camera_buttons_are_edges_and_disconnect_clears_them() {
        let mut app = App::new();
        app.init_resource::<ButtonInput<KeyCode>>();
        app.insert_resource(FlatsRacer {
            enabled: true,
            ..Default::default()
        });
        app.add_systems(Update, sample);
        let window = app
            .world_mut()
            .spawn((
                Window {
                    focused: true,
                    ..default()
                },
                bevy::window::PrimaryWindow,
            ))
            .id();
        let mut pad = Gamepad::default();
        pad.digital_mut().press(GamepadButton::RightThumb);
        pad.digital_mut().press(GamepadButton::DPadUp);
        let entity = app.world_mut().spawn(pad).id();
        app.update();
        let controls = &app.world().resource::<FlatsRacer>().controls;
        assert!(controls.cockpit);
        assert_eq!(controls.zoom, 1.0);
        app.world_mut()
            .get_mut::<Gamepad>(entity)
            .unwrap()
            .digital_mut()
            .clear();
        app.update();
        assert!(!app.world().resource::<FlatsRacer>().controls.cockpit);
        assert_eq!(app.world().resource::<FlatsRacer>().controls.zoom, 0.0);
        app.world_mut().get_mut::<Window>(window).unwrap().focused = false;
        app.world_mut()
            .get_mut::<Gamepad>(entity)
            .unwrap()
            .digital_mut()
            .press(GamepadButton::DPadDown);
        app.update();
        assert_eq!(app.world().resource::<FlatsRacer>().controls.zoom, 0.0);
        app.world_mut().despawn(entity);
        app.update();
        assert!(!app.world().resource::<FlatsRacer>().controls.cockpit);
        assert_eq!(app.world().resource::<FlatsRacer>().controls.zoom, 0.0);
    }

    #[test]
    fn stick_noise_does_not_switch_device_and_axes_reach_full_scale() {
        assert_eq!(axis(0.17, 0.18), 0.0);
        assert_eq!(axis(f32::NAN, 0.18), 0.0);
        assert_eq!(axis(-1.0, 0.18), -1.0);
        assert!(!analog_activity([0.0; 5], [0.02, 0.0, 0.0, 0.0, 0.0]));
        assert!(analog_activity([0.0; 5], [0.5, 0.0, 0.0, 0.0, 0.0]));
        assert!(analog_activity([0.0; 5], [0.0, 0.0, 0.0, 0.5, 0.0]));
        assert!(!analog_activity([0.5; 5], [0.51; 5]));
    }

    #[test]
    fn controller_maps_analog_axes_and_face_shoulder_buttons() {
        let mut pad = Gamepad::default();
        pad.analog_mut().set(GamepadAxis::LeftStickX, -1.0);
        pad.analog_mut().set(GamepadButton::RightTrigger2, 1.0);
        pad.analog_mut().set(GamepadButton::LeftTrigger2, 0.8);
        for button in [
            GamepadButton::South,
            GamepadButton::LeftTrigger,
            GamepadButton::RightTrigger,
        ] {
            pad.digital_mut().press(button);
        }
        let input = read(&pad);
        assert!((input.throttle - 0.2 / 0.92).abs() < 0.00001);
        assert_eq!(input.steer, 1.0);
        assert!(!input.brake && input.jump && input.boost && input.drift);
    }

    #[test]
    fn triggers_cancel_at_equal_pressure_and_reverse_is_analog() {
        let mut pad = Gamepad::default();
        for (forward, reverse, expected) in [
            (0.0, 0.0, 0.0),
            (0.07, 0.08, 0.0),
            (1.0, 1.0, 0.0),
            (0.54, 0.54, 0.0),
            (1.0, 0.0, 1.0),
            (0.0, 1.0, -1.0),
            (0.0, 0.54, -0.5),
            (0.54, 1.0, -0.5),
        ] {
            pad.analog_mut().set(GamepadButton::RightTrigger2, forward);
            pad.analog_mut().set(GamepadButton::LeftTrigger2, reverse);
            let input = read(&pad);
            assert!((input.throttle - expected).abs() < 0.00001);
            assert!(!input.brake);
        }
        pad.analog_mut().set(GamepadAxis::RightStickX, 0.17);
        pad.analog_mut().set(GamepadAxis::RightStickY, -0.18);
        assert_eq!(read_look(&pad), Vec2::ZERO);
        pad.analog_mut().set(GamepadAxis::RightStickX, -1.0);
        pad.analog_mut().set(GamepadAxis::RightStickY, 0.59);
        assert!(read_look(&pad).distance(Vec2::new(-1.0, 0.5)) < 0.00001);
    }

    #[test]
    fn trigger_reverse_moves_from_rest_and_overcomes_forward_momentum_at_all_render_rates() {
        use bevy::ecs::system::RunSystemOnce;
        super::super::collision::tests::fixture()
            .world_mut()
            .run_system_once(|world: benilla_world::collision::WorldCollision| {
                let progress = benilla_world::terrain_stream::WorldLoadProgress {
                    collision_tiles: (31..=33)
                        .flat_map(|x| (31..=33).map(move |y| (x, y)))
                        .collect(),
                    ..Default::default()
                };
                let mut reference = Vec::new();
                for hz in [30, 60, 144] {
                    let mut results = Vec::new();
                    for (forward, reverse, initial_z) in [
                        (0.0, 0.0, 0.0),
                        (1.0, 1.0, 0.0),
                        (0.0, 1.0, 0.0),
                        (0.0, 0.54, 0.0),
                        (1.0, 0.0, 0.0),
                        (0.54, 1.0, 0.0),
                        (0.0, 1.0, -10.0),
                    ] {
                        let mut pad = Gamepad::default();
                        pad.analog_mut().set(GamepadButton::RightTrigger2, forward);
                        pad.analog_mut().set(GamepadButton::LeftTrigger2, reverse);
                        let controls = Controls {
                            device: Device::Controller,
                            pad: read(&pad),
                            ..Default::default()
                        };
                        let input = driving(&ButtonInput::default(), &controls, true);
                        let mut state =
                            flats_racer_physics::State::new([0.0, 1.1, 0.0], 0.0).unwrap();
                        state.velocity[2] = initial_z;
                        let mut accumulator = 0.0;
                        for frame in 0..hz {
                            assert!(!super::super::advance(
                                &mut state,
                                &mut accumulator,
                                input,
                                1.0 / hz as f32,
                                &world,
                                &progress,
                            )
                            .unwrap());
                            // At 144 Hz the first frame has not accumulated a 120 Hz physics tick.
                            if initial_z < 0.0 && frame == 1 {
                                assert!(state.velocity[2] > initial_z && state.velocity[2] < 0.0);
                            }
                        }
                        results.push((state.position[2], state.velocity[2]));
                    }
                    assert_eq!(results[0], (0.0, 0.0));
                    assert_eq!(results[1], (0.0, 0.0));
                    assert!(results[2].0 > 0.0 && results[2].1 > 15.0);
                    assert!((results[3].1 * 2.0 - results[2].1).abs() < 0.0001);
                    assert!((results[4].1 + results[2].1).abs() < 0.0001);
                    assert!((results[5].1 - results[3].1).abs() < 0.0001);
                    assert!(
                        results[6].1 > 0.0,
                        "reverse must cross through zero, not just brake"
                    );
                    if hz == 30 {
                        reference = results;
                    } else {
                        for (actual, expected) in results.iter().zip(&reference) {
                            assert!((actual.0 - expected.0).abs() < 0.0001);
                            assert!((actual.1 - expected.1).abs() < 0.0001);
                        }
                    }
                }
            })
            .unwrap();
    }

    #[test]
    fn keyboard_s_remains_a_brake_and_w_remains_forward_thrust() {
        let controls = Controls::default();
        let mut keys = ButtonInput::default();
        keys.press(KeyCode::KeyS);
        let input = driving(&keys, &controls, true);
        assert!(input.brake);
        assert_eq!(input.throttle, 0.0);
        let mut state = flats_racer_physics::State::new([0.0, 1.1, 0.0], 0.0).unwrap();
        state.velocity[2] = -1.0;
        for _ in 0..120 {
            state
                .step(input, [Some(1.1); 4], flats_racer_physics::FIXED_DT)
                .unwrap();
        }
        assert_eq!(state.velocity[2], 0.0);
        keys.press(KeyCode::KeyW);
        let input = driving(&keys, &controls, true);
        assert!(input.brake);
        assert_eq!(input.throttle, 1.0);
    }

    #[test]
    fn typing_tuning_loading_or_focus_gate_brakes_both_devices() {
        let mut keys = ButtonInput::default();
        keys.press(KeyCode::KeyW);
        for device in [Device::Keyboard, Device::Controller] {
            let controls = Controls {
                device,
                look: Vec2::ONE,
                pad: flats_racer_physics::Input {
                    throttle: 1.0,
                    jump: true,
                    boost: true,
                    ..Default::default()
                },
                ..Default::default()
            };
            let blocked = driving(&keys, &controls, false);
            assert!(blocked.brake);
            assert_eq!(blocked.throttle, 0.0);
            assert!(!blocked.jump && !blocked.boost);
            assert_eq!(looking(&controls, false), Vec2::ZERO);
            assert_eq!(
                looking(&controls, true),
                if device == Device::Controller {
                    Vec2::ONE
                } else {
                    Vec2::ZERO
                }
            );
            assert_eq!(driving(&keys, &controls, true).throttle, 1.0);
        }
    }

    #[test]
    fn last_press_switches_hints_holds_do_not_and_disconnect_returns_keyboard() {
        let mut app = App::new();
        app.init_resource::<ButtonInput<KeyCode>>();
        app.insert_resource(FlatsRacer {
            enabled: true,
            ..Default::default()
        });
        app.add_systems(Update, sample);
        app.world_mut().spawn((
            Window {
                focused: true,
                ..default()
            },
            bevy::window::PrimaryWindow,
        ));
        let mut pad = Gamepad::default();
        pad.analog_mut().set(GamepadAxis::RightStickX, 1.0);
        let entity = app.world_mut().spawn(pad).id();
        app.update();
        assert!(app.world().resource::<FlatsRacer>().controls.device == Device::Controller);
        assert_eq!(app.world().resource::<FlatsRacer>().controls.look, Vec2::X);
        assert_eq!(
            app.world().resource::<FlatsRacer>().controls.pad.throttle,
            0.0
        );
        app.world_mut()
            .get_mut::<Gamepad>(entity)
            .unwrap()
            .digital_mut()
            .clear();
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .press(KeyCode::KeyW);
        app.update();
        assert!(app.world().resource::<FlatsRacer>().controls.device == Device::Keyboard);
        app.world_mut()
            .resource_mut::<ButtonInput<KeyCode>>()
            .clear();
        app.world_mut()
            .get_mut::<Gamepad>(entity)
            .unwrap()
            .digital_mut()
            .press(GamepadButton::North);
        app.world_mut()
            .get_mut::<Gamepad>(entity)
            .unwrap()
            .analog_mut()
            .set(GamepadButton::LeftTrigger2, 1.0);
        for button in [GamepadButton::Start, GamepadButton::Select] {
            app.world_mut()
                .get_mut::<Gamepad>(entity)
                .unwrap()
                .digital_mut()
                .press(button);
        }
        app.update();
        assert!(app.world().resource::<FlatsRacer>().controls.device == Device::Controller);
        let controls = &app.world().resource::<FlatsRacer>().controls;
        assert!(controls.mount && controls.reset && controls.tuning);
        let world = app.world_mut();
        world
            .query::<&mut Window>()
            .single_mut(world)
            .unwrap()
            .focused = false;
        app.update();
        assert!(!app.world().resource::<FlatsRacer>().controls.reset);
        assert!(!app.world().resource::<FlatsRacer>().controls.tuning);
        assert_eq!(
            app.world().resource::<FlatsRacer>().controls.pad.throttle,
            0.0
        );
        assert!(!app.world().resource::<FlatsRacer>().controls.pad.jump);
        assert_eq!(
            app.world().resource::<FlatsRacer>().controls.look,
            Vec2::ZERO
        );
        let world = app.world_mut();
        world
            .query::<&mut Window>()
            .single_mut(world)
            .unwrap()
            .focused = true;
        app.update();
        assert_eq!(app.world().resource::<FlatsRacer>().controls.look, Vec2::X);
        app.world_mut().despawn(entity);
        app.update();
        assert!(app.world().resource::<FlatsRacer>().controls.device == Device::Keyboard);
        assert_eq!(
            app.world().resource::<FlatsRacer>().controls.look,
            Vec2::ZERO
        );
        assert_eq!(
            app.world().resource::<FlatsRacer>().controls.pad.throttle,
            0.0
        );
    }

    #[test]
    fn normal_mode_ignores_controller_sampling() {
        let mut app = App::new();
        app.init_resource::<ButtonInput<KeyCode>>();
        app.insert_resource(FlatsRacer {
            enabled: false,
            ..Default::default()
        });
        app.add_systems(Update, sample);
        app.world_mut().spawn((
            Window {
                focused: true,
                ..default()
            },
            bevy::window::PrimaryWindow,
        ));
        let mut pad = Gamepad::default();
        pad.digital_mut().press(GamepadButton::Start);
        pad.analog_mut().set(GamepadAxis::RightStickX, 1.0);
        pad.analog_mut().set(GamepadButton::LeftTrigger2, 1.0);
        app.world_mut().spawn(pad);
        app.update();
        let controls = &app.world().resource::<FlatsRacer>().controls;
        assert!(controls.device == Device::Keyboard);
        assert!(!controls.mount && !controls.reset && !controls.tuning);
        assert_eq!(controls.look, Vec2::ZERO);
        assert_eq!(controls.pad.throttle, 0.0);
    }
}
