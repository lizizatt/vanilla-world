//! Deviation: compact, original cockpit-style instruments for the custom racer.

use super::*;

pub(super) fn update(
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
        crate::ui_script::run_or_warn(&script, "if FlatsRacerHUD then FlatsRacerHUD:Hide() end if FlatsRacerTuning then for i=1,18 do getglobal('FlatsRacerTuneBox'..i):ClearFocus() end FlatsRacerTuning:Hide() end");
        return;
    }
    tuning::update(&script, &mut racer);
    if let Err(error) = draw(&script, &racer) {
        warn!("flats racer instruments: {error}");
    }
}

fn draw(script: &UiScript, racer: &FlatsRacer) -> Result<(), String> {
    script
        .run(include_str!("hud.lua"))
        .map_err(|error| error.to_string())?;
    let direction = racer.dynamics.as_ref().map_or("IDLE", |state| {
        let forward = -state.velocity[0] * state.yaw.sin() - state.velocity[2] * state.yaw.cos();
        if forward < -0.1 {
            "REV"
        } else if forward > 0.1 {
            "FWD"
        } else {
            "IDLE"
        }
    });
    let state = if !racer.authorized {
        "STANDBY"
    } else if racer.status == "Waiting for streamed collision" {
        "COLLISION HOLD"
    } else if racer.dynamics.is_some_and(|state| !state.grounded) {
        "AIRBORNE"
    } else {
        "HOVER"
    };
    let speed = racer.speed.max(0.0);
    let fraction = if racer.tuning.boost_max_speed > 0.0 {
        (speed / racer.tuning.boost_max_speed).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let hint = match (racer.controls.device, racer.authorized) {
        (input::Device::Keyboard, true) => {
            "F8 DISMOUNT   /   F9 SAFE RESET\nF10 TUNING   /   CONTROLS FOR INPUT GUIDE"
        }
        (input::Device::Keyboard, false) => "F8 TO MOUNT   /   F10 TUNING\nLOCAL WORLD EXPLORATION",
        (input::Device::Controller, true) => {
            "START DISMOUNT   /   Y SAFE RESET\nBACK TUNING   /   CONTROLS FOR INPUT GUIDE"
        }
        (input::Device::Controller, false) => {
            "START TO MOUNT   /   BACK TUNING\nLOCAL WORLD EXPLORATION"
        }
    };
    // Lua 5.0 has no `...` expression; these quoted labels are all client-owned static text.
    script
        .run(&format!(
            "FlatsRacerHUDUpdate({speed}, {fraction}, {}, {direction:?}, {state:?}, {:?}, {hint:?}, {:?})",
            racer.boost.clamp(0.0, 1.0),
            racer.status,
            racer.controls.device.tutorial().replace("\\n", "\n"),
        ))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn racer_instruments_show_real_motion_reserve_and_hold_without_taking_keyboard_focus() {
        let script = UiScript::new().unwrap();
        let mut racer = FlatsRacer {
            authorized: true,
            speed: 42.0,
            boost: 0.5,
            status: "Hovering",
            ..Default::default()
        };
        let mut dynamics = flats_racer_physics::State::new([0.0; 3], 0.0).unwrap();
        dynamics.velocity = [0.0, 0.0, 42.0];
        dynamics.grounded = true;
        racer.dynamics = Some(dynamics);
        draw(&script, &racer).unwrap();
        assert_eq!(
            script
                .eval::<String>("return FlatsRacerHUDSpeed:GetText()")
                .unwrap(),
            "042"
        );
        assert_eq!(
            script
                .eval::<String>("return FlatsRacerHUDDirection:GetText()")
                .unwrap(),
            "REV"
        );
        assert_eq!(
            script
                .eval::<String>("return FlatsRacerHUDBoost:GetText()")
                .unwrap(),
            "50%"
        );
        assert!(!script.has_keyboard_focus());
        assert!(!script
            .eval::<bool>("return FlatsRacerHUD:IsMouseEnabled()")
            .unwrap());
        assert!(script
            .eval::<bool>("return FlatsRacerTuneToggle:IsMouseEnabled()")
            .unwrap());
        assert_eq!(
            script
                .eval::<f32>("return FlatsRacerHUD.boostSegments[6]:GetAlpha()")
                .unwrap(),
            1.0
        );
        assert!(
            (script
                .eval::<f32>("return FlatsRacerHUD.boostSegments[7]:GetAlpha()")
                .unwrap()
                - 0.15)
                .abs()
                < 0.001
        );
        racer.status = "Waiting for streamed collision";
        draw(&script, &racer).unwrap();
        assert_eq!(
            script
                .eval::<String>("return FlatsRacerHUDState:GetText()")
                .unwrap(),
            "COLLISION HOLD"
        );
        racer.authorized = false;
        draw(&script, &racer).unwrap();
        assert_eq!(
            script
                .eval::<String>("return FlatsRacerHUDState:GetText()")
                .unwrap(),
            "STANDBY"
        );
        assert!(script.errors().is_empty(), "{:?}", script.errors());
    }
}
