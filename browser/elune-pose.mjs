// Poses that look at Elune from Azeroth, solved through the real chart<->inertial map (no calibration constants).
// node elune-pose.mjs [altitude=30000] [time=720]  -> prints a ?pose= link query that spawns that far from Elune, looking at it.
import {AZEROTH,ELUNE,centreAt,toInertial,fromInertial} from './bodies.js';
import {inertialDir} from './shared-flight.js';

const unit=a=>{const n=Math.hypot(...a)||1;return a.map(v=>v/n);};
/** Chart pose [x,y,z,yaw,pitch] whose camera looks along an inertial direction (look=[-sin yaw cos p, sin p, -cos yaw cos p]). */
export function poseLooking(body,chart,dir,t) {
  const axes=[[1,0,0],[0,1,0],[0,0,1]].map(a=>inertialDir(body,chart,a,t)),c=axes.map(a=>a.reduce((s,v,i)=>s+v*dir[i],0)),l=unit(c);
  return [chart[0],chart[1],chart[2],Math.atan2(-l[0],-l[2]),Math.asin(Math.max(-1,Math.min(1,l[1])))];
}
/** A pose `standoff` yd short of Elune's surface on the line to Azeroth's side, looking at Elune's centre (inertial placement, parent-frame chart). */
export function nearElune(standoff=30000,t=720) {
  const c=centreAt(ELUNE,t),a=centreAt(AZEROTH,t),d=unit(a.map((v,i)=>v-c[i])),at=c.map((v,i)=>v+d[i]*(ELUNE.radius+standoff));
  const chart=fromInertial(AZEROTH,at,t,0),look=unit(c.map((v,i)=>v-at[i]));
  return poseLooking(AZEROTH,chart,look,t);
}
/** A pose `alt` over the chart origin looking at Elune. */
export function overheadLooking(alt=120000,t=720) {
  const chart=[0,alt,0],from=toInertial(AZEROTH,chart,t),c=centreAt(ELUNE,t);
  return poseLooking(AZEROTH,chart,unit(c.map((v,i)=>v-from[i])),t);
}
export const poseLink=(flight,time,settings={planet:true,globeMesh:true})=>'?bodies&moonEngine&pose='+encodeURIComponent(JSON.stringify({v:1,flight,time,settings}));
if(process.argv[1]?.endsWith('elune-pose.mjs')){
  const standoff=+process.argv[2]||30000,t=+process.argv[3]||720;
  console.log(JSON.stringify(nearElune(standoff,t)));console.log(poseLink(nearElune(standoff,t),t));
}
