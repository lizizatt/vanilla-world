#[test]
fn launch_sweeps_hold_unknown_high_ground_and_stop_at_resident_roofs_and_sea() {
    use super::*;
    let mut world=Voyage::from_manifest(fixture(0.0)).unwrap();
    assert_eq!(world.pod_sweep(&[200.0,20000.0,64.0],&[201.0,20001.0,64.0]).unwrap(),1);
    assert_eq!(world.pod_sweep(&[700.0,20.0,64.0],&[700.0,-2.0,64.0]).unwrap(),2);
    world.scene_bounds=vec![[690.0,16.0,60.0,710.0,17.0,68.0]];
    assert_eq!(world.pod_sweep(&[700.0,22.0,64.0],&[700.0,13.0,64.0]).unwrap(),3);
    assert_eq!(world.pod_sweep(&[700.0,22.0,64.0],&[700.0,25.0,64.0]).unwrap(),0);
    world.pod_engine_state(&[0.0,1.0,1.0]).unwrap();
    for _ in 0..1800 {world.pod_engine_step(1.0,2,1.0).unwrap();}
    assert_eq!(world.state.heat,1.0);assert!(world.state.health.iter().all(|h|*h>0.0&&*h<1.0));
    let before=world.state.health;
    world.pod_engine_step(1.0,2,0.0).unwrap();
    assert!(world.state.health[0]<before[0]);
    println!("powered burn ends with heat={} health={:?}",world.state.heat,before);
    for _ in 0..1200 {world.pod_engine_step(0.0,0,0.0).unwrap();}
    assert!(world.state.heat<1e-5);
    assert!(world.state.health.iter().all(|h|*h>0.0),"Full burn and normal cooldown must survive: {:?}",world.state.health);
    println!("after normal cooldown health={:?}",world.state.health);
    world.pod_engine_state(&[1.0,1.0,1.0]).unwrap();
    world.pod_engine_step(1.0,2,1.0).unwrap();
    let powered_loss=2.0-world.state.health.iter().sum::<f32>();
    world.pod_engine_state(&[1.0,1.0,1.0]).unwrap();
    world.pod_engine_step(1.0,2,0.0).unwrap();
    let ordinary_loss=2.0-world.state.health.iter().sum::<f32>();
    assert!((ordinary_loss-powered_loss).abs()<1e-6);
    world.set_durability(false,100.0);
    world.pod_engine_state(&[0.0,1.0,1.0]).unwrap();
    for _ in 0..3600 {world.pod_engine_step(1.0,2,0.0).unwrap();}
    assert_eq!(world.state.heat,1.0);
    assert_eq!(world.state.health,[1.0,1.0]);
}

#[test]
fn pitched_thrust_keeps_vertical_readiness_conservative_and_ground_contact_solid() {
    use super::*;
    for pitch in [-1.0, 1.0] {
        for throttle in [-1.0, 1.0] {
            for thrust in [50.0, 100000.0, f32::MAX] {
                let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
                world.origin = [700.0, 64.0];
                world.state.position[1] = 50.0;
                world.state.pitch = pitch * flats_racer_physics::PITCH_LIMIT;
                world.tuning.acceleration = thrust;
                let bound = world.frame_vertical_sweep_distance();
                assert!(bound.is_finite());
                for _ in 0..12 {
                    let before = world.state;
                    if world.advance(Input { pitch, throttle, boost: true, ..Default::default() }).is_err() {
                        assert_eq!(world.state, before);
                        break;
                    }
                    assert!((f64::from(world.state.position[1]) - 50.0).abs() <= bound);
                    assert!(world.state.position[1] >= FLOOR_CLEARANCE);
                }
            }
        }
    }
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    world.origin = [700.0, 64.0];
    for _ in 0..1200 {
        world.advance(Input { throttle: 1.0, pitch: -1.0, boost: true, ..Default::default() }).unwrap();
        assert!(world.state.position[1] >= FLOOR_CLEARANCE);
    }
}

#[test]
fn default_pitched_launches_have_measured_apices_without_an_artificial_ceiling() {
    use super::*;
    use flats_racer_physics::{PITCH_LIMIT, HEAT_RISE_PER_SEC};
    let base = Voyage::from_manifest(fixture(0.0)).unwrap().tuning;
    let cold_to_full = 1.0 / HEAT_RISE_PER_SEC;
    for gravity in [48.0, 24.0] {
        let tuning = Tuning { gravity, ..base };
        let vertical_thrust = (base.acceleration + base.boost_acceleration) * base.air_control * PITCH_LIMIT.sin();
        if gravity == 48.0 { assert!(vertical_thrust < gravity); }
        else { assert!(vertical_thrust > gravity); }
        for launch in [7.0, 112.0] {
            for boost_seconds in [cold_to_full, 60.0] {
                let mut state = State::new([0.0, 3.0, 0.0], 0.0).unwrap();
                state.pitch = PITCH_LIMIT;
                state.velocity = [0.0, launch, -base.boost_max_speed];
                let mut apex = state.position[1];
                for tick in 0..7200 {
                    let support = (state.position[1] <= tuning.support_reach()).then_some(state.position[1]);
                    state.step_with_tuning(Input {
                        throttle: 1.0, pitch: 1.0, boost: (tick as f32 * FIXED_DT) < boost_seconds,
                        ..Default::default()
                    }, [support; 4], FIXED_DT, &tuning).unwrap();
                    state.position[1] = (state.position[1] + state.velocity[1] * FIXED_DT).max(FLOOR_CLEARANCE);
                    if state.position[1] == FLOOR_CLEARANCE { state.velocity[1] = state.velocity[1].max(0.0); }
                    apex = apex.max(state.position[1]);
                }
                if gravity == 48.0 {
                    let ballistic_bound = 3.0 + launch * launch / (2.0 * (gravity - vertical_thrust));
                    assert!(apex <= ballistic_bound + 0.1);
                }
                eprintln!("pitch launch: gravity={gravity}, initial_vy={launch}, boost_seconds={boost_seconds}, apex_y={apex:.3}");
            }
        }
    }
}

#[test]
fn accepted_ramp_launches_measure_actual_support_generated_momentum() {
    use super::*;
    for slope in [0.35, 1.4] {
        for gravity in [48.0, 24.0] {
            let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
            world.origin = [700.0, 64.0];
            world.state.position = [0.0, 3.0, 0.0];
            world.state.velocity = [300.0, slope as f32 * 300.0, 0.0];
            world.state.yaw = -std::f32::consts::FRAC_PI_2;
            world.state.pitch = flats_racer_physics::PITCH_LIMIT;
            world.tuning.gravity = gravity;
            let a = [690.0, -10.0 * slope, 40.0];
            let b = [1100.0, 400.0 * slope, 40.0];
            let c = [1100.0, 400.0 * slope, 90.0];
            let d = [690.0, -10.0 * slope, 90.0];
            world.set_scene_mesh(&[a, c, b, a, d, c].concat()).unwrap();
            let mut jumped = false;
            let mut launched = false;
            for _ in 0..240 {
                let x = world.global()[0];
                let jump = !jumped && x > 1090.0;
                jumped |= jump;
                world.advance(Input { throttle: 1.0, pitch: 1.0, boost: true, jump, ..Default::default() }).unwrap();
                assert_eq!(world.hold, 0, "slope={slope}, x={x}");
                if world.global()[0] > 1102.0 {
                    launched = true;
                    eprintln!("actual ramp: gravity={gravity}, slope={slope}, launch_y={}, launch_vy={}, vx={}",
                        world.state.position[1], world.state.velocity[1], world.state.velocity[0]);
                    assert!(jumped);
                    for boost_seconds in [(1.0 - world.state.heat) / flats_racer_physics::HEAT_RISE_PER_SEC, 60.0] {
                        let mut airborne = world.state;
                        let mut apex = airborne.position[1];
                        for tick in 0..7200 {
                            airborne.step_with_tuning(Input {
                                throttle: 1.0, pitch: 1.0, boost: tick as f32 * FIXED_DT < boost_seconds,
                                ..Default::default()
                            }, [None; 4], FIXED_DT, &world.tuning).unwrap();
                            airborne.position[1] += airborne.velocity[1] * FIXED_DT;
                            apex = apex.max(airborne.position[1]);
                            if airborne.position[1] < 0.0 { break; }
                        }
                        eprintln!("actual ramp apex: gravity={gravity}, slope={slope}, remaining_boost={boost_seconds:.3}, apex_y={apex:.3}");
                    }
                    break;
                }
            }
            assert!(launched, "Ramp must actually be traversed");
        }
    }
}

