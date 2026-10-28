import test from 'node:test';
import assert from 'node:assert/strict';
import {bendRel,bendShader,PLANET_RADIUS as R} from './space.js';

const eye=[0,20,0];

test('partial bend leaves no flat plane floating past the horizon',()=>{
  const rel=[0,-20,-45000],b=bendRel(rel,eye,.7),full=bendRel(rel,eye,1);
  assert.ok(b[1]<-5000,`far vertex must drop with the curvature, got y=${b[1]}`);
  assert.ok(Math.abs(b[1]-full[1])<1,'fully curved like k=1');
});

test('within 1.5 R of the eye, and at low bend, partial bend is the plain linear blend',()=>{
  for(const [rel,k] of [[[0,-20,-300],.7],[[200,0,300],.3],[[0,0,-300],.6],[[0,0,-30000],.05]]) {
    const a=bendRel(rel,eye,k),f=bendRel(rel,eye,1);
    for(let i=0;i<3;i++)assert.ok(Math.abs(a[i]-(rel[i]+(f[i]-rel[i])*k))<1e-6,`axis ${i} of ${rel}`);
  }
  assert.deepEqual(bendRel([100,0,100],eye,0),[100,0,100]);
});

test('the WGSL bend carries the same far rule',()=>{
  assert.ok(bendShader.includes('let kk=k+(1.0-k)*smoothstep(.1,.3,k)*max(smoothstep(1.5*R,2.5*R,length(rel.xz)),smoothstep(.5,1.2,length(rel.xz)/sqrt(2.0*R*max(eye.y,1.0))));'));
});
