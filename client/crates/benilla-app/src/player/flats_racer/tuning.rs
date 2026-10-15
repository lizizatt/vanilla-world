//! Session-only racer tuning through the existing FrameXML EditBox bridge.

use super::*;
use flats_racer_physics::Tuning;

const LABELS: [&str; 17] = [
    "Speed cap (yd/s)",
    "Boost cap (yd/s)",
    "Thrust (yd/s2)",
    "Boost thrust (yd/s2)",
    "Braking (yd/s2)",
    "Drag (1/s)",
    "Turn rate (rad/s)",
    "Turn response (1/s)",
    "Grip (1/s)",
    "Drift grip (1/s)",
    "Drift turn multiplier",
    "Hover height (yd)",
    "Hover spring",
    "Hover damping",
    "Gravity (yd/s2)",
    "Hop speed (yd/s)",
    "Air steering fraction",
];

fn values(t: &Tuning) -> [f32; 17] {
    [
        t.max_speed,
        t.boost_max_speed,
        t.acceleration,
        t.boost_acceleration,
        t.braking,
        t.drag,
        t.turn_rate,
        t.turn_response,
        t.grip,
        t.drift_grip,
        t.drift_turn_multiplier,
        t.hover_height,
        t.spring,
        t.damping,
        t.gravity,
        t.hop_speed,
        t.air_control,
    ]
}

fn parse(text: &str) -> Result<Tuning, String> {
    let parts: Vec<_> = text.split('|').collect();
    if parts.len() != 17 {
        return Err("Expected 17 numeric fields; no changes applied.".into());
    }
    let mut v = [0.0; 17];
    for (index, text) in parts.iter().enumerate() {
        v[index] = text
            .trim()
            .parse::<f32>()
            .ok()
            .filter(|v| v.is_finite())
            .ok_or_else(|| format!("{}: enter a finite number.", LABELS[index]))?;
    }
    let tuning = Tuning {
        max_speed: v[0],
        boost_max_speed: v[1],
        acceleration: v[2],
        boost_acceleration: v[3],
        braking: v[4],
        drag: v[5],
        turn_rate: v[6],
        turn_response: v[7],
        grip: v[8],
        drift_grip: v[9],
        drift_turn_multiplier: v[10],
        hover_height: v[11],
        spring: v[12],
        damping: v[13],
        gravity: v[14],
        hop_speed: v[15],
        air_control: v[16],
    };
    tuning
        .validate()
        .map_err(|error| format!("{error:?}; no changes applied."))?;
    Ok(tuning)
}

fn fill(script: &UiScript, tuning: &Tuning) {
    for (index, value) in values(tuning).iter().enumerate() {
        crate::ui_script::run_or_warn(
            script,
            &format!("FlatsRacerTuneBox{}:SetText(\"{value}\")", index + 1),
        );
    }
}

