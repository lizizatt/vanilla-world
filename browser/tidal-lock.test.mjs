import test from 'node:test';
import assert from 'node:assert/strict';
import {BODIES,centreAt,axesAt,fromInertial,toInertial,PARENT_DIRECTION} from './bodies.js';
import {spaceShaderFor,patchShaderFor} from './space.js';

const moons=Object.values(BODIES).filter(b=>b.rail);
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

test('every moon is tidally locked: parent stays at body-frame +X at any time', () => {
  assert.ok(moons.length>0);
  for(const m of moons)for(const t of [0,1,1547.58,1e4,123456.789,1e7,5e8]){
    const ax=axesAt(m,t),c=centreAt(m,t),r=Math.hypot(...c);
    const toParent=c.map(v=>-v/r),local=[dot(ax[0],toParent),dot(ax[1],toParent),dot(ax[2],toParent)];
    for(let i=0;i<3;i++)assert.ok(Math.abs(local[i]-PARENT_DIRECTION[i])<1e-9,`${m.id} t=${t} axis ${i}: ${local}`);
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)assert.ok(Math.abs(dot(ax[i],ax[j])-(i===j?1:0))<1e-12);
  }
});

test('spin period equals orbital period: one orbit returns the same frame', () => {
  for(const m of moons){
    const period=m.orbitDays*2880,a=axesAt(m,100),b=axesAt(m,100+period),c=axesAt(m,100+1000*period);
    for(let i=0;i<3;i++)for(let k=0;k<3;k++){assert.ok(Math.abs(a[i][k]-b[i][k])<1e-9);assert.ok(Math.abs(a[i][k]-c[i][k])<1e-7);}
  }
});

test('no jitter at 1000x: a chart point round-trips and moves smoothly frame to frame', () => {
  for(const m of moons){
    const pose=[900,40,-300];let prev;
    for(let f=0;f<600;f++){
      const t=5e6+f*(1/60)*2*1000,p=toInertial(m,pose,t),back=fromInertial(m,p,t,pose[0]);
      for(let i=0;i<3;i++)assert.ok(Math.abs(back[i]-pose[i])<1e-3,`${m.id} f=${f}`);
      if(prev){
        const step=Math.hypot(p[0]-prev[0],p[1]-prev[1],p[2]-prev[2]);
        const expected=2*Math.PI*(m.rail.orbit+m.radius)/(m.orbitDays*2880)*(2*1000/60);
        assert.ok(step<expected*1.01+1e-6,`${m.id} step ${step} > ${expected}`);
      }
      prev=p;
    }
  }
});

test('airless shader drops sea/glow while Azeroth stays the stylised planet', () => {
  const azeroth=spaceShaderFor(5092.958),moon=spaceShaderFor(5092.958,{airless:true});
  assert.ok(!azeroth.includes('surfaceSea'));
  assert.ok(moon.includes('surfaceSea')&&moon.includes('return c;')&&!moon.includes('return mix(c,s.rect[3].xyz,k);'));
  assert.equal(patchShaderFor(5092.958),patchShaderFor(5092.958,{}));
  assert.ok(patchShaderFor(5092.958,{airless:true}).includes('surfaceSea'));
});
