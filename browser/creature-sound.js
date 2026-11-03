// Creature death sounds from the user's own Data: CreatureDisplayInfo.SoundID -> CreatureSoundData.SoundDeathID -> SoundEntries files.
// Resolved and read in the world worker, played positionally on the main thread. Nothing is stored; a creature with no entry is silent.
import { table, index } from './music.js';

export const CREATURE_SOUND = Object.freeze({
  displayModelField: 1, displaySoundField: 2,   // CreatureDisplayInfo: ID, ModelID, SoundID (an override, set on only ~3% of real displays)
  modelSoundField: 13,    // CreatureModelData: SoundID, the usual source (verified on real 1.12 Data)
  deathField: 6,          // CreatureSoundData: ID, Exertion, ExertionCritical, Injury, InjuryCritical, InjuryCrushingBlow, Death
  entryFirstFile: 3, entryFileCount: 10, entryDirField: 23,
  maxBytes: 2 * 1024 * 1024,
  gain: .9,               // fixed: death cries are ours, so they do not attenuate with distance
  maxVoices: 6,
  retryMs: 5000, cachedFiles: 16,
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

/**
 * Worker side: resolves a display id to one death sound. Every result carries its own copy of the bytes, so the main thread never depends on
 * an earlier message having been decoded (a dropped first message used to silence that file for the rest of the session). Reads are foreground:
 * background reads are deferred, and rejected, while terrain streams, which is exactly when a creature is being flown through.
 * A failed load is retried after retryMs rather than disabling death sounds for good.
 */
export class CreatureSounds {
  constructor(source, rand = Math.random, now = Date.now) {
    this.source = source; this.rand = rand; this.now = now; this.catalog = undefined; this.loading = undefined; this.files = new Map(); this.retryAt = 0;
  }
  load() {
    if (this.catalog || (!this.loading && this.now() < this.retryAt)) return Promise.resolve();
    const read = n => this.source.read(`DBFilesClient\\${n}.dbc`);
    return this.loading ??= Promise.all([read('CreatureDisplayInfo'), read('CreatureSoundData'), read('SoundEntries'), read('CreatureModelData').catch(() => undefined)])
      .then(([a, b, c, d]) => { this.catalog = new CreatureSoundCatalog(a, b, c, d); }, () => { this.loading = undefined; this.retryAt = this.now() + CREATURE_SOUND.retryMs; });
  }
  /** {path, bytes} (a private copy, safe to transfer) or undefined. */
  async death(displayId) {
    try {
      if (!this.catalog && this.now() < this.retryAt) return undefined;
      await this.load();
      const paths = this.catalog?.deathPaths(displayId);
      if (!paths?.length) return undefined;
      const path = paths[Math.floor(this.rand() * paths.length)];
      let bytes = this.files.get(path);
      if (!bytes) {
        bytes = await this.source.read(path);
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CREATURE_SOUND.maxBytes) return undefined;
        if (this.files.size >= CREATURE_SOUND.cachedFiles) this.files.delete(this.files.keys().next().value);
        this.files.set(path, bytes);
      }
      return { path, bytes: bytes.slice() };
    } catch { return undefined; }
  }
}

/** A kill's death cry plays at full gain wherever it is: no distance rolloff and no distance cutoff (left/right panning is the panner's job). */
export function spatialGain(eye, pos, c = CREATURE_SOUND) {
  return { distance: Math.hypot(pos[0] - eye[0], pos[1] - eye[1], pos[2] - eye[2]), gain: c.gain, audible: true };
}
