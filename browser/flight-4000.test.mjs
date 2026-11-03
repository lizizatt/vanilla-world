// Edge cases of ~4000 yd/s flight: wrap/pole symmetry, hitches, wave streaming skip, creature sweeps. The world is small (circumference ~89,600 yd), so 4000 yd/s laps it in ~22 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import {moveFlight,flightBoost,FLIGHT} from './flight.js';
import {wrapFlat,PLANET_RADIUS,WORLD_CENTRE} from './space.js';
import {toPlanet} from './planet-frame.js';
import {fromEuler,basis,turnAround} from './orient.js';
import {WorldRenderer} from './world-renderer.js';
import {WAVE_STREAM_SPEED,waveItems} from './renderer-waves.js';
import {CreatureCollision,CREATURE_COLLISION,scaleTarget} from './creature-collision.js';

const TURN=2*Math.PI*PLANET_RADIUS;
let seed=12345;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);

test('wrapFlat is a symmetry of the globe for any overshoot, including multi-lap hitches and pole overflights',()=>{
  for(let n=0;n<2000;n++){
    const x=WORLD_CENTRE[0]+(rnd()-.5)*TURN*8,z=WORLD_CENTRE[1]+(rnd()-.5)*TURN*8,y=rnd()*50000;
    const [wx,wz,flipped]=wrapFlat(x,z);
    assert.ok(Number.isFinite(wx)&&Number.isFinite(wz));
    assert.ok(Math.abs(wx-WORLD_CENTRE[0])<=TURN/2+1e-6,`x ${wx}`);
    assert.ok(Math.abs(wz-WORLD_CENTRE[1])<=PLANET_RADIUS*Math.PI/2,`z ${wz}`);
    assert.equal(typeof flipped,'boolean');
    // The pole clamp (1e-4 rad = 1.4 yd) is the only allowed displacement
    assert.ok(dist(toPlanet([x,y,z]),toPlanet([wx,y,wz]))<3,`planet jump at ${x},${z}`);
  }
});

// Altitude at which walk speed (1200 yd/s) times sqrt(boost) equals `speed`.
const altitudeFor=speed=>{let lo=1000,hi=FLIGHT.ceiling;for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(FLIGHT.walkSpeed*Math.sqrt(flightBoost(mid))<speed)lo=mid;else hi=mid;}return lo;};
function lap(speed,dt,seconds,{yaw=0.7,pitch=0,hitch}={}){
  const keys=new Set(['KeyW']),y=altitudeFor(speed);
  let pose=[WORLD_CENTRE[0],y,WORLD_CENTRE[1]+PLANET_RADIUS*.3,0,0],q=fromEuler(yaw,pitch),prev=toPlanet(pose),worst=0,flips=0,frames=0;
  for(let t=0;t<seconds;t+=dt){
    const step=hitch?.(frames)??dt;frames++;
    pose=moveFlight(pose,keys,step,basis(q));
    if(pose.poleFlip){q=turnAround(q);flips++;}
    assert.ok(pose.every(Number.isFinite),'finite pose');
    const p=toPlanet(pose);worst=Math.max(worst,dist(p,prev));prev=p;
  }
  return {pose,worst,flips,y};
}

test('a 4000 yd/s lap stays continuous in 3D across the longitude seam and both poles at 30/60/144 fps',()=>{
  for(const dt of [1/30,1/60,1/144]){
    const {worst,flips,y}=lap(4000,dt,90,{yaw:.3});
    const bound=4000*dt*(PLANET_RADIUS+y)/PLANET_RADIUS*1.05;// flat travel is scaled up by the altitude
    assert.ok(worst<=bound,`dt ${dt}: step ${worst} > ${bound}`);
    assert.ok(flips>=2,`dt ${dt}: expected pole crossings, got ${flips}`);
  }
});

test('frame hitches (up to 3 s, more than a full lap of the globe) never produce NaN, out-of-range lat or lost altitude',()=>{
  const spikes=[0.25,1,3,30];
  const {pose}=lap(4000,1/60,60,{hitch:f=>f%97===0?spikes[(f/97)%spikes.length]:1/60});
  assert.ok(pose.every(Number.isFinite));
  assert.ok(pose[1]>=FLIGHT.floor&&pose[1]<=FLIGHT.ceiling);
});

