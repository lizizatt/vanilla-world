// Radial intake art verified in the user's Lod1 models. Not exhaust glows (117),
// rectangular grilles, body panels or engine housings: those must remain stationary.
export const INTAKE_TEXTURES = new Set([112,152,198,276,305,324,352,470,500,551,577]);

// MaterialTextureChild byte 3 encodes N64 T/S addressing nibbles.
export function textureAddress(flags=0) {
  const mode=n => n&2?'clamp-to-edge':n&1?'mirror-repeat':'repeat';
  return {addressU:mode(flags>>4),addressV:mode(flags)};
}

// A mesh can contain several disconnected fan cards. Keep each connected part
// separate; otherwise the two fans orbit their shared midpoint.
export function intakeIslands(tris) {
  const groups=[];
  const key=p=>`${p[0]},${p[1]},${p[2]}`;
  for(const tri of tris) {
    const keys=tri.P.map(key), hits=[];
    for(let i=0;i<groups.length;i++)if(keys.some(k=>groups[i].keys.has(k)))hits.push(i);
    const group=hits.length?groups[hits[0]]:{keys:new Set(),tris:[]};
    if(!hits.length)groups.push(group);
    for(let j=hits.length-1;j>0;j--){
      const other=groups.splice(hits[j],1)[0];
      other.keys.forEach(k=>group.keys.add(k));group.tris.push(...other.tris);
    }
    keys.forEach(k=>group.keys.add(k));group.tris.push(tri);
  }
  return groups.map(({tris})=>{
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(const {P} of tris)for(const p of P)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],p[a]);hi[a]=Math.max(hi[a],p[a]);}
    // Keep sculpted hubs/static surfaces using the same atlas out of the rotor.
    const radial=Math.min(hi[0]-lo[0],hi[2]-lo[2]);
    const rotor=radial>0&&hi[1]-lo[1]<radial*.4;
    return {tris,pivot:rotor?lo.map((v,a)=>(v+hi[a])/2):null};
  });
}

export function advanceIntake(angle,dt,throttle,speed) {
  if(!Number.isFinite(dt)||dt<=0)return angle;
  const gas=Number.isFinite(throttle)?Math.max(0,Math.min(1,throttle)):0;
  const velocity=Number.isFinite(speed)?Math.min(1,Math.abs(speed)/150):0;
  return (angle+Math.min(dt,.1)*(2.5+25*Math.max(gas,velocity)))%(Math.PI*2);
}

// Write model * rotation-about-craft-X directly into the existing uniform slab.
// No temporary arrays, matrices or vertex uploads in the animation hot path.
export function writeIntakeMatrix(out,offset,m,pivot,angle) {
  const c=Math.cos(angle),s=Math.sin(angle),y=pivot[1],z=pivot[2];
  const ty=y-c*y+s*z,tz=z-s*y-c*z;
  for(let row=0;row<4;row++){
    out[offset+row]=m[row];
    out[offset+4+row]=m[4+row]*c+m[8+row]*s;
    out[offset+8+row]=-m[4+row]*s+m[8+row]*c;
    out[offset+12+row]=m[12+row]+m[4+row]*ty+m[8+row]*tz;
  }
}
