use super::*;

#[test]
fn actual_creature_actor_poses_stand_loop_finitely_and_moves() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let mut built = 0;
    for path in [
        "Creature\\Wolf\\Wolf.m2",
        "Creature\\Boar\\Boar.m2",
        "Creature\\Rabbit\\Rabbit.m2",
        "Creature\\Deer\\Deer.m2",
        "Creature\\HumanMaleGuard\\HumanMaleGuard.m2",
    ] {
        let Ok(bytes) = chain.read_file(path) else {
            continue;
        };
        let Ok(actor) = SceneActor::decode(&bytes, path, "[]", None) else {
            continue;
        };
        built += 1;
        let model = SceneModel::from_m2(&bytes, path, "[]").unwrap();
        assert_eq!(actor.vertices.len(), model.vertices.len());
        let duration = actor.rig.duration(0).unwrap();
        let mut first = actor.vertices.clone();
        actor
            .rig
            .pose_into(&actor.bind, 0, 0.0, &mut first)
            .unwrap();
        let mut mid = actor.vertices.clone();
        actor
            .rig
            .pose_into(&actor.bind, 0, duration * 0.5, &mut mid)
            .unwrap();
        let mut wrapped = actor.vertices.clone();
        actor
            .rig
            .pose_into(&actor.bind, 0, duration * 3.0, &mut wrapped)
            .unwrap();
        assert!(first.iter().chain(&mid).all(|v| v.is_finite()));
        assert!(first
            .iter()
            .zip(&wrapped)
            .all(|(a, b)| (a - b).abs() < 1e-3));
        // UVs and colours are never touched.
        for v in 0..first.len() / 12 {
            assert_eq!(
                first[v * 12 + 6..v * 12 + 12],
                model.vertices[v * 12 + 6..v * 12 + 12]
            );
        }
        assert!(
            first.iter().zip(&mid).any(|(a, b)| (a - b).abs() > 1e-4),
            "{path} did not move"
        );
    }
    assert!(built > 0, "no probe creature produced an actor");
}

#[test]
fn actual_racer_display_keeps_complete_model_and_authored_seat_without_inventing_rider() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let models = chain
        .read_file("DBFilesClient\\CreatureModelData.dbc")
        .unwrap();
    let displays = chain
        .read_file("DBFilesClient\\CreatureDisplayInfo.dbc")
        .unwrap();
    let display: serde_json::Value =
        serde_json::from_str(&craft_display(&models, &displays).unwrap()).unwrap();
    assert_eq!(display["display"], 10318);
    assert_eq!(display["scale"], 1.0);
    assert_eq!(
        display["path"],
        "Creature\\GoblinRocketCar\\GoblinRocketCar.mdx"
    );
    let native = benilla_formats::load_creature_catalog(&mut chain)
        .unwrap()
        .model(10318)
        .unwrap();
    assert_eq!(display["path"], native.model_path);
    let bytes = chain
        .read_file("Creature\\GoblinRocketCar\\GoblinRocketCar.m2")
        .unwrap();
    let metadata: serde_json::Value =
        serde_json::from_str(&craft_metadata(&bytes).unwrap()).unwrap();
    assert_eq!(metadata["attachment0"]["bone"], 74);
    assert_eq!(metadata["cockpitAvailable"], false);
    assert!(metadata.get("riderHeadHeight").is_none());
    let model = SceneModel::from_m2(
        &bytes,
        "Creature\\GoblinRocketCar\\GoblinRocketCar.m2",
        &display["skins"].to_string(),
    )
    .unwrap();
    assert_eq!(model.indices.len() / 3, 1566);
    let batches: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
    assert_eq!(batches["batches"].as_array().unwrap().len(), 6);
    for batch in batches["batches"].as_array().unwrap() {
        let texture = batch["texture"].as_str().unwrap();
        SceneTexture::decode(&chain.read_file(texture).unwrap()).unwrap();
    }
    assert!(craft_display(b"bad", b"bad").is_err());
    assert!(craft_metadata(b"bad").is_err());
}

