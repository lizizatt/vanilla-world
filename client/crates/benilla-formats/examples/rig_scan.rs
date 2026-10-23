//! Poses every Creature\*.m2 rig through Stand and Walk at a few times and flags models whose posed
//! vertices stray far from the bind bounding box (or go non-finite): the skinning-sanity scan.
//! `cargo run --release -p benilla-formats --example rig_scan -- [<WoW/Data>] [name-filter]`
//! prints one TSV row per flagged model: path, bones, worst stray ratio, clip, time, stray vertex share.

use benilla_formats::{M2Rig, open_chain, parse_m2_render_submeshes};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let first = args.next();
    let (data, filter) = match first {
        Some(a) if std::path::Path::new(&a).is_dir() => (std::path::PathBuf::from(a), args.next()),
        other => (benilla_formats::wow_data().expect("set $WOW_DATA"), other),
    };
    let mut chain = open_chain(&data)?;
    let names: Vec<String> = chain
        .list()?
        .into_iter()
        .map(|e| e.name)
        .filter(|n| {
            let l = n.to_ascii_lowercase();
            l.starts_with("creature\\") && l.ends_with(".m2") && filter.as_ref().is_none_or(|f| l.contains(&f.to_ascii_lowercase()))
        })
        .collect();
    let (mut scanned, mut flagged, mut zero_models) = (0, 0, 0);
    for name in names {
        let Ok(bytes) = chain.read_file(&name) else { continue };
        let dir = name.rsplit_once('\\').map_or("", |p| p.0);
        let skins = vec![None, None, None, None];
        let Ok(bind) = parse_m2_render_submeshes(&bytes, dir, &skins) else { continue };
        let n: usize = bind.iter().map(|s| s.positions.len()).sum();
        if n == 0 {
            continue;
        }
        let Ok(rig) = M2Rig::new(&bytes, &bind, &[0, 4]) else { continue };
        scanned += 1;
        let zero = bind.iter().flat_map(|s| s.normals.iter().zip(&s.weights)).filter(|(n, w)| n.iter().all(|c| c.abs() < 1e-6) && w.iter().any(|&x| x > 0.0)).count();
        if zero > 0 { zero_models += 1; eprintln!("zero-normal {zero}\t{name}"); }
        let (mut lo, mut hi) = ([f32::MAX; 3], [f32::MIN; 3]);
        for p in bind.iter().flat_map(|s| s.positions.iter()) {
            for k in 0..3 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        let diag = (0..3).map(|k| (hi[k] - lo[k]).powi(2)).sum::<f32>().sqrt().max(1e-3);
        let mut edges: Vec<(usize, usize)> = Vec::new();
        let mut off = 0usize;
        for sm in &bind {
            for t in sm.indices.chunks_exact(3) {
                for (a, b) in [(0, 1), (1, 2), (2, 0)] {
                    edges.push((off + t[a] as usize, off + t[b] as usize));
                }
            }
            off += sm.positions.len();
        }
        let bp: Vec<[f32; 3]> = bind.iter().flat_map(|s| s.positions.iter().copied()).collect();
        let dist = |p: &[f32], q: &[f32]| (0..3).map(|k| (p[k] - q[k]).powi(2)).sum::<f32>().sqrt();
        let mut worst: Option<(f32, u16, f32, f32)> = None;
        let mut out = vec![0.0f32; n * 12];
        for anim in [0u16, 4] {
            let Some(dur) = rig.duration(anim) else { continue };
            for f in [0.0, 0.25, 0.5, 0.75] {
                let t = dur * f;
                if rig.pose_into(&bind, anim, t, &mut out).is_err() {
                    worst = Some((f32::INFINITY, anim, t, 1.0));
                    continue;
                }
                let (mut stray, mut far) = (0.0f32, 0usize);
                for v in out.chunks(12) {
                    let mut d = 0.0f32;
                    for k in 0..3 {
                        d = d.max((lo[k] - v[k]).max(v[k] - hi[k]).max(0.0));
                    }
                    if !v[0..3].iter().all(|x| x.is_finite()) {
                        d = f32::INFINITY;
                    }
                    stray = stray.max(d / diag);
                    far += (d / diag > 0.35) as usize;
                }
                let st = edges.iter().filter(|&&(a, b)| {
                    let bl = dist(&bp[a], &bp[b]).max(0.02 * diag);
                    dist(&out[a * 12..], &out[b * 12..]) > 3.0 * bl
                }).count() as f32 / edges.len().max(1) as f32;
                if std::env::var_os("RIG_BONES").is_some() && st > 0.003 {
                    let mut c = std::collections::BTreeMap::new();
                    for &(a, b) in &edges {
                        let bl = dist(&bp[a], &bp[b]).max(0.02 * diag);
                        if dist(&out[a * 12..], &out[b * 12..]) > 3.0 * bl {
                            let (mut ja, mut jb) = (Vec::new(), Vec::new());
                            let mut o = 0;
                            for sm in &bind {
                                for (i, v, w) in [(a, &mut ja, 0), (b, &mut jb, 1)] {
                                    let _ = w;
                                    if i >= o && i < o + sm.positions.len() {
                                        for (j, wt) in sm.joints[i - o].iter().zip(&sm.weights[i - o]) {
                                            if *wt > 0.0 { v.push((*j, (*wt * 100.0) as u32)); }
                                        }
                                    }
                                }
                                o += sm.positions.len();
                            }
                            *c.entry(format!("{ja:?} -- {jb:?}")).or_insert(0) += 1;
                        }
                    }
                    let mut v: Vec<_> = c.into_iter().collect();
                    v.sort_by_key(|x| std::cmp::Reverse(x.1));
                    eprintln!("anim {anim} t {t:.2} st {st:.3}");
                    for (k, n) in v.into_iter().take(8) { eprintln!("  {n} {k}"); }
                }
                let stray = if st > 0.003 { stray.max(1.0) + st } else { stray };
                if worst.is_none_or(|w| stray > w.0) {
                    worst = Some((stray, anim, t, far as f32 / n as f32));
                }
            }
        }
        if let Some((s, anim, t, share)) = worst.filter(|w| w.0 > 0.5) {
            flagged += 1;
            println!("{name}\t{}\t{s:.2}\t{anim}\t{t:.2}\t{share:.3}", n);
        }
    }
    eprintln!("scanned {scanned}, flagged {flagged}, zero-normal models {zero_models}");
    Ok(())
}