test('sudden stop and 180° turn at speed advance no further than one frame of motion',()=>{
  const keys=new Set(['KeyW','ShiftLeft']);
  let pose=[WORLD_CENTRE[0],60000,WORLD_CENTRE[1],0,0];const q=fromEuler(1,0);
  for(let i=0;i<30;i++)pose=moveFlight(pose,keys,1/60,basis(q));
  const stopped=moveFlight(pose,new Set(),1/60,basis(q));
  assert.deepEqual(stopped.slice(0,3),pose.slice(0,3));
  const back=moveFlight(pose,keys,1/60,basis(turnAround(q)));
  const out=moveFlight(pose,keys,1/60,basis(q));
  assert.ok(Math.abs((back[0]-pose[0])+(out[0]-pose[0]))<1e-6&&Math.abs((back[2]-pose[2])+(out[2]-pose[2]))<1e-6,'reverse is symmetric');
});

// waveItems up to the early return: no mask, so only the speed estimator and the request flags run
const waveRig=()=>{
  const r=Object.create(WorldRenderer.prototype),writes=[];
  Object.assign(r,{waveSim:{on:true,rev:1,ticks:0},waveUniformData:new Float32Array(4),beachUniformData:new Float32Array(4),
    waveUniforms:{},beachUniforms:{},device:{queue:{writeBuffer:(...a)=>writes.push(a)}}});
  return r;
};
const stepWave=(r,now,x)=>{
  const real=performance.now;performance.now=()=>now;
  try{return waveItems(r,[x,50,0],[0,0],false);}finally{performance.now=real;}
};

test('WAVE_STREAM_SPEED: 4000 yd/s abandons mask/shore requests within a few frames and a stop resumes them within ~0.25 s',()=>{
  const r=waveRig();let t=1000,x=0;
  stepWave(r,t,x);
  assert.ok(r.waveRequest,'a stationary eye asks for a mask');
  const dt=1000/60;
  let fastAt=-1;
  for(let i=0;i<60;i++){t+=dt;x+=4000/60;stepWave(r,t,x);if(fastAt<0&&r.waveFast)fastAt=i;}
  assert.ok(fastAt>=0&&fastAt<=12,`fast after ${fastAt} frames`);
  assert.equal(r.waveRequest,undefined);assert.equal(r.shoreRequest,undefined);
  let resumed=-1;
  for(let i=0;i<60;i++){t+=dt;stepWave(r,t,x);if(resumed<0&&r.waveRequest)resumed=i;}
  assert.ok(resumed>=0&&resumed<=15,`requests resumed after ${resumed} frames (${(resumed*dt/1000).toFixed(2)} s)`);
  assert.ok(WAVE_STREAM_SPEED<4000);
});

test('a single teleport frame or longitude-seam jump is not read as sustained speed',()=>{
  const r=waveRig();let t=1000;
  stepWave(r,t,0);
  for(let i=0;i<10;i++){t+=1000/60;stepWave(r,t,i);}
  t+=1000/60;stepWave(r,t,TURN*.4);
  assert.equal(r.waveFast,false);
  t+=1000/60;stepWave(r,t,TURN*.4+1);
  assert.equal(r.waveFast,false);
});

test('creature hit volume is bounded and swept hits do not tunnel at 4000 yd/s, even with a 0.99 s tick',()=>{
  assert.equal(scaleTarget(4000,false),CREATURE_COLLISION.speedScale);
  assert.equal(scaleTarget(4000,true),CREATURE_COLLISION.boostScale);
  for(const tick of [1/25,1/10,.5,.99]){
    const cc=new CreatureCollision(),npc={id:'n1',key:'k',matrix:Object.assign(new Array(16).fill(0),{0:1,5:1,10:1,15:1,12:2000,13:0,14:0})};
    const run=()=>cc.update([npc],()=>true,0,0,0,0,()=>undefined,()=>[1,1,-1,2,0,0],()=>'critter',()=>1.5,false);
    run();
    const x=4000*tick;
    // second sample moves 4000*tick yd east: the creature at x=2000 is hit when inside the swept segment and missed otherwise
    const hit=cc.update([npc],()=>true,x,0,0,tick,()=>undefined,()=>[1,1,-1,2,0,0],()=>'critter',()=>1.5,false);
    assert.equal(hit.length,x>=2000?1:0,`tick ${tick}`);
  }
});

test('a hitch longer than one second resets the sweep instead of killing along a teleport segment',()=>{
  const cc=new CreatureCollision(),npc={id:'n1',key:'k',matrix:Object.assign(new Array(16).fill(0),{0:1,5:1,10:1,15:1,12:2000})};
  const call=(x,now)=>cc.update([npc],()=>true,x,0,0,now,()=>undefined,()=>[1,1,-1,2,0,0],()=>'critter',()=>1.5,true);
  call(0,0);
  assert.equal(call(4000,1.5).length,0);
  assert.equal(cc.scale,1);
});
