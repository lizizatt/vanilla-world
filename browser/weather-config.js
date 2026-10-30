// Single source for weather numbers (design/weather.md, option A). weather-field.js (CPU), weather-wgsl.js (the shader twin),
// the curtain/particle passes, audio and lightning all read these. Lengths in yards, times in cloud seconds (CloudClock.time).
export const WEATHER={
  // Precipitation cell: low-frequency value noise sampled at the cloud's own advected point, so cells ride the cloud deck.
  cell:{scale:9000,octave2:2.7,mix:.35,gate:[.41,.61]},
  // Only dense cloud rains: coverage ramps in over this range (the sheet's coverage is 0..0.95).
  coverage:[.3,.42],
  // A cell's life: build, plateau, decay over `period` cloud seconds; the phase is spatially smooth so neighbours are out of step.
  life:{period:1100,build:.28,decay:.34},
  // Intensity needed for a cell to count as raining (on) and to stop (off): Schmitt hysteresis for the smoothed camera state.
  on:.5,off:.4,
  // Camera smoothing time constant (s) and the heavy-rain (lightning) level.
  tau:3,heavy:.8,
  // Maelstrom storm: heavy rain inside this fraction of the storm envelope, calm in the eye.
  storm:{from:.22,to:.45,heavy:1},
  fall:{rain:9,snow:1.6},
  // Near-camera particle box (yd) and the instance budget per quality tier.
  box:{half:36,height:30},
  quality:{off:0,low:0,standard:1500,high:3200},
  // Curtain pass: polar sampling grid around the camera and its range (yd).
  polar:{azimuth:64,rings:8,near:300,far:24000},curtain:{start:60,steps:16},
  // Slow-frame / tier switching: camera-effect fallback is the Low tier.
  effect:{streaks:26},
  // Lightning: only in cells at or above `heavy`; mean seconds between strikes at full intensity; speed of sound (yd/s).
  lightning:{minIntensity:.8,meanGap:7,range:14000,flash:.35,soundSpeed:343},
};
export const WEATHER_TIERS=Object.freeze(['off','low','standard','high']);
/** Dry zones that never rain (decision 2), matched against the AreaTable zone name. */
export const DRY_ZONES=Object.freeze(['Tanaris','Silithus','Durotar','Badlands','Searing Gorge','Burning Steppes','Blasted Lands','The Barrens','Desolace','Thousand Needles']);
/** Zones with snow on the ground when the AreaTable cold flag is unavailable (decision 3). */
export const SNOW_ZONES=Object.freeze(['Winterspring','Dun Morogh','Alterac Mountains','Coldridge Valley','Kharanos','Everlook','Ironforge','Gnomeregan']);
