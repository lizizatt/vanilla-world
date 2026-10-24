use super::*;

#[test]
fn heat_damage_only_in_the_overheat_band() {
    assert_eq!(heat_damage_rate(0.0), 0.0);
    assert_eq!(heat_damage_rate(HEAT_WARN), 0.0);
    assert_eq!(heat_damage_rate(HEAT_DAMAGE_START), 0.0);
    assert!((heat_damage_rate(0.95) - HEAT_DAMAGE_PER_SEC / 2.0).abs() < 1e-6);
    assert!((1.0 / heat_damage_rate(1.0) - 6.667).abs() < 0.01, "a whole engine in about 6.7 s at full heat");
}

#[test]
fn impact_damage_ramps_from_safe_speed_to_lethal() {
    assert_eq!(impact_damage(10.0, 100.0), 0.0);
    assert_eq!(impact_damage(IMPACT_SAFE_SPEED, 100.0), 0.0);
    assert!((impact_damage(60.0, 100.0) - 0.5).abs() < 1e-6);
    assert_eq!(impact_damage(100.0, 100.0), 1.0);
    assert_eq!(impact_damage(250.0, 100.0), 1.0);
    assert_eq!(impact_damage(f32::NAN, 100.0), 0.0);
    assert_eq!(impact_damage(50.0, 10.0), 0.0, "a degenerate lethal speed deals no damage");
}

#[test]
fn new_and_reset_states_are_fully_healthy_and_bad_health_is_rejected() {
    let mut s = State::new([0.0; 3], 0.0).unwrap();
    assert_eq!(s.health, [1.0, 1.0]);
    s.health = [0.2, 0.0];
    s.reset([0.0; 3], 0.0).unwrap();
    assert_eq!(s.health, [1.0, 1.0]);
    let mut bad = s;
    bad.health[1] = 1.5;
    assert!(!bad.valid());
}