#[test]
fn actual_craft_stand_uses_sequence_start_and_each_weighted_root_not_a_mesh_yaw() {
    use benilla_formats::{bake_m2_stand_pose, parse_m2_animations, parse_m2_skeleton};
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let path = "Creature\\GoblinRocketCar\\GoblinRocketCar.m2";
    let bytes = chain.read_file(path).unwrap();
    let skeleton = parse_m2_skeleton(&bytes).unwrap();
    let animations = parse_m2_animations(&bytes);
    let stand = animations.iter().find(|a| a.anim_id == 0).unwrap();
    assert_eq!(
        (stand.seq_index, stand.start_ms, stand.end_ms),
        (0, 3333, 6667)
    );
    let root0 = stand.bones.iter().find(|k| k.bone == 0).unwrap();
    let root1 = stand.bones.iter().find(|k| k.bone == 1).unwrap();
    assert_eq!(root0.rotation[0].0, 0.0);
    assert!((root0.rotation[0].1[2] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    assert_eq!(root1.translation[0], (0.0, [-3.1643076, 0.0, 0.8874265]));

    // Independent point walk: child pivot/keys first, then its ancestors in raw M2 axes.
    let reference = |mut p: [f32; 3], mut bone: usize, point: bool| loop {
        let b = skeleton.bones[bone];
        let keys = stand.bones.iter().find(|k| k.bone as usize == bone);
        let scale = keys.and_then(|k| k.scale.first()).map_or([1.0; 3], |k| k.1);
        let translation = keys
            .and_then(|k| k.translation.first())
            .map_or([0.0; 3], |k| k.1);
        let mut q = keys
            .and_then(|k| k.rotation.first())
            .map_or([0.0, 0.0, 0.0, 1.0], |k| k.1);
        let length = q.iter().map(|x| x * x).sum::<f32>().sqrt();
        for x in &mut q {
            *x /= length;
        }
        for i in 0..3 {
            p[i] = (p[i] - if point { b.pivot[i] } else { 0.0 }) * scale[i];
        }
        let cross = |a: [f32; 3], b: [f32; 3]| {
            [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ]
        };
        let v = [q[0], q[1], q[2]];
        let c = cross(v, p);
        let cc = cross(v, c);
        for i in 0..3 {
            p[i] += 2.0 * (q[3] * c[i] + cc[i])
                + if point {
                    b.pivot[i] + translation[i]
                } else {
                    0.0
                };
        }
        if b.parent < 0 {
            return p;
        }
        bone = b.parent as usize;
    };
    let raw = parse_m2_render_submeshes(&bytes, "Creature\\GoblinRocketCar", &[]).unwrap();
    let mut baked = raw.clone();
    let seat = bake_m2_stand_pose(&bytes, &mut baked).unwrap().unwrap();
    let mut weighted = 0;
    for (raw, baked) in raw.iter().zip(&baked) {
        assert_eq!(raw.indices, baked.indices);
        assert_eq!(raw.uvs, baked.uvs);
        assert_eq!(raw.texture, baked.texture);
        for i in 0..raw.positions.len() {
            weighted += usize::from(raw.weights[i].iter().filter(|&&w| w > 0.0).count() > 1);
            for (input, actual, point) in [
                (raw.positions[i], baked.positions[i], true),
                (raw.normals[i], baked.normals[i], false),
            ] {
                let mut expected = [0.0; 3];
                for (&bone, &weight) in raw.joints[i].iter().zip(&raw.weights[i]) {
                    if weight == 0.0 {
                        continue;
                    }
                    let p = reference(input, bone as usize, point);
                    for j in 0..3 {
                        expected[j] += p[j] * weight;
                    }
                }
                if !point {
                    let length = expected.iter().map(|x| x * x).sum::<f32>().sqrt();
                    for x in &mut expected {
                        *x /= length;
                    }
                }
                for j in 0..3 {
                    assert!(
                        (expected[j] - actual[j]).abs() < 1e-4,
                        "{expected:?} != {actual:?}"
                    );
                }
            }
        }
    }
    assert!(
        weighted > 100,
        "Exercise the goblin's multi-bone skin, not only rigid chassis"
    );
    let model = SceneModel::decode_m2(&bytes, path, "[]", true, None).unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
    assert_eq!(metadata["animation"], "stand-frame-0");
    assert_eq!(model.indices.len() / 3, 1566);
    let bounds = &metadata["bounds"];
    let length = bounds[1][0].as_f64().unwrap() - bounds[0][0].as_f64().unwrap();
    let width = bounds[1][1].as_f64().unwrap() - bounds[0][1].as_f64().unwrap();
    assert!(
        length > width * 1.5,
        "Posed chassis must run along model X: {bounds}"
    );
    let raw_seat = benilla_formats::parse_m2_attachments(&bytes)
        .unwrap()
        .into_iter()
        .find(|a| a.id == 0)
        .unwrap();
    let expected = reference(raw_seat.position, raw_seat.bone as usize, true);
    for (actual, expected) in seat.position.iter().zip(expected) {
        assert!((actual - expected).abs() < 1e-5);
    }
    let mut malformed = raw.clone();
    malformed[0].joints[0] = [255; 4];
    assert!(bake_m2_stand_pose(&bytes, &mut malformed).is_err());
}

#[test]
fn rejects_corrupt_and_oversize_inputs() {
    assert!(placements(b"bad").is_err());
    assert!(SceneModel::from_m2(b"bad", "bad.m2", "[]").is_err());
    assert!(SceneRoot::from_bytes(b"bad").is_err());
    assert!(SceneTexture::decode(b"bad").is_err());
    assert!(validate_mesh(&[[0.0; 3]], &[0, 1, 0]).is_err());
    assert!(validate_mesh(&[[f32::NAN; 3]], &[]).is_err());
    assert!(validate_mesh(&[[0.0; 3]], &[0]).is_err());
}

#[test]
fn authored_terrain_material_streams_match_native_layers_masks_normals_and_holes() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let mut layered = 0;
    let mut shadowed = 0;
    let mut holes = 0;
    let mut colored_textures = 0;
    for (map, x, y) in [
        ("Kalimdor", 39, 43),
        ("Azeroth", 32, 48),
        ("Azeroth", 30, 48),
        ("Kalimdor", 40, 30),
    ] {
        let bytes = chain
            .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
            .unwrap();
        let tile = adt_to_tile_mesh(&bytes).unwrap();
        let material = TerrainMaterial::build(&tile, x, y).unwrap();
        let mut staged = TerrainMaterial::begin(&tile, x, y).unwrap();
        for chunk in 0..tile.chunks.len() {
            assert_eq!(
                staged.step(&tile, x, y).unwrap(),
                chunk + 1 == tile.chunks.len()
            );
            assert_eq!(staged.masks.len(), (chunk + 1) * 16384);
        }
        assert!(staged.step(&tile, x, y).unwrap());
        assert!(staged.step(&tile, x + 1, y).is_err());
        assert_eq!(staged.vertices, material.vertices);
        assert_eq!(staged.indices, material.indices);
        assert_eq!(staged.masks, material.masks);
        assert_eq!(staged.paths, material.paths);
        assert_eq!(
            material.indices.len(),
            tile.chunks.iter().map(|c| c.indices.len()).sum::<usize>()
        );
        assert_eq!(material.vertices.len(), tile.vertex_count() * 13);
        assert_eq!(material.masks.len(), tile.chunks.len() * 16384);
        let mut vertex = 0;
        let mut index = 0;
        for (id, chunk) in tile.chunks.iter().enumerate() {
            layered += usize::from(chunk.layer_textures.len() > 1);
            holes += chunk.holes.count_ones();
            for i in 0..chunk.positions.len() {
                let v = &material.vertices[(vertex + i) * 13..(vertex + i + 1) * 13];
                assert_eq!(&v[6..8], &chunk.uvs[i]);
                assert_eq!(
                    &v[3..6],
                    &[
                        -chunk.normals[i][1],
                        chunk.normals[i][2],
                        -chunk.normals[i][0]
                    ]
                );
                assert_eq!(v[12], id as f32);
                for (layer, path) in chunk.layer_textures.iter().enumerate() {
                    assert_eq!(
                        material.paths[v[8 + layer] as usize],
                        path.to_ascii_lowercase()
                    );
                }
            }
            for &i in &chunk.indices {
                assert_eq!(material.indices[index], vertex as u32 + i);
                index += 1;
            }
            for pixel in 0..4096 {
                let mask = &material.masks[id * 16384 + pixel * 4..][..4];
                assert_eq!(mask[3], chunk.shadow.as_ref().map_or(0, |s| s[pixel]));
                shadowed += usize::from(mask[3] != 0);
                assert_eq!(
                    &mask[..3],
                    chunk
                        .alpha_map
                        .as_ref()
                        .map_or(&[0, 0, 0][..], |a| &a[pixel * 4..pixel * 4 + 3])
                );
            }
            vertex += chunk.positions.len();
        }
        for path in material.paths {
            let texture = SceneTexture::decode(&chain.read_file(&path).unwrap()).unwrap();
            assert_eq!(
                texture.rgba.len(),
                (texture.width * texture.height * 4) as usize
            );
            colored_textures += usize::from(
                texture
                    .rgba
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|p| p[0] != p[1] || p[1] != p[2]),
            );
        }
    }
    assert!(layered > 0 && shadowed > 0 && holes > 0 && colored_textures > 0);
}

