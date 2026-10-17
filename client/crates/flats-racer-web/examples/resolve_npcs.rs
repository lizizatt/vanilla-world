//! Resolve a private spawn export against the user's Data. Writes no game assets or repository files.
use std::{collections::HashSet, fs::OpenOptions, io::Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err(
            "Usage: resolve_npcs <Data directory> <private input.json> <private output.json>"
                .into(),
        );
    }
    let mut pack: serde_json::Value = serde_json::from_reader(std::fs::File::open(&args[2])?)?;
    let mut chain = benilla_formats::Chain::open(std::path::Path::new(&args[1]))?;
    let catalog = benilla_formats::load_creature_catalog(&mut chain)?;
    let spawns = pack["spawns"].as_array_mut().ok_or("Missing spawns")?;
    let mut models = serde_json::Map::new();
    let ids: HashSet<u32> = spawns
        .iter()
        .filter_map(|s| s["displayId"].as_u64().map(|id| id as u32))
        .collect();
    for id in ids {
        let Some(model) = catalog.model(id) else {
            continue;
        };
        let mut skins = model.textures.to_vec();
        skins.push(
            model
                .npc_appearance
                .as_ref()
                .and_then(|a| a.bake_name.as_ref())
                .map(|name| format!("Textures\\BakedNpcTextures\\{name}")),
        );
        models.insert(id.to_string(), serde_json::json!({
            "path":model.model_path, "scale":model.scale, "skins":skins,
            "appearance":if model.npc_appearance.is_some() { "baked-body-no-equipment" } else { "creature-bind-pose" }
        }));
    }
    let before = spawns.len();
    spawns.retain(|s| models.contains_key(&s["displayId"].to_string()));
    let after = spawns.len();
    pack["models"] = serde_json::Value::Object(models);
    pack["provenance"]["unresolvedDisplays"] = (before - after).into();
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[3])?;
    serde_json::to_writer(&mut output, &pack)?;
    output.flush()?;
    println!(
        "Resolved {after} static spawns, {} model displays; {} absent displays omitted",
        pack["models"].as_object().unwrap().len(),
        before - after
    );
    Ok(())
}
