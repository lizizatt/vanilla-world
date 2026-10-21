// Builds tiny GLB files for tests and local smoke runs (never hosted: not in the service worker list).
export function makeGlb(json,bin=new Uint8Array(0)) {
  const pad=(bytes,fill)=>{const out=new Uint8Array((bytes.length+3)&~3).fill(fill);out.set(bytes);return out;};
  const j=pad(new TextEncoder().encode(JSON.stringify(json)),0x20),b=pad(bin,0);
  const total=12+8+j.length+(b.length?8+b.length:0),out=new ArrayBuffer(total),v=new DataView(out);
  v.setUint32(0,0x46546C67,true);v.setUint32(4,2,true);v.setUint32(8,total,true);
  v.setUint32(12,j.length,true);v.setUint32(16,0x4E4F534A,true);new Uint8Array(out,20,j.length).set(j);
  if(b.length){const o=20+j.length;v.setUint32(o,b.length,true);v.setUint32(o+4,0x004E4942,true);new Uint8Array(out,o+8,b.length).set(b);}
  return out;
}

// A small boxy racer: pod body, two engine boxes, Cockpit/Exhaust empties. Forward is glTF -z.
export function sampleVehicle(color=[.8,.3,.1,1]) {
  const boxes=[[0,.6,0,.7,.5,1.6],[-1.6,.5,.4,.45,.45,1.4],[1.6,.5,.4,.45,.45,1.4]],pos=[],idx=[];
  for(const [cx,cy,cz,hx,hy,hz] of boxes){
    const b=pos.length/3;
    for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1])pos.push(cx+sx*hx,cy+sy*hy,cz+sz*hz);
    for(const f of [[0,1,3,0,3,2],[4,6,7,4,7,5],[0,4,5,0,5,1],[2,3,7,2,7,6],[0,2,6,0,6,4],[1,5,7,1,7,3]])idx.push(...f.map(i=>b+i));
  }
  const p=new Float32Array(pos),i=new Uint16Array(idx),bin=new Uint8Array(p.byteLength+i.byteLength);
  bin.set(new Uint8Array(p.buffer),0);bin.set(new Uint8Array(i.buffer),p.byteLength);
  const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],
    nodes:[{name:'Racer',children:[1,2,3,4,5]},{name:'Body',mesh:0},{name:'Cockpit',translation:[0,1.2,-.2]},
      {name:'EngineL',translation:[-1.6,.5,.4]},{name:'ExhaustL',translation:[-1.6,.5,1.8]},{name:'ExhaustR',translation:[1.6,.5,1.8]}],
    meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:color}}],
    buffers:[{byteLength:bin.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:p.byteLength},{buffer:0,byteOffset:p.byteLength,byteLength:i.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:p.length/3,type:'VEC3',min:[-2.1,0,-1],max:[2.1,1.1,2]},
      {bufferView:1,componentType:5123,count:i.length,type:'SCALAR'}]};
  return makeGlb(json,bin);
}
