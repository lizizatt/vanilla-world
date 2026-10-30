// Zone climate (decisions 2, 3, 5 and orbit): wet scales rain/snow 0..1, snow says falling flakes. Resolved from the camera's AreaTable zone.
import {DRY_ZONES,SNOW_ZONES} from './weather-config.js';

const has=(list,name)=>!!name&&list.some(z=>name.toLowerCase().includes(z.toLowerCase()));
/** area: {name, cold} from the AreaTable catalogue (cold = ground-snow flag incl. one-hop parent inheritance); body 'azeroth'|'elune'; regime from regimeOf. */
export function climateOf({area=null,body='azeroth',regime='ground'}={}) {
  if(body==='elune'||regime==='orbit')return {wet:0,snow:0,reason:body==='elune'?'elune':'space'};
  if(has(SNOW_ZONES,area?.name)||area?.cold)return {wet:1,snow:1,reason:'snow'};
  if(has(DRY_ZONES,area?.name))return {wet:0,snow:0,reason:'dry'};
  return {wet:1,snow:0,reason:'rain'};
}

/** Resolves the camera's zone through the worker (AreaTable), re-asking only when the area id changes; keeps the last answer meanwhile. */
export class ClimateTracker {
  constructor(request,now=()=>performance.now()) {this.request=request;this.clock=now;this.area=undefined;this.info=null;this.askedAt=-1e9;this.token=0;}
  update(area) {
    if(area===this.area||this.clock()-this.askedAt<750)return;
    this.area=area;this.askedAt=this.clock();this.request({token:++this.token,area,climate:true});
  }
  event(data) {if(data.event==='climate'&&data.area===this.area)this.info={name:data.name,cold:data.cold};}
}
