import {bearing} from './race.js';
import {toInertial} from './bodies.js';
import {chartAxes} from './shared-flight.js';

export const CLIMB_YD=25;

export function formatRange(yd) {
  return yd<1000?`${Math.round(yd)} yd`:`${(yd/1000).toFixed(yd<10000?1:0)}k yd`;
}

/** Craft->gate vector in the craft's local frame (east, up, south) for a gate on another body: both points go through the shared inertial frame at sim time t. */
export function crossBodyDelta({pos,body,gate,gateBody,t}) {
  const a=toInertial(body,pos,t),b=toInertial(gateBody,gate.pos,t),d=[b[0]-a[0],b[1]-a[1],b[2]-a[2]];
  return chartAxes(body,pos,t).map(axis=>axis[0]*d[0]+axis[1]*d[1]+axis[2]*d[2]);
}

/**
 * Guide for the next gate. `pos`/`yaw` are the craft's in its current body frame; `body` and `gateBody` are body ids.
 * A gate on another body is only guided when `frame` {active, target, t} (body records and sim time) is supplied.
 */
export function gateGuide({pos,yaw,gate,body,gateBody,frame}) {
  const none={visible:false,label:'',range:'',rangeYd:0,delta:undefined,angle:0,climb:'',behind:false,cross:false};
  if(!gate)return none;
  const cross=!!(gateBody&&body&&gateBody!==body),label=cross?` (${gateBody})`:'';
  if(cross&&!frame)return {...none,label};
  const delta=cross?crossBodyDelta({pos,body:frame.active,gate,gateBody:frame.target,t:frame.t}):[gate.pos[0]-pos[0],gate.pos[1]-pos[1],gate.pos[2]-pos[2]];
  const rangeYd=Math.hypot(...delta);
  if(!Number.isFinite(rangeYd))return {...none,label};
  const angle=bearing([0,0,0],yaw,delta);
  return {visible:true,label,range:formatRange(rangeYd),rangeYd,delta,angle,climb:delta[1]>CLIMB_YD?'\u25B2':delta[1]<-CLIMB_YD?'\u25BC':'',behind:Math.abs(angle)>Math.PI*.6,cross};
}