#[test]
fn modf_bounds_are_source_world_aabbs_not_rotated_model_bounds() {
    let mut record = [0u8; 64];
    record[4..8].copy_from_slice(&7u32.to_le_bytes());
    for (i, value) in [10f32, 20., 30., 40., 50., 60.].iter().enumerate() {
        record[32 + i * 4..36 + i * 4].copy_from_slice(&value.to_le_bytes());
    }
    let mut bytes = b"FDOM".to_vec();
    bytes.extend(64u32.to_le_bytes());
    bytes.extend(record);
    let center = 32.0 * benilla_formats::TILE_SIZE;
    assert_eq!(
        modf_bounds(&bytes).unwrap()[&7],
        [
            [center - 60., center - 40., 20.],
            [center - 30., center - 10., 50.]
        ]
    );
    bytes.pop();
    assert!(modf_bounds(&bytes).is_err());
}

#[test]
fn source_geometry_and_alpha_survive_browser_payload() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let tree = "World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnTree01\\ElwynnPine01.m2";
    let bytes = chain.read_file(tree).unwrap();
    let model = SceneModel::from_m2(&bytes, tree, "[]").unwrap();
    assert_eq!(model.indices.len() / 3, 68);
    assert_eq!(model.collision.indices.len() / 3, 6);
    let meta: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
    let cutout = meta["batches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["alphaCutoff"].as_f64().unwrap() > 0.0)
        .unwrap();
    let tex = chain
        .read_file(cutout["texture"].as_str().unwrap())
        .unwrap();
    let tex = SceneTexture::decode(&tex).unwrap();
    assert!(tex.rgba.as_chunks::<4>().0.iter().any(|p| p[3] < 224));
    assert!(tex.rgba.as_chunks::<4>().0.iter().any(|p| p[3] >= 224));
    assert!(model
        .vertices
        .as_chunks::<12>()
        .0
        .iter()
        .all(|v| v.iter().all(|x| x.is_finite())));
}