#[test]
fn cached_collision_parts_preserve_queries_ranges_and_atomic_replacement() {
    use super::*;
    let vertices = [
        -10.0, 5.0, -10.0, 10.0, 5.0, -10.0, 10.0, 5.0, 10.0, -10.0, 5.0, -10.0, 10.0, 5.0, 10.0,
        -10.0, 5.0, 10.0, 8.0, 0.0, -10.0, 8.0, 5.0, -10.0, 8.0, 5.0, 10.0, 8.0, 0.0, -10.0, 8.0,
        5.0, 10.0, 8.0, 0.0, 10.0,
    ];
    let reference = CollisionTree::new(&vertices).unwrap();
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    world
        .replace_scene_parts(&[7, 8], &[2, 2], &vertices)
        .unwrap();
    let retained = world.scene_parts[&7].triangles.as_ptr();
    for x in -12..12 {
        for z in -12..12 {
            for ceiling in [1.6, 6.0] {
                let p = [f64::from(x), f64::from(z)];
                assert_eq!(
                    world.scene_mesh.height(p, ceiling),
                    reference.height(p, ceiling)
                );
            }
            let start = [f64::from(x), 1.1, f64::from(z)];
            let end = [f64::from(x + 20), 1.1, f64::from(z)];
            assert_eq!(
                world.scene_mesh.swept(start, end),
                reference.swept(start, end)
            );
        }
    }
    let added = [100.0, 2.0, 0.0, 103.0, 2.0, 0.0, 100.0, 2.0, 3.0];
    world
        .replace_scene_parts(&[9, 8, 7], &[1, 0, 0], &added)
        .unwrap();
    assert_eq!(world.scene_parts[&7].triangles.as_ptr(), retained);
    assert_eq!(world.scene_mesh.height([101.0, 1.0], 3.0), Some(2.0));
    assert_eq!(world.scene_mesh.nodes[0].range, 0..5);
    let mut covered = 0;
    for node in &world.scene_mesh.nodes {
        if let Some([left, right]) = node.children {
            assert_eq!(node.range.start, world.scene_mesh.nodes[left].range.start);
            assert_eq!(
                world.scene_mesh.nodes[left].range.end,
                world.scene_mesh.nodes[right].range.start
            );
            assert_eq!(node.range.end, world.scene_mesh.nodes[right].range.end);
        } else {
            covered += node.range.len();
        }
        for p in world.scene_mesh.triangles[node.range.clone()]
            .iter()
            .flatten()
        {
            for (a, value) in p.iter().enumerate() {
                assert!(*value >= node.bounds[a] && *value <= node.bounds[a + 3]);
            }
        }
    }
    assert_eq!(covered, 5);
    for (ids, counts, data) in [
        (vec![7, 7], vec![0, 0], vec![]),
        (vec![99], vec![0], vec![]),
        (vec![10], vec![1], vec![0.0; 8]),
        (vec![10], vec![1], vec![f64::NAN; 9]),
    ] {
        assert!(world.replace_scene_parts(&ids, &counts, &data).is_err());
        assert_eq!(world.scene_mesh.triangles.len(), 5);
        assert_eq!(world.scene_parts[&7].triangles.as_ptr(), retained);
    }
    assert_eq!(
        world.replace_scene_parts(&[7, 10], &[0, 199999], &[]),
        Err("Collision parts exceed 200000 triangles")
    );
    world.replace_scene_parts(&[7, 9], &[0, 0], &[]).unwrap();
    assert!(!world.scene_parts.contains_key(&8));
    assert!(!world.scene_mesh.swept([0.0, 1.1, 0.0], [20.0, 1.1, 0.0]));
    world.set_scene_mesh(&[]).unwrap();
    assert!(world.scene_parts.is_empty());
    assert!(world.scene_mesh.nodes.is_empty());
    world
        .replace_scene_parts(&[7], &[2], &vertices[..18])
        .unwrap();
    world.set_scene_bounds(&[]).unwrap();
    assert!(world.scene_parts.is_empty());
    assert!(world.scene_mesh.nodes.is_empty());
}

#[test]
fn indexed_bvh_partition_preserves_every_triangle_and_exported_node_range() {
    use super::*;
    for count in [1, 8, 9, 17, 257, 2049] {
        let mut original: Vec<[[f64; 3]; 3]> = (0..count)
            .map(|i| {
                let x = f64::from((i * 97) % 31);
                let z = f64::from((i * 73) % 29);
                [[x, 0.0, z], [x + 0.4, 0.0, z], [x, 0.0, z + 0.3]]
            })
            .collect();
        let vertices: Vec<_> = original.iter().flatten().flatten().copied().collect();
        let tree = CollisionTree::new(&vertices).unwrap();
        let mut reordered = tree.triangles.clone();
        original.sort_by(|a, b| a.partial_cmp(b).unwrap());
        reordered.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(reordered, original);
        assert_eq!(tree.nodes[0].range, 0..count as usize);
        let mut covered = 0;
        for node in &tree.nodes {
            if node.children.is_none() {
                covered += node.range.len();
            }
            for triangle in &tree.triangles[node.range.clone()] {
                for point in triangle {
                    for (axis, value) in point.iter().enumerate() {
                        assert!(*value >= node.bounds[axis] && *value <= node.bounds[axis + 3]);
                    }
                }
            }
        }
        assert_eq!(covered, count as usize);
    }
}

