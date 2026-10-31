// Single source for weather numbers (design/weather.md, option A). weather-field.js (CPU), weather-wgsl.js (the shader twin),
// the curtain/particle passes, audio and lightning all read these. Lengths in yards, times in cloud seconds (CloudClock.time).
export const WEATHER={
  // Precipitation cell: low-frequency value noise sampled at the cloud's own advected point, so cells ride the cloud deck.
  cell:{scale:9000,octave2:2.7,mix:.35,gate:[.46,.62]},
  // Only dense cloud rains: coverage ramps in over this range (the sheet's coverage is 0..0.95).
  coverage:[.4,.5],
  // A cell's life: build, plateau, decay over `period` cloud seconds; the phase is spatially smooth so neighbours are out of step.
  life:{period:450,build:.28,decay:.34},
  // Intensity needed for a cell to count as raining (on) and to stop (off): Schmitt hysteresis for the smoothed camera state.
  on:.5,off:.4,
  // Camera smoothing time constant (s) and the heavy-rain (lightning) level.
  tau:3,heavy:.8,
  // Maelstrom storm: heavy rain inside this fraction of the storm envelope, calm in the eye.
  storm:{from:.22,to:.45,heavy:1,cover:[.25,.4]},
  fall:{rain:9,snow:1.6},
// Near-camera particle box: side (yd), fall speeds (yd/s), streak time (s), rain width and flake size (yd).
near:{box:50,rainSpeed:30,snowSpeed:3.4,streak:.05,rainWidth:.07,snowSize:.1},
  // Near-camera particle box (yd) and the instance budget per quality tier.
  box:{half:36,height:30},
  quality:{off:0,low:350,standard:1500,high:3200},
  // Curtain pass: polar sampling grid around the camera and its range (yd).
  polar:{azimuth:64,rings:8,near:300,far:24000},curtain:{start:60,steps:20,fall:[250,1400],baseDrop:260,fade:300,streakXZ:140,streakY:900,density:.0025,maxAlpha:.85,wet:.02,edge:[.35,.65]},
  // Rain inside the cloud layer: rain exists from the base up through the layer (height above the base, yd: full to `mid`, gone by `top`), the whole weather stack fades out only above `top`;
  // `haze` is the eye-distance range over which in-layer shafts fade (seen through the cloud), `blend` the half-width of the eye-height ramp around the base that brings in-layer shafts.
  layer:{mid:380,top:900,haze:[4000,16000],blend:150},
  // Rain seen from above (cloud shell from altitude/orbit): precipitation darkens the tops with wind-stretched virga streaks. streak = P modulation depth, dim = extra darkening,
  // ramp = eye height above the cloud top (yd) over which the look fades in; 'low' tier keeps the plain darkening without streaks.
  space:{streak:.65,dim:.7,ramp:[500,6000],stretch:[5200,700,300]},
  // Slow-frame / tier switching: camera-effect fallback is the Low tier.
  effect:{streaks:26},
  // Lightning: only in cells at or above `heavy`; mean seconds between strikes at full intensity; speed of sound (yd/s).
  lightning:{minIntensity:.8,meanGap:7,range:14000,flash:.35,veil:1,soundSpeed:343},
};
export const WEATHER_TIERS=Object.freeze(['off','low','standard','high']);
/** Dry zones that never rain (decision 2), matched against the AreaTable zone name. */
export const DRY_ZONES=Object.freeze(['Tanaris','Silithus','Durotar','Badlands','Searing Gorge','Burning Steppes','Blasted Lands','The Barrens','Desolace','Thousand Needles']);
/** Zones with snow on the ground when the AreaTable cold flag is unavailable (decision 3). */
export const SNOW_ZONES=Object.freeze(['Winterspring','Dun Morogh','Alterac Mountains','Coldridge Valley','Kharanos','Everlook','Ironforge','Gnomeregan']);
