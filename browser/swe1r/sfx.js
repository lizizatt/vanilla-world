// Podracer sound effects from the optional SWE1R folder (data\wavs\22K, plain 16-bit PCM). Read into memory only.
// Boost: one-shot on each key press, then a loop while held. Candidate pairs: swe1r\sound-browser.mjs (Boost A/B).
export const BOOST = { start: 'sfx_pod_flamethrower_on', loop: 'sfx_pod_flamethrower_loop' };
export const SFX = {
  engine: 'sfx_pod_varipitch_d_loop', boost: BOOST.loop,
  beep: 'sfx_start_beep', go: 'sfx_start_game', gate: 'sfx_pod_switch_a',
  finish: 'sfx_payoff_bell', crash: 'sfx_crash_metal_med1', ignite: BOOST.start, brakeOn: 'sfx_pod_airbrakes_on', brakeOff: 'sfx_pod_airbrakes_off', drift: 'sfx_pod_binder_activate_a', driftLoop: 'sfx_pod_binder_steady_loop',
};

// Engine heat: graduated klaxon loops from the warning zone up, coolant spray while venting after a hot run.
export const HEAT = { klaxon: ['sfx_klaxon1_loop', 'sfx_klaxon2_loop', 'sfx_klaxon3_loop'], coolOn: 'sfx_pod_coolant_spray_on', cool: 'sfx_pod_coolant_spray_loop' };
export const heatStage = heat => heat >= .97 ? 3 : heat >= .9 ? 2 : heat >= .8 ? 1 : 0; // 0.8 = flats-racer-physics HEAT_WARN

// Race-end stingers from data\wavs\Music (not cached; available via the picked folder or files).
export const STINGER = { win: 'Music/m010podanni', wipeout: ['Music/m032wipeout2', 'Music/m032wipeout3'] };

// Race music pool; null = keep our own battle music.
export const RACE_MUSIC = ['Music/PodLoop1', 'Music/PsycheLoop', 'Music/SebulbaLoop', null];
export const pickRaceMusic = (random = Math.random) => RACE_MUSIC[Math.floor(random() * RACE_MUSIC.length)];

// Wipeout blast (played when the craft gibs): one gas explosion layered with a metal or fiery crash, resolved against the 22K listing.
// The install spells the fiery family 'firey'.
export function wipeoutBlast(names, random = Math.random) {
  const has = prefix => [...names].filter(n => n.startsWith(prefix));
  const gas = has('sfx_explo_gas_');
  const crash = has(random() < .5 ? 'sfx_crash_metal_' : 'sfx_crash_firey_');
  const pick = list => list[Math.floor(random() * list.length)];
  return [gas, crash].filter(l => l.length).map(pick);
}

export const WIPEOUT_NAMES = ['sfx_explo_gas_01', 'sfx_explo_gas_02', 'sfx_explo_gas_03', 'sfx_crash_metal_boomy', 'sfx_crash_metal_med2', 'sfx_crash_metal_scrape', 'sfx_crash_metal_short', 'sfx_crash_firey_a', 'sfx_crash_firey_b', 'sfx_crash_firey_c'];

export async function loadSfx(reader, names = Object.values(SFX)) {
  const out = new Map();
  for (const n of names) { const b = await reader.wav?.(n); if (b?.length > 44) out.set(n, b); }
  return out;
}
