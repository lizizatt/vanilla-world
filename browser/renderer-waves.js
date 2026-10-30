import {paramsFromArray} from './wave-math.js';
import {WAVE_TICKS_PER_SECOND} from './wave-config.js';
import {CLIP_LEVELS,MASK_N,MASK_REFRESH,clipLevelMesh,clipLevels,packWaveUniform} from './wave-render.js';
import {SHORE_N,SHORE_REFRESH,shoreTexture} from './shore-field.js';
import {packBeachUniform} from './beach-waves.js';

// Beach waves read a coarser, camera-centred shore window; it is only built when the eye is low enough to see them.
const SHORE_CEILING=700,SHORE_SLICE_ROWS=6;

/** Fetches the shore class grid in row slices (like the mask) and stitches them. */
export async function fetchShoreField(client,center) {
  let out;
  for(let row=0;row<SHORE_N;row+=SHORE_SLICE_ROWS){
    const part=await client.request('shore-rows',{center,rowStart:row,rowCount:Math.min(SHORE_SLICE_ROWS,SHORE_N-row)});
    out??={...part,data:new Uint8Array(SHORE_N*SHORE_N)};
    out.data.set(part.data,row*SHORE_N);
  }
  return out;
}

/** Solves the shore field (signed distance + averaged normal) from the class grid and uploads it. */
export function setShoreField(r,{origin,cell,n,data}) {
  r.shoreRequest=undefined;
  if(n!==SHORE_N||data.length!==n*n)return;
  const tex=shoreTexture(data,n,cell);
  r.device.queue.writeTexture({texture:r.shoreTexture},tex,{bytesPerRow:n*4},[n,n]);
  r.shoreField={origin,cell,n,tex,classes:data};
}

// Above this the sea reads as flat from the eye and the clipmap (and its fill discard) switches off.
export const WAVE_CEILING=2500;
const MASK_SLICE_ROWS=6;

/** Fetches the mask in row slices (one worker message each, ~10 ms of sampling) and stitches them; the last slice carries the params and rev. */
export async function fetchWaveMask(client,center) {
  const rows=MASK_SLICE_ROWS;let out;
  for(let row=0;row<MASK_N;row+=rows){
    const part=await client.request('wave-mask',{center,rowStart:row,rowCount:Math.min(rows,MASK_N-row)});
    out??={...part,data:new Uint8Array(MASK_N*MASK_N)};
    out.data.set(part.data,row*MASK_N);out.params=part.params;out.rev=part.rev;
  }
  return out;
}

/** Uploads a mask built by the world worker (see buildWaveMask) together with the parameter block it was built for. */
export function setWaveMask(r,{origin,cell,n,data,params,rev}) {
  if(n!==MASK_N||data.length!==n*n||!params?.length){r.waveRequest=undefined;return;}
  r.device.queue.writeTexture({texture:r.waveMaskTexture},data,{bytesPerRow:n},[n,n]);
  r.waveMask={origin,cell,n,data,rev};r.waveParams=paramsFromArray(params);r.waveRequest=undefined;
}

/** The physics tick clock, free-running on wall time while the sim is not stepping (flight mode, pause) so the sea still moves; while it steps the surface is exactly the physics one. */
function simTicks(r,ticks) {
  const now=performance.now(),c=r.waveClock;
  if(!c||c.ticks!==ticks){r.waveClock={ticks,wall:now};return ticks;}
  return ticks+Math.max(0,(now-c.wall)/1000-.5)*WAVE_TICKS_PER_SECOND;
}

/** Per frame: asks for a fresh mask when needed, writes the wave uniform and returns the clipmap items to draw (none when waves are off). */
export function waveItems(r,eye,origin,bent) {
  const sim=r.waveSim,mask=r.waveMask,active=!!(sim?.on&&mask&&r.waveParams&&eye[1]<WAVE_CEILING);
  const centre=mask&&[mask.origin[0]+mask.n*mask.cell/2,mask.origin[1]+mask.n*mask.cell/2];
  r.waveRequest=sim?.on&&(!mask||mask.rev!==sim.rev||Math.max(Math.abs(eye[0]-centre[0]),Math.abs(eye[2]-centre[1]))>MASK_REFRESH)?[eye[0],eye[2]]:undefined;
  const flat=[eye[0],eye[2]];
  r.waveActive=active;
  const shore=r.shoreField,shoreCentre=shore&&[shore.origin[0]+shore.n*shore.cell/2,shore.origin[1]+shore.n*shore.cell/2];
  r.shoreRequest=active&&eye[1]<SHORE_CEILING&&(!shore||Math.max(Math.abs(eye[0]-shoreCentre[0]),Math.abs(eye[2]-shoreCentre[1]))>SHORE_REFRESH)?[eye[0],eye[2]]:undefined;
  if(!active){r.waveUniformData.fill(0);r.device.queue.writeBuffer(r.waveUniforms,0,r.waveUniformData);r.beachUniformData.fill(0);r.device.queue.writeBuffer(r.beachUniforms,0,r.beachUniformData);return [];}
  packWaveUniform(r.waveUniformData,{params:r.waveParams,ticks:simTicks(r,sim.ticks),origin,eye:flat,mask});
  r.device.queue.writeBuffer(r.waveUniforms,0,r.waveUniformData);
  packBeachUniform(r.beachUniformData,{field:shore,origin,ticks:simTicks(r,sim.ticks),params:r.waveParams});
  r.device.queue.writeBuffer(r.beachUniforms,0,r.beachUniformData);
  r.clipItems??=Array.from({length:CLIP_LEVELS},(_,level)=>r.drawable(clipLevelMesh(level),[0,0]));
  clipLevels(flat).forEach((l,i)=>{
    const item=r.clipItems[i],h=l.half;
    item.placement[0]=l.centre[0];item.placement[1]=l.centre[1];
    item.bounds=[[l.centre[0]-h,-12,l.centre[1]-h],[l.centre[0]+h,12,l.centre[1]+h]];
    item.clipInner=l.inner&&[l.inner.centre[0]-origin[0],l.inner.centre[1]-origin[1],l.inner.half];
    item.waveLevel=i;
  });
  return r.clipItems;
}
