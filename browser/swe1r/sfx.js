// Podracer sound effects from the optional SWE1R folder (data\wavs\22K, plain 16-bit PCM). Read into memory only.
export const SFX = {
  engine: 'sfx_pod_varipitch_d_loop', boost: 'sfx_pod_jet_steady_loop',
  beep: 'sfx_start_beep', go: 'sfx_start_game', gate: 'sfx_pod_switch_a',
  finish: 'sfx_payoff_bell', crash: 'sfx_crash_metal_med1', ignite: 'sfx_pod_flare_fire', brakeOn: 'sfx_pod_airbrakes_on', brakeOff: 'sfx_pod_airbrakes_off',
};

// Race-end stingers from data\wavs\Music (not cached; available via the picked folder or files).
export const STINGER = { win: 'Music/m010podanni', wipeout: ['Music/m032wipeout2', 'Music/m032wipeout3'] };

// Race music pool; null = keep our own battle music.
export const RACE_MUSIC = ['Music/PodLoop1', 'Music/PsycheLoop', 'Music/SebulbaLoop', null];
export const pickRaceMusic = (random = Math.random) => RACE_MUSIC[Math.floor(random() * RACE_MUSIC.length)];

// Wipeout blast (not wired yet): one gas explosion layered with a metal or fiery crash, resolved against the 22K listing.
// The install spells the fiery family 'firey'.
export function wipeoutBlast(names, random = Math.random) {
  const has = prefix => [...names].filter(n => n.startsWith(prefix));
  const gas = has('sfx_explo_gas_');
  const crash = has(random() < .5 ? 'sfx_crash_metal_' : 'sfx_crash_firey_');
  const pick = list => list[Math.floor(random() * list.length)];
  return [gas, crash].filter(l => l.length).map(pick);
}

export async function loadSfx(reader, names = Object.values(SFX)) {
  const out = new Map();
  for (const n of names) { const b = await reader.wav?.(n); if (b?.length > 44) out.set(n, b); }
  return out;
}
