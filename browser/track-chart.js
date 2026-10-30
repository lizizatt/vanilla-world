// Saved track overrides live in the user's IndexedDB and never see repo re-seats. Kalimdor's chart moved +5333.4 yd in z
// (+19 tiles, then -4800) between the first editor releases and now, so an override of a bundled track saved before
// that sits ~5300 yd south of where its bundled copy was re-seated.
export const LEGACY_Z_SHIFT=5333.4;

const shifted=(t,dz)=>({...t,start:{...t.start,pos:[t.start.pos[0],t.start.pos[1],t.start.pos[2]+dz]},
  gates:t.gates.map(g=>({...g,pos:[g.pos[0],g.pos[1],g.pos[2]+dz]}))});

/** Re-seat a stale override onto the current chart when its bundled twin proves the shift (idempotent: only shifts when that lands closer). */
export function migrateOverride(override,shipped) {
  if(!shipped||(override.body??'azeroth')!=='azeroth'||(shipped.body??'azeroth')!=='azeroth')return override;
  const dist=t=>Math.hypot(t.start.pos[0]-shipped.start.pos[0],t.start.pos[2]-shipped.start.pos[2]);
  const moved=shifted(override,LEGACY_Z_SHIFT);
  return dist(moved)<dist(override)&&dist(moved)<1500?moved:override;
}