pub(super) fn update(script: &UiScript, racer: &mut FlatsRacer) {
    if let Err(error) = script.run(include_str!("tuning.lua")) {
        warn!("flats racer tuning: cannot create panel: {error}");
        return;
    }
    let initialized = match script.eval::<bool>("return FlatsRacerTuneInitialized == true") {
        Ok(initialized) => initialized,
        Err(error) => {
            warn!("flats racer tuning: cannot initialize panel: {error}");
            return;
        }
    };
    if !initialized {
        let labels = LABELS
            .iter()
            .enumerate()
            .map(|(index, label)| format!("FlatsRacerTuneLabel{}:SetText(\"{label}\")", index + 1))
            .collect::<Vec<_>>()
            .join("\n");
        crate::ui_script::run_or_warn(script, &labels);
        fill(script, &racer.tuning);
        crate::ui_script::run_or_warn(script, "FlatsRacerTuneInitialized=true");
    }
    let command = match script
        .eval::<Option<String>>("local c=FlatsRacerTuneCommand FlatsRacerTuneCommand=nil return c")
    {
        Ok(command) => command,
        Err(error) => {
            warn!("flats racer tuning: cannot read UI command: {error}");
            return;
        }
    };
    match command.as_deref() {
        Some("apply") => {
            let result = script.eval::<String>(
                "local v={} for i=1,17 do v[i]=getglobal('FlatsRacerTuneBox'..i):GetText() end return table.concat(v,'|')"
            ).map_err(|error| format!("Cannot read tuning fields: {error}")).and_then(|text| parse(&text));
            let message = match result {
                Ok(tuning) => {
                    racer.tuning = tuning;
                    fill(script, &racer.tuning);
                    "Applied. Close to drive; values last until client exit.".to_string()
                }
                Err(error) => {
                    warn!("flats racer tuning: {error}");
                    error
                }
            };
            // Error text contains only our labels/numbers and Rust's validation messages.
            let message = message
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace(['\n', '\r'], " ");
            crate::ui_script::run_or_warn(
                script,
                &format!("FlatsRacerTuneStatus:SetText(\"{message}\")"),
            );
        }
        Some("defaults") => {
            racer.tuning = Tuning::default();
            fill(script, &racer.tuning);
            crate::ui_script::run_or_warn(
                script,
                "FlatsRacerTuneStatus:SetText('Defaults restored and applied.')",
            );
        }
        Some("close") => racer.tuning_open = false,
        Some("toggle") => racer.tuning_open = !racer.tuning_open,
        Some(other) => warn!("flats racer tuning: unknown UI command {other:?}"),
        None => {}
    }
    crate::ui_script::run_or_warn(
        script,
        if racer.tuning_open {
            "FlatsRacerTuning:Show()"
        } else {
            "for i=1,17 do getglobal('FlatsRacerTuneBox'..i):ClearFocus() end FlatsRacerTuning:Hide()"
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tuning_fields_round_trip_and_invalid_values_do_not_change_active_tuning() {
        let default = Tuning::default();
        let text = values(&default).map(|v| v.to_string()).join("|");
        assert_eq!(parse(&text).unwrap(), default);
        assert!(parse(&text.replacen("36", "NaN", 1)).is_err());
        assert!(parse("oops").is_err());
        let mut fields = values(&default);
        fields[0] = 51.0;
        assert!(parse(&fields.map(|v| v.to_string()).join("|")).is_err());
    }

    #[test]
    fn real_editboxes_apply_atomically_restore_defaults_and_release_focus() {
        let mut script = UiScript::new().unwrap();
        script
            .run(r#"CreateFont("GameFontNormal"):SetFont("Fonts\\FRIZQT__.TTF", 12)"#)
            .unwrap();
        let mut racer = FlatsRacer {
            tuning_open: true,
            ..Default::default()
        };
        script.run(include_str!("tuning.lua")).unwrap();
        update(&script, &mut racer);
        assert!(script.errors().is_empty(), "{:?}", script.errors());
        assert!(script.focus_editbox("FlatsRacerTuneBox1"));
        script.run("FlatsRacerTuneBox1:HighlightText()").unwrap();
        assert!(script.char_input("28"));
        assert!(script.key_input("ENTER"));
        update(&script, &mut racer);
        assert_eq!(racer.tuning.max_speed, 28.0);
        assert!(!script.has_keyboard_focus());
        assert!(script.focus_editbox("FlatsRacerTuneBox1"));
        assert!(script.key_input("TAB"));
        assert_eq!(
            script.focused_editbox_name().as_deref(),
            Some("FlatsRacerTuneBox2")
        );
        script
            .run("FlatsRacerTuneBox1:SetText('500') FlatsRacerTuneCommand='apply'")
            .unwrap();
        update(&script, &mut racer);
        assert_eq!(racer.tuning.max_speed, 28.0);
        assert!(script
            .eval::<String>("return FlatsRacerTuneStatus:GetText()")
            .unwrap()
            .contains("no changes"));
        script.run("FlatsRacerTuneCommand='defaults'").unwrap();
        update(&script, &mut racer);
        assert_eq!(racer.tuning, Tuning::default());
        assert!(script.key_input("ESCAPE"));
        update(&script, &mut racer);
        assert!(!racer.tuning_open);
        assert!(!script
            .eval::<bool>("return FlatsRacerTuning:IsShown()")
            .unwrap());
        assert!(script.errors().is_empty(), "{:?}", script.errors());
    }
}
