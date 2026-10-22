// Voice-line event map: ids only (never audio). Tags come from the local audition tool (swe1r/audition.mjs).
export const EVENTS = ['countdown-3', 'countdown-2', 'countdown-1', 'countdown-go', 'lap-new', 'final-lap', 'lap-record', 'personal-best', 'finish', 'cancelled', 'crash', 'boost', 'win', 'lose', 'other'];

// tags: { id: event }. Returns { event: [ids sorted] } for known events only (junk/unknown tags are dropped).
export function buildMap(tags) {
  const map = {};
  for (const [id, ev] of Object.entries(tags ?? {})) if (EVENTS.includes(ev)) (map[ev] ??= []).push(id);
  for (const ids of Object.values(map)) ids.sort();
  return Object.fromEntries(Object.keys(map).sort().map(k => [k, map[k]]));
}

// Wav file names (without .wav) from a Voice folder, optionally filtered by prefix.
export const filterIds = (ids, prefix = '') => ids.filter(id => id.toLowerCase().startsWith(prefix.toLowerCase()));

// Picks one voice id for an event, avoiding an immediate repeat; null when none tagged.
export function pickVoice(map, event, last, random = Math.random) {
  const ids = map?.[event];
  if (!ids?.length) return null;
  const pool = ids.length > 1 ? ids.filter(i => i !== last) : ids;
  return pool[Math.floor(random() * pool.length)];
}
