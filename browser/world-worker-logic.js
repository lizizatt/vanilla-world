import {boundsWithin,boundsDistance} from './scene-stream.js';

export const TILE=1600/3;

export const assetPathOf=(manifest,t)=>`World\\Maps\\${manifest.regions[t.region].map}\\${t.file}`;
export function tileKeyOf(manifest,index) {
  const t=manifest.tiles[index];
  return `${t.region===0?1:0}:${t.x}:${t.y}`;
}
export function terrainDistance(placements,index,p) {
  const a=placements[index];
  return Math.hypot(Math.max(a[0]-p[0],0,p[0]-a[0]-TILE),Math.max(a[1]-p[1],0,p[1]-a[1]-TILE));
}
// The grid is rebuilt whenever a different placements array is supplied.
export function createTerrainIndex() {
  let gridSource,grid;
  return {nearby(placements,p,radius=850) {
    if(p.length!==2||!p.every(Number.isFinite))throw Error('Invalid terrain observer');
    const low=p.map(v=>Math.floor((v-radius)/TILE)),high=p.map(v=>Math.floor((v+radius)/TILE));
    if(![...low,...high].every(Number.isSafeInteger))throw Error('Invalid terrain observer');
    if(gridSource!==placements){
      grid=new Map();gridSource=placements;
      for(let i=0;i<placements.length;i++){
        const a=placements[i];
        for(let x=Math.floor(a[0]/TILE);x<=Math.floor((a[0]+TILE)/TILE);x++)
          for(let y=Math.floor(a[1]/TILE);y<=Math.floor((a[1]+TILE)/TILE);y++){
            const key=`${x}:${y}`;
            if(!grid.has(key))grid.set(key,[]);
            grid.get(key).push(i);
          }
      }
    }
    const found=new Set();
    for(let x=low[0];x<=high[0];x++)
      for(let y=low[1];y<=high[1];y++)
        for(const index of grid.get(`${x}:${y}`)||[])found.add(index);
    return [...found].map(i=>[i,terrainDistance(placements,i,p)]).filter(([,d])=>d<radius)
      .sort((a,b)=>a[1]-b[1]||a[0]-b[0]).map(([i])=>i);
  }};
}
export function focusRegionOf(manifest,p) {
  if(p[0]<manifest.ocean[0])return 0;
  if(p[0]>=manifest.ocean[2])return 1;
  return p[0]<(manifest.ocean[0]+manifest.ocean[2])/2?0:1;
}
export function sourcePositionOf(manifest,region,p) {
  const r=manifest.regions[region];
  return [-(p[2]-r.placement[1]+(r.tile_origin[1]-32)*TILE),
    -(p[0]-r.placement[0]+(r.tile_origin[0]-32)*TILE),p[1]];
}
// Returns the previous window while it still covers the query, otherwise a freshly filtered one.
export function nextUnresolvedWindow(previous,sceneState,revision,p,region,radius,vertical) {
  if(!previous||previous.state!==sceneState||previous.revision!==revision||previous.region!==region||
    radius>previous.radius||vertical>previous.vertical||
    Math.hypot(...p.map((v,a)=>v-previous.position[a]))>=16) {
    // This is only a conservative broad phase; exact hull/camera predicates still run every frame.
    return {state:sceneState,revision,region,position:p.slice(),radius,vertical,
      candidates:sceneState.unresolvedCollision.filter(i=>(i.kind==='wmo'&&!i.boundsKnown)||
        boundsWithin(i.bounds,p,radius+16,vertical+16))};
  }
  return previous;
}
export const isCameraUnknown=(i,p)=>(i.kind==='wmo'&&!i.boundsKnown)||boundsWithin(i.bounds,p,84);
export function isObjectWaiting(i,{restoring,radius,verticalRadius,predicted,bodySource}) {
  if(i.kind==='wmo' && !i.boundsKnown)return true;
  // shortcut: unknown M2 extents use a 32-yard proximity guard until their authored hull is decoded.
  const guard=i.boundsKnown?radius:Math.max(32,radius);
  return restoring?boundsDistance(i.bounds,predicted,bodySource)<guard:
    boundsWithin(i.bounds,bodySource,guard,
    i.boundsKnown?verticalRadius:Math.max(32,verticalRadius));
}
export const formatError=error=>`${error.code?`${error.code}: `:''}${error.message || error}`;
const finitePose=pose=>Array.isArray(pose)&&pose.length===4&&pose.every(v=>Number.isFinite(v)&&Math.abs(v)<1e12);
export function validateHop(hop) {
  if(hop!==undefined&&(!Number.isSafeInteger(hop)||hop<0))throw new Error('Invalid hop sequence');
}
export function validateSampleTime(time) {
  if(time!==undefined && !Number.isFinite(time))throw new Error('Invalid input sample time');
}
export function validateParkedPose(pose) {
  if(!finitePose(pose))throw new Error('Invalid parked pose '+JSON.stringify(pose));
}
export function validateTuning(values) {
  if(!Array.isArray(values)||values.length!==17||!values.every(Number.isFinite))throw new Error('Tuning requires exactly 17 finite numbers');
}