#[test]
fn real_inn_keeps_render_surfaces_and_authored_collision() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let path = "World\\wmo\\Azeroth\\Buildings\\GoldshireInn\\GoldshireInn";
    let root = SceneRoot::from_bytes(&chain.read_file(&format!("{path}.wmo")).unwrap()).unwrap();
    let mut triangles = 0;
    let mut collision = 0;
    for i in 0..root.root.group_count() {
        let bytes = chain.read_file(&format!("{path}_{i:03}.wmo")).unwrap();
        let group = root.decode_group(&bytes).unwrap();
        triangles += group.indices.len() / 3;
        collision += group.collision.indices.len() / 3;
    }
    assert_eq!(triangles, 24_274);
    assert!(collision > 100);
    assert!(root.decode_group(b"not a WMO group").is_err());
}

#[test]
fn stormwind_wmo_exports_authored_water_without_collision() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let root = SceneRoot::from_bytes(
        &chain
            .read_file("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind.wmo")
            .unwrap(),
    )
    .unwrap();
    let wet_bytes = chain
        .read_file("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind_099.wmo")
        .unwrap();
    let dry_bytes = chain
        .read_file("World\\wmo\\Azeroth\\Buildings\\Stormwind\\Stormwind_000.wmo")
        .unwrap();
    let authored = wmo_group_liquid_mesh(&wet_bytes).unwrap();
    assert_eq!(authored.kind, LiquidKind::Still);
    assert_eq!(authored.wet.iter().filter(|&&wet| wet).count(), 52);
    assert_eq!(
        authored.wet.len() - authored.wet.iter().filter(|&&wet| wet).count(),
        36
    );
    assert_eq!(authored.positions.len(), 108);
    let (depth_min, depth_max) = authored
        .depths
        .iter()
        .copied()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), depth| {
            (lo.min(depth), hi.max(depth))
        });
    assert_eq!((depth_min, depth_max), (0.0, 0.3372549));
    assert_eq!(
        authored
            .depths
            .iter()
            .filter(|&&depth| depth == 0.0)
            .count(),
        36
    );
    assert_eq!(
        authored
            .depths
            .iter()
            .filter(|&&depth| depth == 0.3372549)
            .count(),
        71
    );
    assert_eq!(
        authored
            .depths
            .iter()
            .filter(|&&depth| depth == 0.19215687)
            .count(),
        1
    );
    let model = root.decode_group(&wet_bytes).unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
    let water = metadata["batches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|batch| batch["water"] == true)
        .unwrap();
    assert_eq!(water["texture"], serde_json::Value::Null);
    assert_eq!(water["blend"], "opaque");
    assert_eq!(water["indexCount"], 52 * 6);
    assert_eq!(
        model.indices.len(),
        wmo_group_submeshes_strict(&wet_bytes, &root.root)
            .unwrap()
            .iter()
            .map(|s| s.indices.len())
            .sum::<usize>()
            + 52 * 6
    );
    let mut expected_collision = CollisionMesh::default();
    accumulate_wmo_group_collision(
        &wet_bytes,
        &mut expected_collision.positions,
        &mut expected_collision.indices,
    );
    assert_eq!(model.collision.positions, expected_collision.positions);
    assert_eq!(model.collision.indices, expected_collision.indices);
    assert!(root
        .decode_group(&dry_bytes)
        .unwrap()
        .metadata
        .find("\"water\"")
        .is_none());
}

