// NPC population loading. Two packs, same runtime shape: the private full pack (/local/npc-spawns.json, loopback only) and the
// optional trimmed public pack (./npc-pack.json: positions + display ids only; models are resolved from the user's own Data).
export const PUBLIC_PACK_URL = './npc-pack.json';
const DBC = 'DBFilesClient\\';
const json = r => r?.ok && /json/.test(r.headers.get('content-type') || '');

export function decodeTrimmed(pack) {
  if (pack?.version !== 1 || pack.format !== 'npc-trimmed-v1' || pack.provenance?.redistribution !== 'public-trimmed'
      || !Array.isArray(pack.spawns) || pack.spawns.length > 200000) throw new Error('Invalid trimmed NPC pack');
  const spawns = pack.spawns.map((s, id) => {
    if (!Array.isArray(s) || s.length !== 7 || !s.every(Number.isFinite)) throw new Error('Invalid trimmed NPC spawn');
    return { id, map: s[0], displayId: s[1], position: [s[2] / 10, s[3] / 10, s[4] / 10], orientation: s[5] / 100, scale: s[6] / 100 };
  });
  return { version: 1, provenance: pack.provenance, spawns };
}

// Adds the display -> model map from the user's DBCs; spawns whose display is unknown are dropped, like resolve_npcs.
export async function resolveModels(pack, source, wasm) {
  const ids = [...new Set(pack.spawns.map(s => s.displayId))];
  const [models, displays] = await Promise.all([source.read(`${DBC}CreatureModelData.dbc`), source.read(`${DBC}CreatureDisplayInfo.dbc`)]);
  const extra = await source.read(`${DBC}CreatureDisplayInfoExtra.dbc`).catch(() => new Uint8Array());
  const map = JSON.parse(wasm.scene_resolve_displays(models, displays, extra, Uint32Array.from(ids)));
  return { ...pack, models: map, spawns: pack.spawns.filter(s => Object.hasOwn(map, s.displayId)) };
}

// Private pack first (loopback only), then the hosted trimmed pack. Absent or HTML-fallback responses mean no creatures, never an error.
export async function loadPopulation({ fetchFn = fetch, loopback, source, wasm }) {
  if (loopback) {
    const r = await fetchFn('./local/npc-spawns.json').catch(() => undefined);
    if (json(r)) { const pack = await r.json().catch(() => undefined); if (pack) return pack; }
    else if (r && r.status >= 500) throw new Error(`Private NPC companion failed: HTTP ${r.status}`);
  }
  const r = await fetchFn(PUBLIC_PACK_URL).catch(() => undefined);
  if (!json(r)) return undefined;
  try { return await resolveModels(decodeTrimmed(await r.json()), source, wasm); } catch { return undefined; }
}
