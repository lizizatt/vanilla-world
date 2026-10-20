use benilla_formats::{load_area_sound_catalog, load_sound_kit_catalog, Chain};
use std::collections::BTreeSet;

/// Local-Data audit of zone-music coverage; run with `BENILLA_REQUIRE_DATA=1 -- --ignored --nocapture`.
#[test]
#[ignore]
fn zone_music_coverage() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = Chain::open(&data).unwrap();
    let areas = load_area_sound_catalog(&mut chain).unwrap();
    let kits = load_sound_kit_catalog(&mut chain).unwrap();
    let (mut total, mut music, mut none, mut oceanish, mut oceanish_music) = (0, 0, 0, 0, 0);
    let mut sets = BTreeSet::new();
    let mut files = BTreeSet::new();
    let mut missing = BTreeSet::new();
    let mut silence = Vec::new();
    for id in 0..5000u32 {
        let Some(a) = areas.resolve(id) else { continue };
        let name = a.area_name.to_lowercase();
        let ocean = ["sea", "ocean", "maelstrom", "gulf", "bay"]
            .iter()
            .any(|w| name.contains(w));
        total += 1;
        oceanish += ocean as u32;
        match a.music {
            Some(m) => {
                music += 1;
                oceanish_music += ocean as u32;
                if sets.insert(m.id) {
                    silence.push((m.set_name.clone(), m.silence_min, m.silence_max, m.sounds));
                    for kit in m.sounds {
                        if let Some(k) = kits.get(kit) {
                            for (f, _) in &k.files {
                                files.insert(f.clone());
                                if chain.read_file(f).is_err() {
                                    missing.insert(f.clone());
                                }
                            }
                        }
                    }
                }
            }
            None => {
                none += 1;
                if ocean {
                    println!("ocean area without music: {id} {}", a.area_name);
                }
            }
        }
    }
    println!("areas={total} withMusic={music} noMusic={none} oceanNamed={oceanish} oceanNamedWithMusic={oceanish_music}");
    println!("music sets={} files={} missing={}", sets.len(), files.len(), missing.len());
    if let Some(m) = areas.zone_music(9) {
        for kit in m.sounds {
            println!("set 9 kit {kit}: {:?}", kits.get(kit).map(|k| k.files.iter().map(|f| f.0.rsplit('\\').next().unwrap().to_string()).collect::<Vec<_>>()));
        }
    }
    for s in silence.iter().take(6) {
        println!("sample {s:?}");
    }
    for f in files.iter().take(4) {
        println!("file {f}");
    }
}
