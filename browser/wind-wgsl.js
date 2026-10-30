// WGSL twin of wind.js windAt(), built from the same WIND constants. a0..a2 are the packed block (wind.js packWind) as three vec4f.
// Returns (dirX, dirZ, speed, strength). t is the wind clock from windTime(); xz is chart position.
import {WIND as W} from './wind-config.js';
import {gustOmega} from './wind.js';

const f=x=>{const s=String(+x.toPrecision(9));return /[.e]/.test(s)?s:s+'.0';};
export function windWGSL() {
  const M=W.mael;
  const gust=W.gust.map((c,i)=>`let s${i}=sin(${f(c.k[0])}*xz.x+${f(c.k[1])}*xz.y-${f(gustOmega(c))}*t+${f(c.p)});g+=${f(c.w)}*s${i};`).join('');
  return `
fn windAt(a0:vec4f,a1:vec4f,a2:vec4f,xz:vec2f,t:f32)->vec4f {
  var g=0.0;${gust}
  var storm=a1.z;var m=vec2f(0.0);
  if(a1.w>.5){
    let rv=xz-a2.xy;let r=length(rv);
    var vt=exp(-(r-${f(M.core)})/${f(M.decay)});if(r<${f(M.core)}){vt=r/${f(M.core)};}
    let mk=1.0-smoothstep(${f(M.core)},${f(M.core+M.halo*M.decay)},r);
    let inv=1.0/max(r,1.0);let tg=vec2f(-rv.y,rv.x)*inv;let ib=-rv*inv;
    m=${f(M.speed)}*vt*(cos(${f(M.inflow)})*tg+sin(${f(M.inflow)})*ib);
    storm=max(storm,mk);
  }
  let sk=smoothstep(${f(W.storm.ramp[0])},${f(W.storm.ramp[1])},storm);
  let speed0=max(0.0,a0.z*a0.w+a1.x)*(1.0+a1.y*g)+sk*${f(W.storm.add)}*(.75+.25*g);
  let veer=${f(W.veer)}*s1*(1.0-sk*.6);let cv=cos(veer);let sv=sin(veer);
  let v=vec2f(a0.x*cv-a0.y*sv,a0.x*sv+a0.y*cv)*speed0+m;
  let sp=length(v);
  return vec4f(v/max(sp,.0001),sp,clamp(sp/${f(W.maxSpeed)},0.0,1.0));
}`;
}
