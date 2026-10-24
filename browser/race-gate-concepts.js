// CONCEPT MOCK-UPS ONLY (not used by gameplay): procedural, own-art gate silhouettes for the race-gate concept sheet.
// Same vertex layout and materials as race-flags.js (5 pole, 6 red, 7 white, 8 beacon). Local frame: +x across the road, y up.
import {box} from './race-flags.js';

// Open bottom: everything below FADE yd is a thin ghost post, so nothing solid sits at craft height.
const FADE=3.5;

const A=(v,w,y,m)=>{ // A: start/finish lights gantry
  const h=w/2;
  for(const s of[-1,1]){box(v,[s*h-.4,y,-.4],[.8,FADE,.8],5);box(v,[s*h-1.5,y+FADE,-1.5],[3,12,3],5);}
  box(v,[-h,y+14,-1],[w,2,2],5);
  const n=Math.round(w/3);
  for(let i=0;i<n;i++)box(v,[-h+(i+.15)*w/n,y+12.2,-.4],[w/n*.7,1.6,.8],m);
  for(let r=0;r<2;r++)for(let i=0;i<n*2;i++)box(v,[-h+i*w/(n*2),y+16+r*1.2,-.5],[w/(n*2),1.2,1],(i+r)%2?7:6);
  box(v,[-h-1,y+15,-1],[2,200,2],m);box(v,[h-1,y+15,-1],[2,200,2],m);
};
const B=(v,w,y,m)=>{ // B: arch with hanging banners
  const h=w/2;
  for(const s of[-1,1]){box(v,[s*h-.5,y,-.5],[1,FADE,1],5);box(v,[s*h-1.5,y+FADE,-1.5],[3,10,3],5);}
  for(let i=0;i<8;i++){const t=i/7,x=-h+t*w,up=14+Math.sin(t*Math.PI)*5;box(v,[x-1.2,y+up-1,-1],[2.4,2.5,2],5);}
  const n=Math.round(w/6);
  for(let i=0;i<n;i++)box(v,[-h+(i+.2)*w/n,y+8,-.2],[w/n*.6,9,.3],i%2?7:6);
  box(v,[-2,y+22,-1],[4,4,2],m);box(v,[-.6,y+26,-.6],[1.2,240,1.2],m);
};
const C=(v,w,y,m)=>{ // C: paired pylons plus beam column, no crossbar
  for(const s of[-1,1]){const h=s*w/2;
    box(v,[h-.3,y,-.3],[.6,FADE,.6],5);box(v,[h-1,y+FADE,-1],[2,10,2],5);
    box(v,[h-1.5,y+13.5,-1.5],[3,3,3],m);box(v,[h-.8,y+16.5,-.8],[1.6,380,1.6],m);}
};
const D=(v,w,y,m)=>{ // D: masts with a pennant line
  const h=w/2;
  for(const s of[-1,1]){box(v,[s*h-.3,y,-.3],[.6,24,.6],5);box(v,[s*h-.8,y+24,-.8],[1.6,150,1.6],m);}
  const n=Math.round(w/2.2);
  for(let i=0;i<n;i++){const t=(i+.5)/n,x=-h+t*w,sag=Math.sin(t*Math.PI)*2.5;box(v,[x-.9,y+22-sag-3,-.1],[1.8,3,.2],i%2?7:6);}
  box(v,[-h,y+22.6,-.1],[w,.3,.2],5);
};

const CONCEPTS={A,B,C,D};

export function conceptMesh(id,{width=34,yaw=0,y=0,hot=true}={}) {
  const v=[];CONCEPTS[id](v,width,y,hot?8:6);
  const c=Math.cos(yaw),s=Math.sin(yaw);
  for(let i=0;i<v.length;i+=7){
    const x=v[i],z=v[i+2],nx=v[i+3],nz=v[i+5];
    v[i]=x*c+z*s;v[i+2]=-x*s+z*c;v[i+3]=nx*c+nz*s;v[i+5]=-nx*s+nz*c;
  }
  return new Float32Array(v);
}
