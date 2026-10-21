// Plain procedural plane (original art, no game data): boxes in the renderer's craft payload shape.
// Model space: x forward, y left, z up, units yards, origin at the centre of mass.
const FACES=[[[1,0,0],[[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]]],[[-1,0,0],[[-1,1,-1],[-1,-1,-1],[-1,-1,1],[-1,1,1]]],
  [[0,1,0],[[1,1,-1],[-1,1,-1],[-1,1,1],[1,1,1]]],[[0,-1,0],[[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]]],
  [[0,0,1],[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],[[0,0,-1],[[-1,1,-1],[1,1,-1],[1,-1,-1],[-1,-1,-1]]]];

export function planeAsset() {
  const vertices=[],indices=[];
  const box=(c,h,rgba)=>{
    for(const [n,quad] of FACES) {
      const base=vertices.length/12;
      for(const q of quad)vertices.push(c[0]+q[0]*h[0],c[1]+q[1]*h[1],c[2]+q[2]*h[2],...n,0,0,...rgba);
      indices.push(base,base+1,base+2,base,base+2,base+3);
    }
  };
  box([0,0,0],[2.6,.55,.55],[.85,.8,.7,1]);
  box([.3,0,0],[.7,4,.08],[.75,.25,.15,1]);
  box([-2.4,0,.1],[.5,1.5,.06],[.75,.25,.15,1]);
  box([-2.4,0,.7],[.5,.06,.7],[.85,.8,.7,1]);
  box([2.7,0,0],[.15,.9,.9],[.3,.3,.3,1]);
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices),
    batches:[{firstIndex:0,indexCount:indices.length,texture:null,blend:'opaque',alphaCutoff:0,doubleSided:false}]};
}

export const planePayload=()=>({asset:planeAsset(),textures:[],key:'procedural:plane',
  metadata:{display:0,scale:1,pose:'plane',exhausts:[]}});
