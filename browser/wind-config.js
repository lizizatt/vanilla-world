// Single source for the procedural wind (design/wind.md). wind.js (CPU) and wind-wgsl.js (the shader twin) read these numbers;
// wind-particles.js reads the thresholds and budgets. Lengths in yards, speeds in yd/s, times in seconds.
import {FLOW} from './cloud-flow.js';
import {WAVE_PERIOD,WAVE_WIND} from './wave-config.js';

export const WIND={
  // Wall-clock period of the gust field. Every gust frequency is 2 pi n / period with an integer n, so the wrapped clock never jumps.
  period:WAVE_PERIOD,
  // Surface wind is this fraction of the planetary belt wind (cloud-flow beltWind), which is an upper-air advection speed.
  beltScale:.35,
  // Heading used where the belt wind is calm (rad from +x toward +z, the wave heading).
  fallbackHeading:WAVE_WIND,
  // Speed (yd/s) that maps to strength 1.
  maxSpeed:28,
  // Gust field: three travelling sines. k = wavenumber (rad/yd) vector, n = integer frequency multiple, w = weight (sum 1), p = phase.
  gust:[{k:[.0021,.0013],n:6,w:.5,p:1.3},{k:[.0089,-.0054],n:17,w:.3,p:4.1},{k:[-.031,.022],n:50,w:.2,p:2.2}],
  // Wind direction veers by up to this many radians with the middle gust term.
  veer:.35,
  // Storm: extra speed at storm level 1 (rain intensity or Maelstrom proximity); ramp of the storm level that counts.
  storm:{add:22,ramp:[.3,.9]},
  // Maelstrom: counter-clockwise swirl with the cloud vortex numbers; inside `halo` the wind is a gale even without rain.
  mael:{core:FLOW.vortex.core,decay:FLOW.vortex.decay,speed:FLOW.vortex.speed,inflow:FLOW.vortex.inflow,halo:3},
  // Zone character: floor (yd/s) and gain applied to the belt wind, and the gust depth 0..1. Character comes from the AreaTable zone name/flags.
  zones:{
    sea:{floor:3,gain:1,gust:.3},coast:{floor:4,gain:1.1,gust:.3},plains:{floor:3,gain:.9,gust:.3},forest:{floor:0,gain:.5,gust:.2},
    mountain:{floor:4,gain:1.3,gust:.5},desert:{floor:5,gain:1.4,gust:.45},snow:{floor:5,gain:1.3,gust:.45},
  },
  // Time constant (s) of the smoothed zone parameters, so crossing a zone border eases the wind rather than jumping it.
  tau:3,
  // Effect ramps over wind strength 0..1: spray from crests, blowing dust, blowing snow. Below `on` nothing draws and nothing is paid for.
  spray:{on:.28,full:.65},dust:{on:.45,full:.8},snow:{on:.4,full:.75},
  // Blowing dust/snow drifts at this fraction of the wind speed on land (the streaks themselves still align to the wind).
  groundSpeed:.5,
  // Terrain-following ground layer: world-anchored height grid (n x n cells, step yd apart) around the eye, `budget` new cells queried per frame, `clear` yd of headroom.
  grid:{n:15,step:4,budget:48,clear:.3},
  // Sea state fed to the water shader: windK = max(belt windK, calm + (1-calm)*strength).
  seaCalm:.2,
  // Particle box (yd) around the eye and per-tier instance budgets (weatherQuality tiers).
  box:{spray:56,ground:48,height:3.2},
  quality:{off:0,low:320,standard:1100,high:2600},
};
