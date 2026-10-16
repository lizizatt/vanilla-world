//! Saved custom racer tuning through the existing FrameXML EditBox bridge.

use super::*;
use flats_racer_physics::Tuning;

const LABELS: [&str; 18] = [
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
    "Air control multiplier",
    "Camera position (s)",
];

fn values(t: &Tuning, camera_seconds: f32) -> [f32; 18] {
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
        camera_seconds,
    ]
}

fn parse(text: &str) -> Result<(Tuning, f32), String> {
    let parts: Vec<_> = text.split('|').collect();
    if parts.len() != LABELS.len() {
        return Err("Expected 18 numeric fields; no changes applied.".into());
    }
    let mut v = [0.0; 18];
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
    if v[17] < 0.0 {
        return Err("Camera position seconds must be nonnegative; no changes applied.".into());
    }
    Ok((tuning, v[17]))
}

fn render(tuning: &Tuning, camera_seconds: f32) -> String {
    values(tuning, camera_seconds)
        .map(|value| value.to_string())
        .join("|")
}

fn load_path(path: &std::path::Path) -> Result<Option<(Tuning, f32)>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read {}: {error}", path.display())),
    }
}

pub(super) fn load() -> Result<Option<(Tuning, f32)>, String> {
    crate::local_state::racer_tuning_path().map_or(Ok(None), |path| load_path(&path))
}

fn apply(
    racer: &mut FlatsRacer,
    tuning: Tuning,
    camera_seconds: f32,
    path: Option<&std::path::Path>,
) -> Result<&'static str, String> {
    let text = render(&tuning, camera_seconds);
    if let Some(path) = path {
        crate::local_state::write_atomic(path, &text).map_err(|error| {
            format!(
                "Cannot save {}: {error}; no changes applied.",
                path.display()
            )
        })?;
    }
    racer.tuning = tuning;
    racer.camera_position_seconds = camera_seconds;
    info!("racer tuning applied (18 fields in panel order): {text}");
    Ok(if path.is_some() {
        "Applied and saved. Close to drive."
    } else {
        "Applied; persistence disabled for this capture/test."
    })
}

