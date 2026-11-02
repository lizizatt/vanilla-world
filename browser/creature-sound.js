// Creature death sounds from the user's own Data: CreatureDisplayInfo.SoundID -> CreatureSoundData.SoundDeathID -> SoundEntries files.
// Resolved and read in the world worker, played positionally on the main thread. Nothing is stored; a creature with no entry is silent.
import { table, index } from './music.js';

export const CREATURE_SOUND = Object.freeze({
  displayModelField: 1, displaySoundField: 2,   // CreatureDisplayInfo: ID, ModelID, SoundID (an override, set on only ~3% of real displays)
  modelSoundField: 13,    // CreatureModelData: SoundID, the usual source (verified on real 1.12 Data)
  deathField: 6,          // CreatureSoundData: ID, Exertion, ExertionCritical, Injury, InjuryCritical, InjuryCrushingBlow, Death
  entryFirstFile: 3, entryFileCount: 10, entryDirField: 23,
  maxBytes: 2 * 1024 * 1024,
  refDistance: 8,         // yd at full gain
  maxDistance: 320,       // yd beyond which the sound is dropped
  rolloff: 1.4,
  gain: .9,
  maxVoices: 6,
});
const SOUND_PATH = /^sound\\[^:*?"<>|]+\.(wav|mp3)$/i;

// Display and CreatureSoundData layouts differ slightly between builds, so only the header is checked and fields are read by index.
export function looseTable(bytes, name) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 20 || bytes.length > 16 * 1024 * 1024 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'WDBC') throw Error(`Invalid ${name} DBC`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(4, true), fields = view.getUint32(8, true),
    stride = view.getUint32(12, true), strings = view.getUint32(16, true), base = 20 + count * stride;
  if (stride < fields * 4 || base + strings !== bytes.length) throw Error(`Unsupported ${name} DBC layout`);
  return { count, fields, u32: (row, field) => (field < fields ? view.getUint32(20 + row * stride + field * 4, true) : 0), strings: { base, size: strings }, bytes };
}

export class CreatureSoundCatalog {
  constructor(displayBytes, dataBytes, entryBytes, modelBytes) {
    this.displays = looseTable(displayBytes, 'CreatureDisplayInfo'); this.data = looseTable(dataBytes, 'CreatureSoundData');
    this.entries = table(entryBytes, 29, 116, 'SoundEntries');
    this.models = modelBytes ? looseTable(modelBytes, 'CreatureModelData') : undefined; this.modelRows = this.models && index(this.models);
    this.displayRows = index(this.displays); this.dataRows = index(this.data); this.entryRows = index(this.entries);
  }
  /** Every candidate death file (full MPQ path) for a creature display id; empty when it has none. */
  deathPaths(displayId, c = CREATURE_SOUND) {
    const d = this.displayRows.get(displayId);
    if (d === undefined) return [];
    let data = this.dataRows.get(this.displays.u32(d, c.displaySoundField));
    if (data === undefined && this.models) {
      const m = this.modelRows.get(this.displays.u32(d, c.displayModelField));
      if (m !== undefined) data = this.dataRows.get(this.models.u32(m, c.modelSoundField));
    }
    if (data === undefined) return [];
    const entry = this.entryRows.get(this.data.u32(data, c.deathField));
    if (entry === undefined) return [];
    const dir = this.entries.str(entry, c.entryDirField), paths = [];
    for (let f = c.entryFirstFile; f < c.entryFirstFile + c.entryFileCount; f++) {
      const file = this.entries.str(entry, f);
      if (!file) continue;
      const path = dir && !dir.endsWith('\\') ? `${dir}\\${file}` : `${dir}${file}`;
      if (path.length <= 260 && SOUND_PATH.test(path)) paths.push(path);
    }
    return paths;
  }
}

/** Worker side: resolves a display id to one death sound and reads it once per path. Failures resolve to undefined (silence). */
export class CreatureSounds {
  constructor(source, rand = Math.random) {
    this.source = source; this.rand = rand; this.catalog = undefined; this.loading = undefined; this.sent = new Set(); this.failed = false;
  }
  load() {
    const read = n => this.source.read(`DBFilesClient\\${n}.dbc`, { background: true });
    return this.loading ??= Promise.all([read('CreatureDisplayInfo'), read('CreatureSoundData'),     read('SoundEntries'), read('CreatureModelData').catch(() => undefined)])
          .then(([a, b, c, d]) => (this.catalog = new CreatureSoundCatalog(a, b, c, d)), () => { this.failed = true; });
  }
  /** {path, bytes} (bytes only the first time a path is sent) or undefined. */
  async death(displayId) {
    try {
      if (this.failed) return undefined;
      await this.load();
      const paths = this.catalog?.deathPaths(displayId);
      if (!paths?.length) return undefined;
      const path = paths[Math.floor(this.rand() * paths.length)];
      if (this.sent.has(path)) return { path };
      const bytes = await this.source.read(path, { background: true });
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CREATURE_SOUND.maxBytes) return undefined;
      this.sent.add(path);
      return { path, bytes };
    } catch { return undefined; }
  }
}

/** Positional gain model shared by tests and the panner setup: inverse-distance rolloff, dropped past maxDistance. */
export function spatialGain(eye, pos, c = CREATURE_SOUND) {
  const distance = Math.hypot(pos[0] - eye[0], pos[1] - eye[1], pos[2] - eye[2]);
  if (!(distance <= c.maxDistance)) return { distance, gain: 0, audible: false };
  const gain = c.gain * c.refDistance / (c.refDistance + c.rolloff * (Math.max(distance, c.refDistance) - c.refDistance));
  return { distance, gain, audible: gain > .01 };
}
