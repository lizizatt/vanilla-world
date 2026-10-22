// Podracer sound effects from the optional SWE1R folder (data\wavs\22K, plain 16-bit PCM). Read into memory only.
export const SFX = {
  engine: 'sfx_pod_varipitch_d_loop', boost: 'sfx_pod_jet_steady_loop',
  beep: 'sfx_start_beep', go: 'sfx_start_game', gate: 'sfx_pod_switch_a',
  finish: 'sfx_payoff_bell', crash: 'sfx_crash_metal_med1', ignite: 'sfx_pod_flare_fire', brakeOn: 'sfx_pod_airbrakes_on', brakeOff: 'sfx_pod_airbrakes_off',
};

// Race-end stingers from data\wavs\Music (not cached; available via the picked folder or files).
export const STINGER = { win: 'Music/m099awards2', wipeout: ['Music/m032wipeout2', 'Music/m032wipeout3'] };

export async function loadSfx(reader, names = Object.values(SFX)) {
  const out = new Map();
  for (const n of names) { const b = await reader.wav?.(n); if (b?.length > 44) out.set(n, b); }
  return out;
}
