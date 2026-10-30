// Lightning and thunder: deterministic strike scheduling from heavy cells, bolt flash envelope, thunder delay and level.
// Pure and GPU-free so it is unit-testable; the renderer draws what `active()` returns. See design/weather.md.
import {WEATHER as W} from './weather-config.js';
import {ringDistance} from './weather.js';

const SLOT=.5;
/** Small integer hash -> [0,1). */
export function hash01(n,salt=0) {
  let x=(Math.imul(n|0,747796405)+Math.imul(salt|0,2891336453)+2891336453)>>>0;
  x=Math.imul(((x>>>((x>>>28)+4))^x)>>>0,277803737)>>>0;x=((x>>>22)^x)>>>0;
  return x/4294967296;
}
/** Flash brightness 0-1 at `age` seconds after a strike: sharp return stroke, a flicker, then a decay. */
export function flashEnvelope(age,length=W.lightning.flash) {
  if(age<0||age>=length)return 0;
  const a=age/length,flicker=.65+.35*Math.sin(age*70)**2;
  return Math.exp(-a*5)*flicker;
}
export const thunderDelay=(distance,speed=W.lightning.soundSpeed)=>Math.max(0,distance)/speed;
/** Thunder loudness falls with distance and is inaudible past the strike range. */
export const thunderGain=(distance,range=W.lightning.range)=>{const d=Math.min(1,Math.max(0,distance/range));return (1-d)**1.5;};

export class LightningScheduler {
  // rozen (lab only): hold the flash at this cloud time so a screenshot can catch it.
  constructor() {this.frozen=null;this.slot=null;this.bolts=[];this.pending=[];this.serial=0;}
  /** Force a strike (tests and the lab): world position x,z, camera distance, cloud time. */
  strike(time,x,z,distance,seed=this.serial) {
    this.serial++;
    this.bolts.push({at:time,x,z,seed,distance});
    this.pending.push({at:time+thunderDelay(distance),distance});
  }
  /**
   * Advance to cloud `time`. `polar` is the runtime grid (azimuth-major); strikes land only in cells at or above minIntensity.
   * Returns thunder events that came due: [{distance,gain}].
   */
  step(time,{eye,polar,enabled=true,drop=0}) {
    const slot=Math.floor(time/SLOT),due=[];
    if(!enabled||!polar){this.slot=slot;this.bolts.length=0;this.pending.length=0;return due;}
    if(this.slot===null||slot<this.slot||slot-this.slot>8)this.slot=slot-1;
    const A=W.polar.azimuth,R=W.polar.rings,L=W.lightning;
    for(let s=this.slot+1;s<=slot;s++) {
      if(hash01(s,1)>=SLOT/L.meanGap)continue;
      for(let tries=0;tries<4;tries++) {
        const a=Math.floor(hash01(s,10+tries)*A),k=Math.floor(hash01(s,20+tries)*R);
        if(polar[a*R+k]<L.minIntensity)continue;
        const ang=(a+hash01(s,30+tries))/A*Math.PI*2,d=ringDistance(k)*(.8+.4*hash01(s,40+tries));
        if(d>L.range)continue;
        const x=eye[0]+Math.cos(ang)*d,z=eye[2]+Math.sin(ang)*d,at=s*SLOT+hash01(s,2)*SLOT;
        this.strike(at,x,z,Math.hypot(d,drop),s);
        break;
      }
    }
    this.slot=slot;
    if(this.frozen==null)this.bolts=this.bolts.filter(b=>time-b.at<L.flash);
    const keep=[];
    for(const p of this.pending){if(p.at<=time)due.push({distance:p.distance,gain:thunderGain(p.distance)});else keep.push(p);}
    this.pending=keep;
    return due;
  }
  /** Bolts still visible at `time`, each with its flash brightness. */
  active(time) {if(this.frozen!=null)time=this.frozen;return this.bolts.map(b=>({...b,flash:flashEnvelope(time-b.at)})).filter(b=>b.flash>0);}
  /** Strongest current flash 0-1 for ambient/sun lift, attenuated by distance. */
  flash(time) {if(this.frozen!=null)time=this.frozen;let f=0;for(const b of this.active(time))f=Math.max(f,b.flash*Math.max(.15,1-b.distance/W.lightning.range));return f;}
}
