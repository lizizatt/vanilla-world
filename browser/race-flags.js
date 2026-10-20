// Procedural race flag geometry and flag proximity. No game art. Vertex layout matches the terrain
// pipeline: position(3) normal(3) material(1); materials 5 pole, 6 red, 7 white, 8 beacon.
import {validateTrack} from './race.js';

export const FLAG_RANGE=70;
export const TRACK_FILES=['./tracks/steamwheedle.json'];

const FACES=[[[1,0,0],[[1,0,0],[1,1,0],[1,1,1],[1,0,1]]],[[-1,0,0],[[0,0,1],[0,1,1],[0,1,0],[0,0,0]]],
  [[0,1,0],[[0,1,0],[0,1,1],[1,1,1],[1,1,0]]],[[0,-1,0],[[0,0,1],[0,0,0],[1,0,0],[1,0,1]]],
  [[0,0,1],[[1,0,1],[1,1,1],[0,1,1],[0,0,1]]],[[0,0,-1],[[0,0,0],[0,1,0],[1,1,0],[1,0,0]]]];

function box(out,[x,y,z],[w,h,d],material) {
  for(const [n,quad] of FACES)for(const i of [0,1,2,0,2,3]){
    const c=quad[i];out.push(x+c[0]*w,y+c[1]*h,z+c[2]*d,...n,material);
  }
}

// Flag standing at local x/z 0 with its base at world height y.
export function flagMesh(y) {
  const v=[];
  box(v,[-.3,y-2,-.3],[.6,26,.6],5);
  for(let row=0;row<2;row++)for(let col=0;col<3;col++)box(v,[.3+col*3,y+18-row*3,-.1],[3,3,.2],(row+col)%2?7:6);
  box(v,[-.75,y+24,-.75],[1.5,260,1.5],8);
  return new Float32Array(v);
}

// Stand the flag beside the start line so it never sits on the lined-up craft.
export function flagPosition({start:{pos,yaw}},offset=12) { return [pos[0]+Math.cos(yaw)*offset,pos[1],pos[2]-Math.sin(yaw)*offset]; }

export function nearestFlag(tracks,p,range=FLAG_RANGE) {
  let best;
  for(const track of tracks){
    const s=track.start.pos,d=Math.hypot(p[0]-s[0],p[2]-s[2]);
    if(d<=range&&Math.abs(p[1]-s[1])<=range&&(!best||d<best.distance))best={track,distance:d};
  }
  return best?.track;
}

export async function loadTracks(fetcher=fetch,files=TRACK_FILES) {
  const tracks=[];
  for(const file of files){
    try{
      const response=await fetcher(file);
      if(response.ok)tracks.push(validateTrack(await response.json()));
    }catch(error){console.warn(`Race track ${file} skipped: ${error.message}`);}
  }
  return tracks;
}
