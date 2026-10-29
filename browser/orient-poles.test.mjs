import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyOf,fromInertial,toInertial} from './bodies.js';
import {stepShared,inertialDir,transportAim,framedBody} from './shared-flight.js';

const t=1000,dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const ang=(a,b)=>Math.acos(Math.max(-1,Math.min(1,dot(a,b))));

// Fly straight over each pole of a body, looking along the surface normal and then along the path; the physical attitude must never jump.
for(const id of ['elune','azeroth']) test(`${id}: flight across the pole keeps a continuous roll-free attitude`, () => {
  const body=bodyOf(id),r=body.radius??5093;
  let pose=[body.centre[0],1500,-r*(Math.PI/2-.02)],aim={look:[0,0,-1],right:[1,0,0],up:[0,1,0]},space,frame='E';
  const angular=[];let prevLook,prevUp;
  for(let i=0;i<600;i++){
    const s=stepShared(space,pose,aim,{forward:1,fast:true},1/30,t,2,id,frame);
    if(s.parent!==id)break;
    space=s.space;pose=s.pose;aim=s.aim;frame=s.frame;
    const fb=framedBody(body,frame),look=inertialDir(fb,pose,aim.look,t),up=inertialDir(fb,pose,aim.up,t);
    if(prevLook){angular.push(Math.max(ang(look,prevLook),ang(up,prevUp)));}
    prevLook=look;prevUp=up;
  }
  assert.ok(angular.length>100);
  const worst=Math.max(...angular);
  // Sweeping a pole at this speed turns the attitude only by the path curvature, never by a gimbal flip.
  assert.ok(worst<.2,`largest per-frame attitude change ${worst} rad`);
});

test('transport on a sphere is roll free: a closed loop returns to the same up and a bounded look', () => {
  const body=bodyOf('elune');
  const poses=[[0,500,0],[200,500,300],[400,500,0],[200,500,-300],[0,500,0]];
  let aim={look:[1,0,0],right:[0,0,1],up:[0,1,0]};
  for(let i=1;i<poses.length;i++)aim=transportAim(body,poses[i-1],poses[i],aim,t);
  const up=inertialDir(body,poses[4],aim.up,t),surfaceUp=inertialDir(body,poses[4],[0,1,0],t);
  assert.ok(ang(up,surfaceUp)<2e-3,`up stays the local up (${ang(up,surfaceUp)})`);
  assert.ok(Math.abs(Math.hypot(...aim.look)-1)<1e-9,'look stays unit');
});