#[test]
fn both_continents_provide_authored_nearby_models_and_finite_placements() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    for (map, x, y) in [("Kalimdor", 39, 43), ("Azeroth", 32, 48)] {
        let bytes = chain
            .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
            .unwrap();
        let refs: Vec<serde_json::Value> =
            serde_json::from_str(&placements(&bytes).unwrap()).unwrap();
        let tile = adt_to_tile_mesh(&bytes).unwrap();
        let reused: Vec<serde_json::Value> =
            serde_json::from_str(&tile_placements(&tile, &bytes).unwrap()).unwrap();
        assert_eq!(
            refs, reused,
            "Resident tile reuse must preserve every authored placement"
        );
        assert!(!refs.is_empty(), "{map} has authored placements");
        let mut seen = std::collections::HashSet::new();
        let mut decoded = 0;
        for p in &refs {
            assert!(p["position"]
                .as_array()
                .unwrap()
                .iter()
                .all(|v| v.as_f64().is_some_and(f64::is_finite)));
            let raw_path = p["path"].as_str().unwrap().to_ascii_lowercase();
            if p["kind"] != "m2" || !seen.insert(raw_path.clone()) || decoded >= 8 {
                continue;
            }
            let path = raw_path
                .strip_suffix(".mdx")
                .map_or(raw_path.clone(), |s| format!("{s}.m2"));
            let bytes = chain.read_file(&path).unwrap();
            let model = SceneModel::from_m2(&bytes, &path, "[]").unwrap();
            assert!(!model.indices.is_empty(), "{path}");
            decoded += 1;
        }
        assert!(decoded > 0, "{map} models decoded");
        eprintln!(
            "{map}: {} placements, {decoded} distinct authored M2 models decoded",
            refs.len()
        );
    }
}

