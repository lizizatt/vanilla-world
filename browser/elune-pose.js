// Poses that look at Elune from Azeroth, solved through the real chart<->inertial map (no calibration constants).
// node elune-pose.js [altitude=30000] [time=720]  -> prints a ?pose= link query that spawns that far from Elune, looking at it.
import {AZEROTH,ELUNE,centreAt,toInertial,fromInertial} from './bodies.js';
import {inertialDir} from './shared-flight.js';
import {sitesOf,siteCentre} from './elune-sites.js';
import {moonHeightChart} from './moon-terrain.js';
import {MOON_SEED} from './moon-source.js';

const unit=a=>{const n=Math.hypot(...a)||1;return a.map(v=>v/n);};
/** Chart pose [x,y,z,yaw,pitch] whose camera looks along an inertial direction (look=[-sin yaw cos p, sin p, -cos yaw cos p]). */
export function poseLooking(body,chart,dir,t) {
  const axes=[[1,0,0],[0,1,0],[0,0,1]].map(a=>inertialDir(body,chart,a,t)),c=axes.map(a=>a.reduce((s,v,i)=>s+v*dir[i],0)),l=unit(c);
  return [chart[0],chart[1],chart[2],Math.atan2(-l[0],-l[2]),Math.asin(Math.max(-1,Math.min(1,l[1])))];
}
/** A pose `standoff` yd short of Elune's surface on the line to Azeroth's side, looking at Elune's centre (inertial placement, parent-frame chart). */
export function nearBody(body,standoff=30000,t=720) {
  const c=centreAt(body,t),a=centreAt(AZEROTH,t),d=unit(a.map((v,i)=>v-c[i])),at=c.map((v,i)=>v+d[i]*(body.radius+standoff));
  const chart=fromInertial(AZEROTH,at,t,0),look=unit(c.map((v,i)=>v-at[i]));
  return poseLooking(AZEROTH,chart,look,t);
}
export const nearElune=(standoff=30000,t=720)=>nearBody(ELUNE,standoff,t);
/** A pose `alt` yd over a body's grafted site (first site in the config), looking along the surface toward the town, expressed in Azeroth's chart so the SOI swap takes over. */
export function overSite(body,alt=250,t=720,pitch=-.35) {
  const site=sitesOf(body.id)[0];if(!site)return nearBody(body,30000,t);
  const [x,z]=siteCentre(site,30,15),chart=[x,moonHeightChart(MOON_SEED,x,z)+alt,z];
  const at=toInertial(body,chart,t),azChart=fromInertial(AZEROTH,at,t,0);
  const fwd=[0,0,-1].map((v,i)=>v*Math.cos(pitch)+(i===1?Math.sin(pitch):0));
  const axes=[[1,0,0],[0,1,0],[0,0,1]].map(a=>inertialDir(body,chart,a,t)),look=unit([0,1,2].map(i=>axes[0][i]*fwd[0]+axes[1][i]*fwd[1]+axes[2][i]*fwd[2]));
  return poseLooking(AZEROTH,azChart,look,t);
}
/** A pose `alt` over the chart origin looking at Elune. */
export function overheadLooking(alt=120000,t=720) {
  const chart=[0,alt,0],from=toInertial(AZEROTH,chart,t),c=centreAt(ELUNE,t);
  return poseLooking(AZEROTH,chart,unit(c.map((v,i)=>v-from[i])),t);
}
export const poseLink=(flight,time,settings={planet:true,globeMesh:true})=>'?pose='+encodeURIComponent(JSON.stringify({v:1,flight,time,settings}));
if(typeof process!=='undefined'&&process.argv[1]?.endsWith('elune-pose.js')){
  const standoff=+process.argv[2]||30000,t=+process.argv[3]||720;
  console.log(JSON.stringify(nearElune(standoff,t)));console.log(poseLink(nearElune(standoff,t),t));
}
