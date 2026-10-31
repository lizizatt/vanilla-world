// Weather runtime (CPU side of design/weather.md option A): samples the precipitation field at the camera and on a polar grid around it,
// smooths the camera state, and publishes what the curtain pass, particle box and audio need. Pure and GPU-free so it is testable.
import {WEATHER as W} from './weather-config.js';
import {WeatherState} from './weather-field.js';
import {climateOf} from './weather-climate.js';
import {density} from './cloud-march.js';
import {CLOUD_ALTITUDE} from './cloud-config.js';

export const POLAR_CELLS=W.polar.azimuth*W.polar.rings;
/** Distance (yd) of polar ring k, spaced logarithmically from near to far. */
export const ringDistance=k=>W.polar.near*Math.pow(W.polar.far/W.polar.near,k/(W.polar.rings-1));
const SLICE=4;

export class WeatherRuntime {
  constructor() {
    this.state=new WeatherState();this.polar=new Float32Array(POLAR_CELLS);this.cursor=0;
    this.local=0;this.climate={wet:1,snow:0,reason:'rain'};this.on=0;this.look={wet:0,on:0};this.nearest={distance:Infinity,bearing:0,intensity:0};this.sampleMs=0;
  }
  /** Precipitation intensity of the cloud column above (x, z), 0..1. */
  sample(x,z,ctx) {
    return density([x,CLOUD_ALTITUDE,z],ctx.time,false,ctx.centre,undefined,ctx.mask,{wet:this.climate.wet,on:this.on,flow:ctx.flow})[this.wantCover?5:4];
  }
  /**
   * One frame. ctx: {dt, eye:[x,y,z], time (cloud s), centre (storm [x,z]), mask, flow?:{cycles,scale}, enabled, regime, body, area:{name,cold}}.
   * Time-slices the polar grid (SLICE azimuths per frame) so the cost is flat; returns this.
   */
  step(ctx) {
    const t0=performance.now();
    this.climate=climateOf({area:ctx.area,body:ctx.body,regime:ctx.regime});
    this.on=ctx.enabled&&ctx.regime!=='orbit'&&ctx.body!=='elune'?1:0;
    // The cloud shader draws the same cells from altitude/orbit (no particles): the zone climate gates local rain only, so from orbit every wet cell shows.
    this.look=ctx.enabled&&ctx.body!=='elune'?{wet:this.on?this.climate.wet:1,on:1}:{wet:0,on:0};
    if(!this.on){this.local=0;this.polar.fill(0);this.nearest={distance:Infinity,bearing:0,intensity:0};this.state.step(ctx.dt,0,{wet:0,snow:0});this.sampleMs=0;return this;}
    this.wantCover=true;this.cover=this.sample(ctx.eye[0],ctx.eye[2],ctx);this.wantCover=false;
    this.local=this.sample(ctx.eye[0],ctx.eye[2],ctx);
    this.state.step(ctx.dt,this.local,{wet:1,snow:this.climate.snow});
    const A=W.polar.azimuth,R=W.polar.rings;
    for(let s=0;s<SLICE;s++) {
      const a=(this.cursor+s)%A,th=a/A*Math.PI*2,cx=Math.cos(th),cz=Math.sin(th);
      for(let k=0;k<R;k++){const d=ringDistance(k);this.polar[a*R+k]=this.sample(ctx.eye[0]+cx*d,ctx.eye[2]+cz*d,ctx);}
    }
    this.cursor=(this.cursor+SLICE)%A;
    this.findNearest();
    this.sampleMs+=(performance.now()-t0-this.sampleMs)*.1;
    return this;
  }
  /** Nearest wet cell on the grid (intensity at or above W.on): its distance and bearing (radians, atan2(z, x)). */
  findNearest() {
    const A=W.polar.azimuth,R=W.polar.rings;let best=Infinity,bearing=0,intensity=0;
    for(let a=0;a<A;a++)for(let k=0;k<R;k++){const p=this.polar[a*R+k];if(p>=W.on){const d=ringDistance(k);if(d<best){best=d;bearing=a/A*Math.PI*2;intensity=p;}break;}}
    this.nearest={distance:best,bearing,intensity};
  }
  /** Whether any wet cell is within the curtain's reach (lets the pass skip entirely). */
  get anyWet() {return this.on>0&&this.nearest.distance<Infinity;}
}