fn fill(script: &UiScript, racer: &FlatsRacer) {
    for (index, value) in values(&racer.tuning, racer.camera_position_seconds)
        .iter()
        .enumerate()
    {
        // Scientific notation fits every finite f32 in the text field without truncation.
        let text = value.to_string();
        let text = if text.len() > 14 {
            format!("{value:e}")
        } else {
            text
        };
        crate::ui_script::run_or_warn(
            script,
            &format!("FlatsRacerTuneBox{}:SetText(\"{text}\")", index + 1),
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
        fill(script, racer);
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
                "local v={} for i=1,18 do v[i]=getglobal('FlatsRacerTuneBox'..i):GetText() end return table.concat(v,'|')"
            ).map_err(|error| format!("Cannot read tuning fields: {error}")).and_then(|text| parse(&text));
            let path = crate::local_state::racer_tuning_path();
            let message = match result
                .and_then(|(tuning, seconds)| apply(racer, tuning, seconds, path.as_deref()))
            {
                Ok(message) => {
                    fill(script, racer);
                    message.to_string()
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
            match apply(
                racer,
                Tuning::default(),
                camera::DEFAULT_POSITION_SECONDS,
                crate::local_state::racer_tuning_path().as_deref(),
            ) {
                Ok(message) => {
                    fill(script, racer);
                    crate::ui_script::run_or_warn(
                        script,
                        &format!("FlatsRacerTuneStatus:SetText('{message}')"),
                    );
                }
                Err(error) => {
                    warn!("racer tuning: {error}");
                    crate::ui_script::run_or_warn(script,
                        "FlatsRacerTuneStatus:SetText('Cannot save defaults; no changes applied. See client log.')");
                }
            }
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
            "for i=1,18 do getglobal('FlatsRacerTuneBox'..i):ClearFocus() end FlatsRacerTuning:Hide()"
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applied_tuning_survives_restart_and_write_failure_keeps_previous_state() {
        let root = std::env::temp_dir().join(format!("racer-tuning-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("racer-tuning.txt");
        let mut racer = FlatsRacer::default();
        let tuning = Tuning {
            max_speed: 800.0,
            boost_max_speed: 1200.0,
            acceleration: 150.0,
            ..Default::default()
        };
        apply(&mut racer, tuning, 0.4, Some(&path)).unwrap();
        assert_eq!(load_path(&path).unwrap(), Some((tuning, 0.4)));
        let blocker = root.join("not-a-directory");
        std::fs::write(&blocker, "block").unwrap();
        assert!(apply(
            &mut racer,
            Tuning::default(),
            0.0,
            Some(&blocker.join("tuning"))
        )
        .is_err());
        assert_eq!(racer.tuning, tuning);
        assert_eq!(racer.camera_position_seconds, 0.4);
        assert_eq!(load_path(&path).unwrap(), Some((tuning, 0.4)));
        std::fs::write(&path, "NaN|invalid").unwrap();
        assert!(load_path(&path).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_file(&blocker).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn tuning_fields_round_trip_and_invalid_values_do_not_change_active_tuning() {
        let default = Tuning::default();
        let seconds = camera::DEFAULT_POSITION_SECONDS;
        let text = values(&default, seconds).map(|v| v.to_string()).join("|");
        assert_eq!(parse(&text).unwrap(), (default, seconds));
        assert!(parse(&text.replacen("36", "NaN", 1)).is_err());
        assert!(parse("oops").is_err());
        let mut fields = values(&default, seconds);
        fields[0] = 500.0;
        fields[1] = 1000.0;
        fields[17] = 0.0;
        let high = parse(&fields.map(|v| v.to_string()).join("|")).unwrap();
        assert_eq!(
            (high.0.max_speed, high.0.boost_max_speed, high.1),
            (500.0, 1000.0, 0.0)
        );
        fields[17] = -0.1;
        assert!(parse(&fields.map(|v| v.to_string()).join("|")).is_err());
        fields[0] = f32::MAX;
        fields[1] = f32::MAX;
        fields[17] = f32::MAX;
        let high = parse(&fields.map(|v| format!("{v:e}")).join("|")).unwrap();
        assert_eq!(high.0.max_speed, f32::MAX);
        assert_eq!(high.1, f32::MAX);
        for invalid in ["NaN", "inf", "-inf", "1e100", "-0.1"] {
            let mut fields = values(&default, seconds).map(|v| v.to_string());
            fields[17] = invalid.into();
            assert!(parse(&fields.join("|")).is_err(), "{invalid}");
        }
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
        script.run("FlatsRacerTuneBox1:SetText('500') FlatsRacerTuneBox2:SetText('1000') FlatsRacerTuneBox18:SetText('0.35') FlatsRacerTuneCommand='apply'").unwrap();
        update(&script, &mut racer);
        assert_eq!(racer.tuning.max_speed, 500.0);
        assert_eq!(racer.camera_position_seconds, 0.35);
        let before = racer.tuning;
        script.run("FlatsRacerTuneBox1:SetText('600') FlatsRacerTuneBox18:SetText('-1') FlatsRacerTuneCommand='apply'").unwrap();
        update(&script, &mut racer);
        assert_eq!(racer.tuning, before);
        assert_eq!(racer.camera_position_seconds, 0.35);
        script.run("FlatsRacerTuneCommand='defaults'").unwrap();
        update(&script, &mut racer);
        assert_eq!(racer.tuning, Tuning::default());
        assert_eq!(
            racer.camera_position_seconds,
            camera::DEFAULT_POSITION_SECONDS
        );
        assert!(script.key_input("ESCAPE"));
        update(&script, &mut racer);
        assert!(!racer.tuning_open);
        assert!(!script
            .eval::<bool>("return FlatsRacerTuning:IsShown()")
            .unwrap());
        assert!(script.errors().is_empty(), "{:?}", script.errors());
    }
}