#[test]
fn real_baked_npc_has_a_visible_body_without_unresolved_cutout_cards() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let catalog = benilla_formats::load_creature_catalog(&mut chain).unwrap();
    let creature = catalog
        .display_models()
        .filter_map(|(id, _)| catalog.model(id))
        .find(|m| {
            m.npc_appearance
                .as_ref()
                .is_some_and(|a| a.bake_name.is_some())
        })
        .unwrap();
    let path = creature
        .model_path
        .to_ascii_lowercase()
        .replace(".mdx", ".m2");
    let mut skins = creature.textures.to_vec();
    skins.push(
        creature
            .npc_appearance
            .unwrap()
            .bake_name
            .map(|name| format!("Textures\\BakedNpcTextures\\{name}")),
    );
    let bytes = chain.read_file(&path).unwrap();
    let model =
        SceneModel::from_m2(&bytes, &path, &serde_json::to_string(&skins).unwrap()).unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&model.metadata).unwrap();
    let batches = metadata["batches"].as_array().unwrap();
    assert!(batches.iter().any(|b| {
        b["texture"]
            .as_str()
            .is_some_and(|s| s.contains("BakedNpcTextures"))
    }));
    assert!(
        batches
            .iter()
            .all(|b| b["alphaCutoff"].as_f64().unwrap() == 0.0 || b["texture"].is_string()),
        "Unresolved character cutouts hide an otherwise valid baked NPC"
    );
}

#[test]
fn character_actor_stream_matches_the_filtered_static_mesh() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    let catalog = benilla_formats::load_creature_catalog(&mut chain).unwrap();
    let creature = catalog
        .display_models()
        .filter_map(|(id, _)| catalog.model(id))
        .find(|m| {
            m.npc_appearance
                .as_ref()
                .is_some_and(|a| a.bake_name.is_some())
        })
        .unwrap();
    let path = creature
        .model_path
        .to_ascii_lowercase()
        .replace(".mdx", ".m2");
    let mut skins = creature.textures.to_vec();
    skins.push(
        creature
            .npc_appearance
            .unwrap()
            .bake_name
            .map(|n| format!("Textures\\BakedNpcTextures\\{n}")),
    );
    let (skins, bytes) = (
        serde_json::to_string(&skins).unwrap(),
        chain.read_file(&path).unwrap(),
    );
    let trousers = "[0,1,101,201,301,401,501,601,702,801,901,1001,1101,1201,1301,1401,1501]";
    let skirt = "[0,1,101,201,301,401,601,702,801,1001,1201,1302,1401,1501]";
    let count = |g: Option<Vec<u16>>| {
        SceneModel::decode_m2(&bytes, &path, &skins, false, g)
            .unwrap()
            .vertices
            .len()
            / 12
    };
    let all = count(None);
    assert!(count(parse_geosets(trousers).unwrap()) <= all);
    assert_ne!(
        count(parse_geosets(trousers).unwrap()),
        count(parse_geosets(skirt).unwrap()),
        "skirt and trousers differ"
    );
    if let Ok(actor) = SceneActor::decode(&bytes, &path, &skins, parse_geosets(trousers).unwrap()) {
        assert_eq!(
            actor.vertex_count(),
            count(parse_geosets(trousers).unwrap())
        );
        let (mut p0, mut p1) = (actor.vertices.clone(), actor.vertices.clone());
        actor.rig.pose_into(&actor.bind, 0, 0.0, &mut p0).unwrap();
        actor
            .rig
            .pose_into(&actor.bind, 0, actor.duration(0) * 0.5, &mut p1)
            .unwrap();
        assert_ne!(p0, p1, "stand pose changes over time");
    }
}

#[test]
fn geoset_lists_are_bounded_json() {
    assert_eq!(parse_geosets("").unwrap(), None);
    assert_eq!(parse_geosets("[1,1301]").unwrap(), Some(vec![1, 1301]));
    assert!(parse_geosets("[-1]").is_err());
    assert!(parse_geosets(&format!("[{}]", vec!["1"; 300].join(","))).is_err());
}
