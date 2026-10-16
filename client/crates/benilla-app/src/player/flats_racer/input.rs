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
            Self::Keyboard => "F8 mount/off   F9 safe reset   F10 tuning   W thrust   S brake\\nA/D steer   Shift boost   Ctrl drift   Space hop",
            Self::Controller => "Start/Menu mount/off   Y/Triangle reset   Back/View tuning\\nLeft stick steer   RT/R2 thrust   LT/L2 brake   A/Cross hop\\nRB/R1 boost   LB/L1 drift   (mouse + keyboard for tuning boxes)",
        }
    }
}

#[derive(Default)]
pub(super) struct Controls {
    pub device: Device,
    pub pad: flats_racer_physics::Input,
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
        throttle: axis(pad.get(GamepadButton::RightTrigger2).unwrap_or(0.0), 0.08).max(0.0),
        steer: -axis(pad.left_stick().x, 0.18),
        brake: pad.get(GamepadButton::LeftTrigger2).unwrap_or(0.0) > 0.12,
        boost: pad.pressed(GamepadButton::RightTrigger),
        drift: pad.pressed(GamepadButton::LeftTrigger),
        jump: pad.pressed(GamepadButton::South),
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

fn analog_activity(previous: [f32; 3], current: [f32; 3]) -> bool {
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
    mut previous: Local<HashMap<Entity, [f32; 3]>>,
) {
    if !racer.enabled {
        return;
    }
    let controls = &mut racer.controls;
    controls.mount = false;
    controls.reset = false;
    controls.tuning = false;
    controls.pad = Default::default();
    let focused = windows.iter().any(|window| window.focused);
    controls.tuning = focused && keys.just_pressed(KeyCode::F10);
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
        ];
        let before = previous.insert(entity, analog).unwrap_or([0.0; 3]);
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
                controls.mount = pad.just_pressed(GamepadButton::Start);
                controls.reset = pad.just_pressed(GamepadButton::North);
                controls.tuning |= pad.just_pressed(GamepadButton::Select);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stick_noise_does_not_switch_device_and_axes_reach_full_scale() {
        assert_eq!(axis(0.17, 0.18), 0.0);
        assert_eq!(axis(f32::NAN, 0.18), 0.0);
        assert_eq!(axis(-1.0, 0.18), -1.0);
        assert!(!analog_activity([0.0; 3], [0.02, 0.0, 0.0]));
        assert!(analog_activity([0.0; 3], [0.5, 0.0, 0.0]));
        assert!(!analog_activity([0.5; 3], [0.51; 3]));
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
        assert_eq!(input.throttle, 1.0);
        assert_eq!(input.steer, 1.0);
        assert!(input.brake && input.jump && input.boost && input.drift);
    }

    #[test]
    fn typing_tuning_loading_or_focus_gate_brakes_both_devices() {
        let mut keys = ButtonInput::default();
        keys.press(KeyCode::KeyW);
        for device in [Device::Keyboard, Device::Controller] {
            let controls = Controls {
                device,
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
        pad.digital_mut().press(GamepadButton::South);
        let entity = app.world_mut().spawn(pad).id();
        app.update();
        assert!(app.world().resource::<FlatsRacer>().controls.device == Device::Controller);
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
        app.world_mut().despawn(entity);
        app.update();
        assert!(app.world().resource::<FlatsRacer>().controls.device == Device::Keyboard);
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
        app.world_mut().spawn(pad);
        app.update();
        let controls = &app.world().resource::<FlatsRacer>().controls;
        assert!(controls.device == Device::Keyboard);
        assert!(!controls.mount && !controls.reset && !controls.tuning);
    }
}
