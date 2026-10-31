// Single source for the procedural wind (design/wind.md). wind.js (CPU) and wind-wgsl.js (the shader twin) read these numbers;
// wind-particles.js reads the thresholds and budgets. Lengths in yards, speeds in yd/s, times in seconds.
import {FLOW} from './cloud-flow.js';
import {WAVE_PERIOD,WAVE_WIND} from './wave-config.js';

// Second tuning pass: every wind speed (belt, floors, storm, Maelstrom, maxSpeed) is this fraction of the first pass, so effects keep their strength thresholds but move 35% slower.
const SLOW=.65;

export const WIND={
  // Wall-clock period of the gust field. Every gust frequency is 2 pi n / period with an integer n, so the wrapped clock never jumps.
  period:WAVE_PERIOD,
  // Surface wind is this fraction of the planetary belt wind (cloud-flow beltWind), which is an upper-air advection speed.
  beltScale:.35*SLOW,
  // Heading used where the belt wind is calm (rad from +x toward +z, the wave heading).
  fallbackHeading:WAVE_WIND,
  // Speed (yd/s) that maps to strength 1.
  maxSpeed:28*SLOW,
  // Gust field: three travelling sines. k = wavenumber (rad/yd) vector, n = integer frequency multiple, w = weight (sum 1), p = phase.
  gust:[{k:[.0021,.0013],n:6,w:.5,p:1.3},{k:[.0089,-.0054],n:17,w:.3,p:4.1},{k:[-.031,.022],n:50,w:.2,p:2.2}],
  // Wind direction veers by up to this many radians with the middle gust term.
  veer:.35,
  // Storm: extra speed at storm level 1 (rain intensity or Maelstrom proximity); ramp of the storm level that counts.
  storm:{add:22*SLOW,ramp:[.3,.9]},
  // Maelstrom: counter-clockwise swirl with the cloud vortex numbers; inside `halo` the wind is a gale even without rain.
  mael:{core:FLOW.vortex.core,decay:FLOW.vortex.decay,speed:FLOW.vortex.speed*SLOW,inflow:FLOW.vortex.inflow,halo:3},
  // Zone character: floor (yd/s) and gain applied to the belt wind, and the gust depth 0..1. Character comes from the AreaTable zone name/flags.
  zones:{
    sea:{floor:3*SLOW,gain:1,gust:.3},coast:{floor:4*SLOW,gain:1.1,gust:.3},plains:{floor:3*SLOW,gain:.9,gust:.3},forest:{floor:0,gain:.5,gust:.2},
    mountain:{floor:4*SLOW,gain:1.3,gust:.5},desert:{floor:5*SLOW,gain:1.4,gust:.45},snow:{floor:5*SLOW,gain:1.3,gust:.45},
  },
  // Time constant (s) of the smoothed zone parameters, so crossing a zone border eases the wind rather than jumping it.
  tau:3,
  // Effect ramps over wind strength 0..1: spray from crests, blowing dust, blowing snow. Below `on` nothing draws and nothing is paid for.
  // Second pass: ground effects start later and ramp slower, so a moderate wind no longer blows sand.
  spray:{on:.32,full:.72},dust:{on:.52,full:.9},snow:{on:.48,full:.85},
  // Blowing dust/snow drifts at this fraction of the wind speed on land (the streaks themselves still align to the wind).
  groundSpeed:.5,
  // Terrain-following ground layer: world-anchored height grid (n x n cells, step yd apart, ~240 yd across) around the eye, `budget` new cells queried per frame,
  // `clear` yd of headroom (plus `clearFar` per yd of distance, since the far lattice is coarse).
  grid:{n:41,step:6,budget:64,clear:.05,clearFar:.004},
  // Ground layer look (second pass): thin wisps hugging the ground. height = vertical extent in yd (WoW units are yards: 0.3-0.7 yd is 1-2 ft),
  // alpha = peak opacity per streak (dust, snow), far = share of the particle budget spent on the far ring.
  ground:{height:.3,alpha:{dust:.34,snow:.5},far:.55},
  // Spray (second pass): subtle, crest-only. alpha = peak opacity, crest = minimum crest measure (height fraction + steepness) that emits.
  sprayLook:{alpha:.34,crest:[.62,.9],far:.5},
  // Sea state fed to the water shader: windK = max(belt windK, calm + (1-calm)*strength).
  seaCalm:.2,
  // Particle boxes (yd) around the eye: near boxes hold fine detail, far boxes (a whole multiple of the near box, so the drift wrap stays seamless)
  // hold distance-scaled particles for the horizon. Per-tier instance budgets (weatherQuality tiers) are shared by near + far.
  box:{spray:56,sprayFar:280,ground:48,groundFar:240},
  quality:{off:0,low:320,standard:1100,high:2600},
};