#[test]
fn resident_gentle_slope_does_not_become_a_wall_at_high_speed() {
    use super::*;
    for (speed, grade) in [(36.0, 0.2), (250.0, 0.35), (500.0, 0.2)] {
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        let entry = &world.manifest.tiles[0];
        let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
        let northwest = (32.0 - f64::from(entry.x)) * TILE;
        for vertex in tile.chunks.iter_mut().flat_map(|c| &mut c.positions) {
            vertex[2] = (northwest - f64::from(vertex[1]) - 200.0) as f32 * grade;
        }
        world.resident.insert(0, tile);
        world.state.yaw = -std::f32::consts::FRAC_PI_2;
        world.state.velocity = [speed, speed * grade, 0.0];
        world.tuning.max_speed = speed;
        world.tuning.boost_max_speed = speed;
        world.tuning.drag = 0.0;
        let saved = (world.state, world.origin, world.rebases, world.hold);
        world
            .advance_substep(
                Input {
                    throttle: 1.0,
                    ..Default::default()
                },
                FIXED_DT,
            )
            .unwrap();
        assert_eq!(
            world.hold,
            if speed > 50.0 { 3 } else { 0 },
            "old single-step guard"
        );
        (world.state, world.origin, world.rebases, world.hold) = saved;
        world.physics_stats = [0; 8];
        let before = world.global();
        let started = std::time::Instant::now();
        for _ in 0..60 {
            world
                .advance(Input {
                    throttle: 1.0,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(world.hold, 0, "continuous grade {grade} at {speed} yd/s");
        }
        assert!(world.global()[0] - before[0] > f64::from(speed * FIXED_DT) * 60.0 * 0.98);
        assert!(world.physics_stats[7] <= 9);
        eprintln!(
            "{speed} yd/s, 60 resident ticks, {} substeps, {:?}",
            world.physics_stats[1],
            started.elapsed()
        );
    }
}

#[test]
fn admission_profiling_preserves_actual_terrain_collision_materials_and_placements() {
    let data = benilla_formats::wow_data_or_skip!();
    let mut chain = benilla_formats::Chain::open(&data).unwrap();
    for (index, map, x, y) in [(0, "Kalimdor", 39, 43), (1, "Azeroth", 32, 48)] {
        let bytes = chain
            .read_file(&format!("World\\Maps\\{map}\\{map}_{x}_{y}.adt"))
            .unwrap();
        let mut manifest = fixture(0.0);
        manifest.regions[index].tile_origin = [x, y];
        let entry = &mut manifest.tiles[index];
        entry.x = x;
        entry.y = y;
        entry.bytes = bytes.len();
        entry.file = format!("{map}_{x}_{y}.adt");
        let mut plain = Voyage::from_manifest(manifest.clone()).unwrap();
        let mut staged = Voyage::from_manifest(manifest.clone()).unwrap();
        let mut profiled = Voyage::from_manifest(manifest).unwrap();
        profiled.set_admission_profiling(true);
        plain.add_tile(index, &bytes).unwrap();
        profiled.add_tile(index, &bytes).unwrap();
        staged.begin_tile(index, bytes.clone()).unwrap();
        let mut steps = 0;
        loop {
            let done = staged.step_tile().unwrap();
            steps += 1;
            assert!(
                staged.resident.is_empty(),
                "Partial terrain must never support physics"
            );
            if done {
                break;
            }
        }
        assert_eq!(steps, 257);
        assert_eq!(
            staged.prepared_tile_placements(&bytes).unwrap(),
            plain.tile_placements(index, &bytes).unwrap()
        );
        staged.commit_tile(index).unwrap();
        for (a, b) in plain.resident[&index]
            .chunks
            .iter()
            .zip(&staged.resident[&index].chunks)
        {
            assert_eq!(format!("{a:?}"), format!("{b:?}"));
        }
        staged.begin_tile(index, bytes.clone()).unwrap();
        staged.step_tile().unwrap();
        staged.cancel_tile();
        assert!(staged.tile_builder.is_none() && staged.prepared_tile.is_none());
        assert_eq!(
            staged.geometry(index).unwrap(),
            plain.geometry(index).unwrap()
        );
        assert_eq!(
            plain.geometry(index).unwrap(),
            profiled.geometry(index).unwrap()
        );
        assert_eq!(
            plain.tile_placements(index, &bytes).unwrap(),
            profiled.tile_placements(index, &bytes).unwrap()
        );
        let a = plain.terrain_material(index).unwrap();
        let b = profiled.terrain_material(index).unwrap();
        assert_eq!(a.vertices(), b.vertices());
        assert_eq!(a.indices(), b.indices());
        assert_eq!(a.masks(), b.masks());
        assert_eq!(a.paths(), b.paths());
        for (a, b) in plain.resident[&index]
            .chunks
            .iter()
            .zip(&profiled.resident[&index].chunks)
        {
            assert_eq!(a.positions, b.positions);
            assert_eq!(a.holes, b.holes);
        }
        let times = profiled.admission_timings();
        assert!(times.iter().all(|t| t.is_finite() && *t >= 0.0));
        assert!(times[0] > 0.0 && times[7] > 0.0 && times[8] >= times[..7].iter().sum::<f64>());
        assert_eq!(plain.admission_timings(), vec![0.0; 9]);
        profiled.set_admission_profiling(false);
        assert_eq!(profiled.admission_timings(), vec![0.0; 9]);
    }
}

#[test]
fn support_substeps_preserve_thin_walls_holes_and_atomic_rebase_rollback() {
    use super::*;
    for kind in ["wall", "hole", "ledge", "missing"] {
        let mut manifest = fixture(0.0);
        if kind == "missing" {
            manifest.regions[0].tile_count[0] = 2;
            manifest.ocean[0] = TILE * 2.0;
            let mut neighbor = manifest.tiles[0].clone();
            neighbor.x += 1;
            neighbor.file = format!("Kalimdor_{}_{}.adt", neighbor.x, neighbor.y);
            manifest.tiles.push(neighbor);
        }
        let mut world = Voyage::from_manifest(manifest).unwrap();
        let entry = &world.manifest.tiles[0];
        let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
        let x = match kind {
            "hole" => {
                tile.chunks[22].holes = u16::MAX;
                198.0
            }
            "ledge" => {
                for chunk in tile.chunks.iter_mut().filter(|c| c.index_x >= 7) {
                    for p in &mut chunk.positions {
                        p[2] = 10.0;
                    }
                }
                231.0
            }
            "missing" => 531.0,
            _ => 255.8,
        };
        world.resident.insert(0, tile);
        world.origin = [0.0, 64.0];
        world.state.position = [x, 1.1, 0.0];
        world.state.yaw = -std::f32::consts::FRAC_PI_2;
        world.state.velocity = [500.0, 0.0, 0.0];
        world.tuning.max_speed = 500.0;
        world.tuning.boost_max_speed = 500.0;
        if kind == "wall" {
            world.scene_bounds = vec![[258.0, 0.0, 0.0, 258.1, 10.0, 500.0]];
        }
        let (position, origin, rebases) = (world.state.position, world.origin, world.rebases);
        world
            .advance(Input {
                throttle: 1.0,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            world.hold,
            if kind == "missing" {
                1
            } else if kind == "hole" {
                2
            } else {
                3
            },
            "{kind}"
        );
        assert_eq!(world.state.position, position, "{kind}");
        assert_eq!(world.origin, origin, "{kind}");
        assert_eq!(world.rebases, rebases, "{kind}");
        assert_eq!(world.state.velocity, [0.0; 3], "{kind}");
    }
}

#[test]
fn legacy_tick_path_is_unchanged_and_extreme_substep_work_is_rejected_atomically() {
    use super::*;
    let mut a = Voyage::from_manifest(fixture(0.0)).unwrap();
    let mut b = Voyage::from_manifest(fixture(0.0)).unwrap();
    a.tuning = Tuning {
        air_control: 0.9,
        ..Tuning::default()
    };
    b.tuning = a.tuning;
    a.origin = [700.0, 300.0];
    b.origin = a.origin;
    for tick in 0..600 {
        let input = Input {
            throttle: if tick % 100 < 80 { 1.0 } else { -1.0 },
            steer: if tick % 200 < 100 { 0.5 } else { -0.5 },
            boost: tick % 80 < 20,
            jump: tick % 120 == 0,
            ..Default::default()
        };
        a.advance(input).unwrap();
        b.advance_substep(input, FIXED_DT).unwrap();
        assert_eq!(a.telemetry(), b.telemetry());
    }
    assert_eq!(a.physics_stats[7], 1);
    a.tuning.max_speed = 5000.0;
    a.tuning.boost_max_speed = 5000.0;
    a.state.velocity = [5000.0, 0.0, 0.0];
    let before = a.telemetry();
    assert!(a
        .advance(Input::default())
        .unwrap_err()
        .contains("64 support substeps"));
    assert_eq!(a.telemetry(), before);
}

#[test]
fn vertical_demand_bounds_falling_hopping_springs_penetration_and_f32_extremes() {
    let mut rejected = 0;
    for speed in [0.0, 250.0, 500.0] {
        for vertical in [-100.0, 0.0, 100.0, 1e20] {
            for height in [-50.0, 1.1, 22.18466, 1e6] {
                for (spring, damping, hover, hop, gravity) in [
                    (0.0, 0.0, 1.1, 1.0, 1e-30),
                    (90.0, 18.0, 1.1, 100.0, 24.0),
                    (1e6, 0.0, 4.0, 1000.0, 24.0),
                    (1e6, 1e6, 100.0, 1000.0, 1000.0),
                    (f32::MAX, 0.0, f32::MAX, 1.0, 1e-30),
                    (f32::MAX, f32::MAX, f32::MAX, f32::MAX, f32::MAX),
                ] {
                    for jump in [false, true] {
                        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
                        world.origin = [700.0, 64.0];
                        world.state.position = [0.0, height, 0.0];
                        world.state.velocity = [speed, vertical, 0.0];
                        world.tuning.max_speed = 500.0;
                        world.tuning.boost_max_speed = 500.0;
                        world.tuning.spring = spring;
                        world.tuning.damping = damping;
                        world.tuning.hover_height = hover;
                        world.tuning.hop_speed = hop;
                        world.tuning.gravity = gravity;
                        world.tuning.validate().unwrap();
                        let bound = world.frame_vertical_sweep_distance();
                        assert!(bound.is_finite() && bound >= 0.0);
                        for _ in 0..12 {
                            let previous = world.state;
                            if let Err(error) = world.advance(Input {
                                jump,
                                ..Default::default()
                            }) {
                                assert_eq!(world.state.position, previous.position);
                                assert_eq!(world.state.velocity, previous.velocity);
                                assert!(error.to_lowercase().contains("finite"), "{error}");
                                rejected += 1;
                                break;
                            }
                            let excursion =
                                (f64::from(world.state.position[1]) - f64::from(height)).abs();
                            assert!(excursion <= bound, "{speed}/{vertical}/{height}/{spring}/{damping}/{hover}/{hop}/{gravity}: {excursion} > {bound}");
                        }
                    }
                }
            }
        }
    }
    assert!(
        rejected > 0,
        "Nonfinite extreme-tuning steps must fail transactionally"
    );
}

#[test]
fn unreachable_ledge_preview_cannot_launch_a_braking_vehicle_or_leak_a_rejected_hop() {
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    let entry = &world.manifest.tiles[0];
    let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
    for chunk in tile.chunks.iter_mut().filter(|c| c.index_x >= 7) {
        for vertex in &mut chunk.positions {
            vertex[2] = 10.0;
        }
    }
    world.resident.insert(0, tile);
    world.origin = [0.0, 64.0];
    world.state.position = [231.0, 1.1, 0.0];
    world.state.yaw = -std::f32::consts::FRAC_PI_2;
    world.state.velocity = [500.0, 0.0, 0.0];
    world.tuning.max_speed = 500.0;
    world.tuning.boost_max_speed = 500.0;
    world.tuning.braking = 1e6;
    let before = world.state;
    world
        .advance_substep(
            Input {
                brake: true,
                ..Default::default()
            },
            FIXED_DT,
        )
        .unwrap();
    assert_eq!(world.hold, 0);
    assert_eq!(world.state.position[0], before.position[0]);
    assert!(world.state.position[1] - before.position[1] < SUPPORT_RISE);
    world.state = before;
    world
        .advance(Input {
            throttle: 1.0,
            jump: true,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(world.hold, 3);
    assert_eq!(world.state.position, before.position);
    assert_eq!(world.state.jump_cooldown, before.jump_cooldown);
}

#[test]
fn upward_feedforward_cap_preserves_accepted_downhill_response() {
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    let entry = &world.manifest.tiles[0];
    let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
    let northwest = (32.0 - f64::from(entry.x)) * TILE;
    for vertex in tile.chunks.iter_mut().flat_map(|c| &mut c.positions) {
        vertex[2] = (northwest - f64::from(vertex[1]) - 200.0) as f32 * -0.5;
    }
    world.resident.insert(0, tile);
    world.state.yaw = -std::f32::consts::FRAC_PI_2;
    world.state.velocity = [250.0, -100.0, 0.0];
    world.tuning.max_speed = 250.0;
    world.tuning.boost_max_speed = 250.0;
    world.tuning.drag = 0.0;
    let start = world.global();
    let hs = world.heights(start, world.state.yaw).unwrap();
    let next = world
        .heights(
            [start[0] + f64::from(250.0 * FIXED_DT), start[1]],
            world.state.yaw,
        )
        .unwrap();
    let rise = (next.iter().sum::<f32>() - hs.iter().sum::<f32>()) / (4.0 * FIXED_DT);
    assert!(rise < -SUPPORT_RISE / FIXED_DT);
    let input = Input {
        jump: true,
        ..Default::default()
    };
    let mut expected = world.state;
    expected
        .step_with_surface_motion(
            input,
            hs.map(|h| Some((expected.position[1] - h).max(0.0))),
            rise,
            FIXED_DT,
            &world.tuning,
        )
        .unwrap();
    world.advance_substep(input, FIXED_DT).unwrap();
    assert_eq!(world.hold, 0);
    assert_eq!(world.state.velocity, expected.velocity);
    assert_eq!(world.state.grounded, expected.grounded);
    assert_eq!(world.state.jump_cooldown, expected.jump_cooldown);
}

#[test]
fn frame_sweep_bounds_new_thrust_boost_and_airborne_authority() {
    use super::*;
    for supports in [[Some(1.1); 4], [None; 4]] {
        for (speed, acceleration, cap, air_control) in [
            (0.0, 18.0, 60.0, 0.9),
            (0.0, 10000.0, 500.0, 4.0),
            (500.0, 18.0, 500.0, 4.0),
        ] {
            let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
            world.state.velocity = [speed, 0.0, 0.0];
            world.tuning.max_speed = cap;
            world.tuning.boost_max_speed = cap;
            world.tuning.acceleration = acceleration;
            world.tuning.air_control = air_control;
            let bound = world.frame_sweep_distance();
            let mut traveled = 0.0;
            for _ in 0..12 {
                world
                    .state
                    .step_with_tuning(
                        Input {
                            throttle: 1.0,
                            steer: 1.0,
                            boost: true,
                            ..Default::default()
                        },
                        supports,
                        FIXED_DT,
                        &world.tuning,
                    )
                    .unwrap();
                traveled += f64::from(world.state.velocity[0])
                    .hypot(f64::from(world.state.velocity[2]))
                    * f64::from(FIXED_DT);
            }
            assert!(traveled <= bound + 0.0001, "{traveled} exceeds {bound}");
        }
    }
}

#[test]
fn floor_correction_cannot_cross_newly_admitted_collision() {
    for shift in [0.0, 1.0e9] {
        for jump in [false, true] {
            let mut world = Voyage::from_manifest(fixture(shift)).unwrap();
            let entry = &world.manifest.tiles[0];
            let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
            for vertex in tile.chunks.iter_mut().flat_map(|c| &mut c.positions) {
                vertex[2] = 1.0;
            }
            world.resident.insert(0, tile);
            let x = shift + 200.0;
            world.origin = [x, 64.0];
            world.state = State::new([0.0, 1.1, 0.0], 0.3).unwrap();
            world.state.bank = 0.2;
            world.state.heat = 0.5;
            world.tuning.hop_speed = 1.0;
            let before = (world.state, world.origin, world.rebases);
            world.scene_mesh = CollisionTree::new(&[
                x - 10.0,
                1.65,
                54.0,
                x + 10.0,
                1.65,
                54.0,
                x + 10.0,
                1.65,
                74.0,
                x - 10.0,
                1.65,
                54.0,
                x + 10.0,
                1.65,
                74.0,
                x - 10.0,
                1.65,
                74.0,
            ])
            .unwrap();
            let point = [x, f64::from(world.state.position[1]), 64.0];
            assert!(!world.scene_mesh.swept(point, point));
            world
                .advance(Input {
                    throttle: 1.0,
                    steer: 0.5,
                    boost: true,
                    jump,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(world.hold, 3);
            assert_eq!((world.state, world.origin, world.rebases), before);
            assert_eq!(world.physics_stats[4], 1);
            assert_eq!(world.physics_stats[6], 0);
            world.scene_mesh = CollisionTree::default();
            world.advance(Input::default()).unwrap();
            assert_eq!(
                world.hold, 0,
                "A blocked correction must not embed the hull"
            );
            assert_eq!(world.state.position[1], 1.25);
        }
    }
}

#[test]
fn steep_terrain_edges_still_block_when_the_actual_hull_cannot_clear_them() {
    for (height, blocked) in [(1.4, true), (1.6, false)] {
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        let tile = &world.manifest.tiles[0];
        let mut raised = crate::world::tests::flat_tile(tile.x, tile.y);
        for chunk in &mut raised.chunks {
            for p in &mut chunk.positions {
                p[2] = 1.0;
            }
        }
        world.resident.insert(0, raised);
        world.tuning.hover_height = height;
        world
            .restore_pose(&[535.0, f64::from(height), 64.0, std::f64::consts::FRAC_PI_2])
            .unwrap();
        world.state.velocity = [-36.0, 0.0, 0.0];
        for _ in 0..12 {
            world
                .advance(Input {
                    throttle: 1.0,
                    ..Default::default()
                })
                .unwrap();
            if world.hold != 0 {
                break;
            }
        }
        assert_eq!(world.hold == 3, blocked, "height={height}");
        if blocked {
            assert!(world.physics_stats[5] > 0);
        } else {
            assert!(world.global()[0] < 533.0);
        }
    }
}

#[test]
fn elevated_vehicle_clears_low_support_edges_without_a_false_solid_hold() {
    for shift in [0.0, 1.0e9] {
        for height in [3.0, 30.0] {
            for speed in [150.0, 300.0] {
                let mut world = Voyage::from_manifest(fixture(shift)).unwrap();
                let x = shift + 700.0;
                world.tuning.hover_height = height;
                world.tuning.max_speed = 150.0;
                world.tuning.boost_max_speed = 300.0;
                world.tuning.acceleration = 50.0;
                world.tuning.boost_acceleration = 50.0;
                world
                    .restore_pose(&[x, f64::from(height), 64.0, -std::f64::consts::FRAC_PI_2])
                    .unwrap();
                world.state.velocity = [speed, 0.0, 0.0];
                world.scene_mesh = CollisionTree::new(&[
                    x + 4.0,
                    1.0,
                    54.0,
                    x + 10.0,
                    1.0,
                    54.0,
                    x + 10.0,
                    1.0,
                    74.0,
                    x + 4.0,
                    1.0,
                    54.0,
                    x + 10.0,
                    1.0,
                    74.0,
                    x + 4.0,
                    1.0,
                    74.0,
                ])
                .unwrap();
                for _ in 0..20 {
                    world
                        .advance(Input {
                            throttle: 1.0,
                            boost: true,
                            ..Default::default()
                        })
                        .unwrap();
                    assert_eq!(
                        world.hold, 0,
                        "clear hull blocked at {height}yd/{speed}yd/s; counters={:?}",
                        world.physics_stats
                    );
                }
                assert!(world.global()[0] > x + 15.0);
                assert_eq!(world.physics_stats[4], 0);
                assert_eq!(world.physics_stats[5], 0);
            }
        }
    }
}

#[test]
fn overhead_mesh_is_not_support_and_does_not_trap_a_clear_vehicle() {
    for shift in [0.0, 1.0e9] {
        let mut world = Voyage::from_manifest(fixture(shift)).unwrap();
        world.tuning.hover_height = 1.1;
        let x = shift + 700.0;
        world.restore_pose(&[x, 1.1, 64.0, 0.0]).unwrap();
        world.scene_mesh = CollisionTree::new(&[
            x - 10.0,
            1.65,
            54.0,
            x + 10.0,
            1.65,
            54.0,
            x + 10.0,
            1.65,
            74.0,
            x - 10.0,
            1.65,
            54.0,
            x + 10.0,
            1.65,
            74.0,
            x - 10.0,
            1.65,
            74.0,
        ])
        .unwrap();
        world.restore_pose(&[x, 1.1, 64.0, 0.0]).unwrap();
        for _ in 0..60 {
            world
                .advance(Input {
                    throttle: 1.0,
                    ..Default::default()
                })
                .unwrap();
            assert_eq!(world.hold, 0);
            let p = world.global();
            let point = [p[0], f64::from(world.state.position[1]), p[1]];
            assert!(!world.scene_mesh.swept(point, point));
            assert!(world.state.position[1] < 1.65);
        }
        assert!(64.0 - world.global()[1] > 1.0);
    }
}

#[test]
fn rising_motion_queries_bridge_support_at_the_proposed_height() {
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    let entry = &world.manifest.tiles[0];
    let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
    for chunk in &mut tile.chunks {
        chunk.holes = u16::MAX;
    }
    world.resident.insert(0, tile);
    let mut vertices = vec![];
    for (left, right, height) in [(180.0, 201.28, 0.59), (201.28, 220.0, 1.12)] {
        vertices.extend([
            left, height, 54.0, right, height, 54.0, right, height, 74.0, left, height, 54.0,
            right, height, 74.0, left, height, 74.0,
        ]);
    }
    world.scene_mesh = CollisionTree::new(&vertices).unwrap();
    world
        .restore_pose(&[200.0, 1.1, 64.0, -std::f64::consts::FRAC_PI_2])
        .unwrap();
    world.state.velocity = [500.0, 2000.0, 0.0];
    world.tuning.max_speed = 500.0;
    world.tuning.boost_max_speed = 500.0;
    world.tuning.drag = 0.0;
    world.tuning.spring = 0.0;
    world.tuning.damping = 0.0;
    let first_endpoint = [200.0 + f64::from(500.0 * (FIXED_DT / 9.0)), 64.0];
    assert!(!world.scene_mesh.swept(
        [200.0, 1.1, 64.0],
        [
            first_endpoint[0],
            1.1 + f64::from(2000.0 * (FIXED_DT / 9.0)),
            64.0
        ],
    ));
    assert!(world
        .heights_at(first_endpoint, world.state.yaw, 1.1)
        .is_err());
    world.advance(Input::default()).unwrap();
    assert_eq!(world.hold, 0);
    assert!(world.global()[0] > 204.0);
    assert_eq!(world.physics_stats[7], 9);
}

#[test]
fn indexed_authored_collision_keeps_open_interiors_bridges_and_swept_walls() {
    use super::*;
    let triangles = [
        // A raised bridge, with open space underneath rather than an enclosing solid box.
        [-10.0, 5.0, -10.0, 10.0, 5.0, -10.0, 10.0, 5.0, 10.0],
        [-10.0, 5.0, -10.0, 10.0, 5.0, 10.0, -10.0, 5.0, 10.0],
        // Wall beyond the bridge's open center.
        [8.0, 0.0, -10.0, 8.0, 5.0, -10.0, 8.0, 5.0, 10.0],
        [8.0, 0.0, -10.0, 8.0, 5.0, 10.0, 8.0, 0.0, 10.0],
    ];
    let tree = CollisionTree::new(triangles.as_flattened()).unwrap();
    assert_eq!(tree.height([0.0, 0.0], 1.6), None);
    assert_eq!(tree.height([0.0, 0.0], 6.0), Some(5.0));
    assert!(!tree.swept([-5.0, 1.1, 0.0], [5.0, 1.1, 0.0]));
    assert!(!tree.swept([-5.0, 6.1, 0.0], [5.0, 6.1, 0.0]));
    assert!(tree.swept([0.0, 1.1, 0.0], [20.0, 1.1, 0.0]));
    assert!(tree.swept([0.0, 4.0, 0.0], [0.0, 6.0, 0.0]));
    assert!(!tree.swept([0.0, 1.1, 20.0], [20.0, 1.1, 20.0]));
    assert!(CollisionTree::new(&[f64::NAN; 9]).is_err());
    assert!(CollisionTree::new(&[0.0; 8]).is_err());
    assert!(!swept_triangle([0.0; 3], [1.0; 3], &[[0.0; 3]; 3]));
}

#[test]
fn collision_tree_matches_full_sweep_and_height_walk_after_translation() {
    use super::*;
    let mut vertices = vec![];
    for i in 0..200 {
        let x = 1_000_000.0 + f64::from(i) * 4.0;
        vertices.extend([x, 0.0, 0.0, x + 3.0, 0.0, 0.0, x, 0.0, 3.0]);
    }
    let tree = CollisionTree::new(&vertices).unwrap();
    assert!(tree.nodes.len() > 1);
    let mut visits = 0;
    tree.any(
        0,
        &|b| b[0] <= 1_000_000.25 && b[3] >= 1_000_000.25 && b[2] <= 0.25 && b[5] >= 0.25,
        &mut |_| {
            visits += 1;
            false
        },
    );
    assert!(visits <= 8, "Point query visited {visits}/200 triangles");
    for i in 0..800 {
        let x = 1_000_000.0 + f64::from(i);
        for z in [0.25, 2.0, 4.0] {
            let start = [x, 1.0, z];
            let end = [x + 5.0, -1.0, z];
            let expected = tree.triangles.iter().any(|t| swept_triangle(start, end, t));
            assert_eq!(tree.swept(start, end), expected, "{start:?}");
            assert_eq!(
                tree.height([x, z], 1.0).is_some(),
                tree.triangles.iter().any(|t| {
                    let local = t.map(|p| [(p[0] - x) as f32, (p[2] - z) as f32, p[1] as f32]);
                    triangle_z_at(&local, 0.0, 0.0).is_some()
                })
            );
        }
    }
}

#[test]
fn browser_tuning_uses_native_validation_and_signed_velocity() {
    use super::*;
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    let initial = world.tuning();
    assert_eq!(initial.len(), 17);
    assert_eq!(initial[16], 0.9);
    assert!(Voyage::parse_tuning(&initial[..16]).is_err());
    let mut invalid = initial.clone();
    invalid[0] = -1.0;
    assert!(Voyage::parse_tuning(&invalid).is_err());
    assert_eq!(world.tuning(), initial);
    let mut valid = initial;
    valid[11] = 10.0;
    world.tuning = Voyage::parse_tuning(&valid).unwrap();
    assert!(world.tuning.support_reach() >= 10.8);
    world.state.yaw = 0.0;
    world.state.velocity[2] = 4.0;
    assert_eq!(world.telemetry()[14], -4.0);
    world.state.velocity[2] = -4.0;
    assert_eq!(world.telemetry()[14], 4.0);
}

#[test]
fn whirlpool_dip_is_continuous_and_rides_down() {
    use super::*;
    let w = [1000.0, 500.0, 400.0, 100.0];
    assert_eq!(whirlpool_dip([1000.0, 500.0], w), 100.0);
    assert_eq!(whirlpool_dip([1400.0, 500.0], w), 0.0);
    assert_eq!(whirlpool_dip([5000.0, 0.0], w), 0.0);
    assert!(whirlpool_dip([1399.99, 500.0], w) < 0.001);
    assert!((whirlpool_dip([1200.0, 500.0], w) - 56.25).abs() < 1e-3);
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    let p = [1000.0, 200.0];
    assert!(contains(world.manifest.ocean, p));
    assert_eq!(world.sample(p).water, Some(0.0));
    world.whirlpool = Some([1000.0, 200.0, 400.0, 100.0]);
    assert_eq!(world.sample(p).water, Some(-100.0));
    assert_eq!(world.sample([1500.0, 200.0]).water, Some(0.0));
}

#[test]
fn wmo_water_surface_supports_only_on_loaded_tiles() {
    use super::*;
    let tri = |h: f64| [0.0, h, 0.0, TILE, h, 0.0, 0.0, h, TILE];
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    world.scene_water = CollisionTree::new(&tri(5.0)).unwrap();
    assert!(
        world.sample([10.0, 10.0]).support().is_none(),
        "unloaded tile stays unavailable"
    );
    let entry = &world.manifest.tiles[0];
    world
        .resident
        .insert(0, crate::world::tests::flat_tile(entry.x, entry.y));
    world.origin = [200.0, 64.0];
    world.state = State::new([0.0, 100.0, 0.0], 0.0).unwrap();
    world.scene_water = CollisionTree::default();
    let p = world.global();
    let ground = world.sample(p).support().unwrap();
    world.scene_water = CollisionTree::new(&tri(f64::from(ground) + 3.0)).unwrap();
    let wet = world.sample(p);
    assert_eq!(wet.support(), Some(ground + 3.0));
    assert!(wet.on_water());
}

#[test]
fn scene_bridge_cannot_turn_an_unloaded_expected_tile_into_ready_ground() {
    use super::*;
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    world.scene_mesh =
        CollisionTree::new(&[0.0, 0.0, 0.0, TILE, 0.0, 0.0, 0.0, 0.0, TILE]).unwrap();
    let surface = world.sample([10.0, 10.0]);
    assert_eq!(surface.availability, 1);
    assert!(surface.support().is_none());
}

#[test]
fn airborne_thrust_from_rest_crosses_known_holes_without_arresting_the_fall() {
    for kind in ["terrain", "hole", "partial-hole", "impassable"] {
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        let entry = &world.manifest.tiles[0];
        let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
        for chunk in &mut tile.chunks {
            if kind == "hole" {
                chunk.holes = u16::MAX;
            }
            chunk.impassable = kind == "impassable";
        }
        if kind == "partial-hole" {
            tile.chunks[22].holes = u16::MAX;
        }
        world.resident.insert(0, tile);
        world.origin = [200.0, 64.0];
        world.state = State::new([0.0, 100.0, 0.0], -std::f32::consts::FRAC_PI_2).unwrap();
        if kind == "partial-hole" {
            let hs = world
                .motion_heights_at(world.global(), world.state.yaw, 100.0, true)
                .unwrap();
            assert!(hs.iter().any(Option::is_none) && hs.iter().any(Option::is_some));
        }
        let mut falling = world.state;
        for _ in 0..60 {
            world
                .advance(Input {
                    throttle: 1.0,
                    boost: true,
                    ..Default::default()
                })
                .unwrap();
            falling
                .step_with_tuning(Input::default(), [None; 4], FIXED_DT, &world.tuning)
                .unwrap();
            assert_eq!(world.hold, 0, "{kind}");
            assert!(!world.state.grounded, "{kind}");
            assert!(
                (world.state.velocity[1] - falling.velocity[1]).abs() < 0.001,
                "{kind}"
            );
        }
        assert!(world.global()[0] > 205.0, "{kind}");
        assert!(world.state.velocity[0] > 20.0, "{kind}");
        assert!(world.state.position[1] < 98.0, "{kind}");
        assert!((world.state.heat - 0.2 / 3.0).abs() < 0.00001, "{kind}");
        if kind == "hole" {
            let before = world.state;
            assert!(world
                .restore_pose(&[world.global()[0], 100.0, 64.0, 0.0])
                .is_err());
            assert_eq!(world.state, before, "Save validation stays strict");
        }
    }
}

#[test]
fn airborne_motion_preserves_unloaded_boundary_ground_and_solid_guards() {
    for (kind, hold) in [
        ("missing", 1),
        ("outside", 2),
        ("ground-hole", 2),
        ("ground-impassable", 2),
        ("wall", 3),
    ] {
        let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
        let entry = &world.manifest.tiles[0];
        let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
        for chunk in &mut tile.chunks {
            chunk.holes = if kind == "ground-hole" { u16::MAX } else { 0 };
            chunk.impassable = kind == "ground-impassable";
        }
        if kind != "missing" {
            world.resident.insert(0, tile);
        }
        world.origin = [200.0, if kind == "outside" { -64.0 } else { 64.0 }];
        let grounded = kind.starts_with("ground-");
        world.state = State::new([0.0, if grounded { 1.1 } else { 100.0 }, 0.0], 0.0).unwrap();
        world.state.grounded = grounded;
        if kind == "wall" {
            world.scene_bounds = vec![[199.0, 90.0, 63.0, 201.0, 110.0, 65.0]];
        }
        let before = world.state;
        world
            .advance(Input {
                throttle: 1.0,
                boost: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(world.hold, hold, "{kind}");
        assert_eq!(world.state, before, "{kind}: failed motion is atomic");
    }
}

#[test]
fn restore_accepts_reachable_high_hover_and_airborne_poses() {
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    world.origin = [1000.0, 64.0];
    world.state = State::new([0.0, 30.0, 0.0], 0.0).unwrap();
    world.tuning.hover_height = 30.0;
    for _ in 0..600 {
        world.advance(Input::default()).unwrap();
    }
    let saved = [1000.0, f64::from(world.state.position[1]), 64.0, 0.0];
    assert!(saved[1] > 29.9);
    world.restore_pose(&saved).unwrap();
    assert_eq!(f64::from(world.state.position[1]), saved[1]);
    world.restore_pose(&[1000.0, 2000.0, 64.0, 0.0]).unwrap();
    assert_eq!(world.state.position[1], 2000.0);
}

#[test]
fn restore_queries_destination_height_over_holes_and_rejects_occupied_poses_atomically() {
    for shift in [0.0, 1.0e9] {
        let mut world = Voyage::from_manifest(fixture(shift)).unwrap();
        let entry = &world.manifest.tiles[0];
        let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
        for chunk in &mut tile.chunks {
            chunk.holes = u16::MAX;
        }
        world.resident.insert(0, tile);
        let x = shift + 200.0;
        world.scene_mesh = CollisionTree::new(&[
            x - 20.0,
            20.0,
            40.0,
            x + 20.0,
            20.0,
            40.0,
            x - 20.0,
            20.0,
            90.0,
            x + 20.0,
            20.0,
            40.0,
            x + 20.0,
            20.0,
            90.0,
            x - 20.0,
            20.0,
            90.0,
        ])
        .unwrap();
        assert!(
            world.heights([x, 64.0], 0.0).is_err(),
            "Old body Y cannot see the destination deck"
        );
        world.restore_pose(&[x, 21.1, 64.0, 0.0]).unwrap();
        assert_eq!(world.global(), [x, 64.0]);
        world.state.velocity = [12.0, 3.0, 4.0];
        world.state.bank = 0.2;
        world.state.heat = 0.5;
        let previous = (world.state, world.origin, world.hold, world.rebases);
        for pose in [
            vec![x, 20.4, 64.0, 0.0],
            vec![x, 19.0, 64.0, 0.0],
            vec![x, f64::MAX, 64.0, 0.0],
            vec![x, 21.1, 64.0, f64::NAN],
            vec![x, 21.1, 64.0],
        ] {
            assert!(world.restore_pose(&pose).is_err());
            assert_eq!(
                (world.state, world.origin, world.hold, world.rebases),
                previous
            );
        }
        world.restore_pose(&[x, 21.1, 64.0, 0.0]).unwrap();
        assert_eq!(world.state.heat, 0.5, "restoring a pose keeps engine heat");
        world.state.velocity = [12.0, 3.0, 4.0];
        world.state.bank = 0.2;
        let previous = (world.state, world.origin, world.hold, world.rebases);
        world.resident.clear();
        assert!(world.restore_pose(&[x, 21.1, 64.0, 0.0]).is_err());
        assert_eq!(
            (world.state, world.origin, world.hold, world.rebases),
            previous
        );
    }
}

use super::*;

#[test]
fn detailed_water_preserves_authored_ramps_without_changing_ground_geometry() {
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    let entry = &world.manifest.tiles[0];
    let mut tile = crate::world::tests::flat_tile(entry.x, entry.y);
    world.resident.insert(0, tile.clone());
    let ground = world.geometry(0).unwrap();
    let positions = tile.chunks[0].positions[..4].to_vec();
    tile.chunks[0].liquids.push(benilla_formats::LiquidMesh {
        grid: [2, 2],
        wet: vec![true],
        shared: vec![false],
        positions,
        uvs: vec![[0.0, 0.0]; 4],
        depths: vec![0.0, 0.25, 0.75, 1.0],
        indices: vec![0, 1, 2, 2, 1, 3],
        sound_nibble: 0,
        material_id: None,
        kind: LiquidKind::Still,
    });
    world.validate_tile(0, &tile).unwrap();
    world.resident.insert(0, tile.clone());
    let geometry = world.geometry(0).unwrap();
    assert_eq!(
        geometry
            .chunks_exact(7)
            .filter(|v| v[6] == 0.0)
            .flatten()
            .copied()
            .collect::<Vec<_>>(),
        ground
    );
    let water = geometry
        .chunks_exact(7)
        .filter(|v| v[6] == 2.0)
        .collect::<Vec<_>>();
    for (vertex, ramp) in water.iter().zip([0.0, 0.25, 0.75, 0.75, 0.25, 1.0]) {
        assert_eq!(&vertex[3..6], &[ramp, 1.0, 1.0]);
    }
    assert_eq!(water.len(), 6);
    for invalid in [f32::NAN, -0.01, 1.01] {
        tile.chunks[0].liquids[0].depths[0] = invalid;
        assert!(world.validate_tile(0, &tile).is_err());
    }
}

#[test]
fn browser_defaults_match_requested_handling_and_reset_preserves_overrides() {
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    let tile = &world.manifest.tiles[0];
    world
        .resident
        .insert(0, crate::world::tests::flat_tile(tile.x, tile.y));
    assert_eq!(
        world.tuning(),
        vec![
            150.0, 300.0, 50.0, 30.0, 30.0, 0.25, 2.2, 10.0, 8.0, 1.5, 1.3, 3.0, 90.0, 18.0, 48.0,
            7.0, 0.9
        ]
    );
    world.initialize_spawn().unwrap();
    assert_eq!(world.state.position[1], 3.0);
    world.tuning.hover_height = 7.0;
    world.tuning.max_speed = 42.0;
    world.reset();
    world.initialize_spawn().unwrap();
    assert_eq!(world.state.position[1], 7.0);
    assert_eq!(world.tuning.max_speed, 42.0);
    assert_eq!(
        Tuning::default().max_speed,
        36.0,
        "Native defaults are not changed by the web adapter"
    );
}

#[test]
fn authored_bounds_block_swept_thin_walls_but_not_rooftop_support() {
    let wall = [5.0, 0.0, -2.0, 5.01, 4.0, 2.0];
    assert!(swept_box([0.0, 1.0, 0.0], [10.0, 1.0, 0.0], wall));
    assert!(!swept_box([0.0, 5.1, 0.0], [10.0, 5.1, 0.0], wall));
    assert!(!swept_box([0.0, 1.0, 5.0], [10.0, 1.0, 5.0], wall));
}

pub fn fixture(shift: f64) -> Manifest {
    let mut m = Manifest {
        version: 1,
        label: "test".into(),
        regions: vec![
            Region {
                id: "west".into(),
                map: "Kalimdor".into(),
                tile_origin: [41, 33],
                tile_count: [1, 1],
                placement: [shift, 0.0],
                frame: 0,
            },
            Region {
                id: "east".into(),
                map: "Azeroth".into(),
                tile_origin: [28, 51],
                tile_count: [1, 1],
                placement: [shift + 2000.0, 0.0],
                frame: 0,
            },
        ],
        tiles: vec![],
        horizons: vec![],
        world_bounds: None,
        ocean: [shift + TILE, 0.0, shift + 2000.0, TILE],
        sea_level: 0.0,
        spawn: [shift + 200.0, 1.1, 64.0, 0.0],
        destination: [shift + 2200.0, 64.0],
        frames: None,
    };
    for (region, r) in m.regions.iter().enumerate() {
        m.tiles.push(TileEntry {
            region,
            x: r.tile_origin[0],
            y: r.tile_origin[1],
            file: format!("{}_{}_{}.adt", r.map, r.tile_origin[0], r.tile_origin[1]),
            bytes: 1,
            sha256: "a".repeat(64),
        });
    }
    m
}

#[test]
fn source_placement_and_unloaded_terrain_are_distinct_from_ocean() {
    let m = fixture(1.0e9);
    m.validate().unwrap();
    assert_eq!(
        m.regions[0].source([1.0e9 + 200.0, 64.0]),
        [-597.3333, -5000.0, 0.0]
    );
    let world = Voyage::from_manifest(m).unwrap();
    assert_eq!(world.sample([1.0e9 + 200.0, 64.0]).availability, 1);
    assert_eq!(world.sample([1.0e9 + 1000.0, 64.0]).water, Some(0.0));
    assert_eq!(world.sample([1.0e9 + 1000.0, -1.0]).availability, 2);
}

#[test]
fn floating_origin_preserves_global_motion_at_billion_yard_offset() {
    let mut a = Voyage::from_manifest(fixture(0.0)).unwrap();
    let mut b = Voyage::from_manifest(fixture(1.0e9)).unwrap();
    for (world, shift) in [(&mut a, 0.0), (&mut b, 1.0e9)] {
        world.origin = [shift + 700.0, 64.0];
        world.state = State::new([0.0, 1.1, 0.0], -std::f32::consts::FRAC_PI_2).unwrap();
    }
    for _ in 0..3000 {
        let input = Input {
            throttle: 1.0,
            ..Default::default()
        };
        a.advance(input).unwrap();
        b.advance(input).unwrap();
    }
    assert!(a.rebases >= 2);
    assert!((a.global()[0] - (b.global()[0] - 1.0e9)).abs() < 0.001);
    assert!(b.state.position[0].abs() < 256.0);
    assert_eq!(a.sample(a.global()).water, Some(0.0));
}

#[test]
fn bad_manifest_cannot_turn_missing_land_into_ocean() {
    let mut m = fixture(0.0);
    m.ocean[0] = 0.0;
    assert!(m.validate().is_err());
    m = fixture(0.0);
    m.tiles.pop();
    assert!(m.validate().is_err());
    m = fixture(0.0);
    m.regions[0].placement[0] = f64::NAN;
    assert!(m.validate().is_err());
}

#[test]
fn full_world_bounds_bracket_ocean_without_granting_wdl_collision() {
    let mut m = fixture(0.0);
    m.version = 2;
    m.horizons = vec![
        HorizonEntry {
            region: 0,
            file: "Kalimdor.wdl".into(),
            bytes: 100,
            sha256: "a".repeat(64),
            source_bounds: [40, 32, 43, 34],
        },
        HorizonEntry {
            region: 1,
            file: "Azeroth.wdl".into(),
            bytes: 100,
            sha256: "b".repeat(64),
            source_bounds: [27, 50, 30, 52],
        },
    ];
    m.ocean = [2.0 * TILE, -TILE, 2000.0 - TILE, TILE];
    m.validate().unwrap();
    let world = Voyage::from_manifest(m.clone()).unwrap();
    assert_eq!(world.sample([-100.0, 100.0]).availability, 2);
    assert_eq!(world.sample([1200.0, 100.0]).water, Some(0.0));
    m.regions[1].placement[0] = 1000.0;
    assert!(m.validate().is_err());
}

#[test]
fn durability_overheat_wears_engines_and_impacts_hurt_by_speed() {
    let mut world = Voyage::from_manifest(fixture(0.0)).unwrap();
    assert_eq!(world.telemetry()[15..17], [1.0, 1.0]);
    // Overheating: 5 s at full heat takes about 0.75 of health split 60/40 across the engines.
    world.state.heat = 1.0;
    for _ in 0..600 {
        world.durability_step(0);
    }
    let h = world.state.health;
    assert!(
        (1.0 - h[0] - 0.45).abs() < 0.01 && (1.0 - h[1] - 0.30).abs() < 0.01,
        "{h:?}"
    );
    // Cooling below the damage band swaps which engine runs hotter next time.
    world.state.heat = 0.5;
    world.durability_step(0);
    world.state.heat = 1.0;
    world.durability_step(0);
    assert!(world.dur.hot_side == 1);
    // Impacts: damage follows the speed before the contact edge, alternating engines; holding contact deals no more.
    world.state.health = [1.0; 2];
    world.state.heat = 0.0;
    world.state.velocity = [60.0, 0.0, 0.0];
    world.durability_step(0);
    world.hold = 3;
    world.state.velocity = [0.0; 3];
    world.durability_step(0);
    world.durability_step(3);
    world.hold = 0;
    assert!((world.state.health[0] - 0.5).abs() < 1e-5 && world.state.health[1] == 1.0);
    world.state.velocity = [10.0, 0.0, 0.0];
    world.durability_step(0);
    world.hold = 3;
    world.durability_step(0);
    assert_eq!(world.state.health, [0.5, 1.0], "a slow bump is free");
    world.hold = 0;
    world.state.velocity = [100.0, 0.0, 0.0];
    world.durability_step(0);
    world.hold = 3;
    world.durability_step(0);
    assert_eq!(
        world.state.health,
        [0.0, 1.0],
        "lethal speed destroys the engine it hits"
    );
    // Off: no damage; restore keeps health, reset repairs.
    world.dur.on = false;
    world.state.heat = 1.0;
    world.durability_step(0);
    assert_eq!(world.state.health, [0.0, 1.0]);
    world.reset();
    assert_eq!(world.state.health, [1.0, 1.0]);
    world.state.health = [0.2, 0.5];
    world.state.heat = 0.7;
    world.repair();
    assert_eq!(
        (world.state.health, world.state.heat),
        ([1.0, 1.0], 0.0),
        "repair makes a fresh craft"
    );
}
