import {bearing} from './race.js';

export const CLIMB_YD=25;

export function formatRange(yd) {
  return yd<1000?`${Math.round(yd)} yd`:`${(yd/1000).toFixed(yd<10000?1:0)}k yd`;
}

/** Guide for the next gate. `pos`/`yaw` are the craft's in its current body frame; `body` and `gateBody` are body ids. */
export function gateGuide({pos,yaw,gate,body,gateBody}) {
  if(!gate)return {visible:false,label:'',range:'',angle:0,climb:'',behind:false};
  if(gateBody&&body&&gateBody!==body)return {visible:false,label:` (${gateBody})`,range:'',angle:0,climb:'',behind:false};
  const dx=gate.pos[0]-pos[0],dy=gate.pos[1]-pos[1],dz=gate.pos[2]-pos[2],angle=bearing(pos,yaw,gate.pos);
  const range=Math.hypot(dx,dy,dz);
  return {visible:true,label:'',range:formatRange(range),angle,climb:dy>CLIMB_YD?'\u25B2':dy<-CLIMB_YD?'\u25BC':'',behind:Math.abs(angle)>Math.PI*.6};
}
