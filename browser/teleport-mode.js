// Vehicle-mode-preserving teleports: a podracer stays a podracer and the fly camera stays the fly camera, on any body.
import {teleportPlan,siteChartPose} from './elune-pose.js';
import {BODIES} from './bodies.js';

/** Yards above the site's procedural ground the pod is first offered to the physics (it drops onto the real surface; the graft may sit higher). */
export const SEAT_LADDER=Object.freeze([12,40,120,400]);
export const FLY_LIFT=30;

/**
 * Plan for a map teleport.
 * mode 'fly': {flight} is the fly pose to take (after any swap).
 * mode 'drive' with a destination on another body: {seat} is the site pose the pod is seated at once that body's ground has streamed.
 * mode 'drive' on the same body (Azeroth map icons): the existing restore/reset path, no seat.
 */
export function teleportModePlan(icon,activeId,driving,altitude=250) {
  const base=teleportPlan(icon,activeId,altitude);
  if(!icon.body||icon.body==='azeroth') {
    // Azeroth icons carry a drive pose (or ask for the spawn reset); flying lifts it clear of the ground.
    return {...base,mode:driving?'drive':'fly',lift:driving?0:FLY_LIFT};
  }
  const site=siteChartPose(BODIES[icon.body],altitude);
  if(!driving)return {...base,mode:'fly',flight:site};
  return {...base,mode:'drive',flight:site,seat:[site[0],site[1]-altitude,site[2],0]};
}

/** Drive pose (restore request) for the n-th attempt at seating on a ground of unknown height. */
export const seatPose=(seat,attempt)=>[seat[0],seat[1]+SEAT_LADDER[Math.min(attempt,SEAT_LADDER.length-1)],seat[2],seat[3]];

/** Fly pose over a drive pose [x,y,z,yaw]. */
export const flyFromDrive=(pose,lift=FLY_LIFT)=>[pose[0],pose[1]+lift,pose[2],pose[3],0];
