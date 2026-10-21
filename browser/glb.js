// Minimal binary glTF (GLB 2.0) reader for the shipped vehicle models. Pure: no DOM, no GPU.
// Output matches the renderer's scene-craft layout: 12-float vertices (position, normal, uv, rgba), uint32 indices,
// batches. glTF space (+y up, -z forward, +x right) is converted to the craft's model space (+x forward, +y left,
// +z up), which `craftMatrix` maps into the world. Markers: nodes named Cockpit, EngineL/EngineR (kept as parts)
// and ExhaustL/ExhaustR (empties where flames are drawn) are reported in model space.
const MAGIC=0x46546C67,JSON_CHUNK=0x4E4F534A,BIN_CHUNK=0x004E4942;
export const LIMITS={indices:120000,vertices:120000,textures:16};
const TYPES={5120:Int8Array,5121:Uint8Array,5122:Int16Array,5123:Uint16Array,5125:Uint32Array,5126:Float32Array};
const WIDTH={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
const NORMALIZE={5120:127,5121:255,5122:32767,5123:65535};
export const toModel=(x,y,z)=>[-z,-x,y];

export function parseGlb(buffer) {
  const view=new DataView(buffer);
  if(buffer.byteLength<20||view.getUint32(0,true)!==MAGIC)throw new Error('not a GLB file');
  if(view.getUint32(4,true)!==2)throw new Error('only glTF 2.0 is supported');
  if(view.getUint32(8,true)>buffer.byteLength)throw new Error('GLB is truncated');
  let json,bin,offset=12;
  while(offset+8<=buffer.byteLength){
    const length=view.getUint32(offset,true),type=view.getUint32(offset+4,true),start=offset+8;
    if(start+length>buffer.byteLength)throw new Error('GLB chunk is truncated');
    if(type===JSON_CHUNK)json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,start,length)));
    else if(type===BIN_CHUNK&&!bin)bin=new Uint8Array(buffer,start,length);
    offset=start+((length+3)&~3);
  }
  if(!json)throw new Error('GLB has no JSON chunk');
  return {json,bin:bin||new Uint8Array(0)};
}

// Reads accessor `index` as a flat Float32Array (integers are normalised when flagged) or an integer array for indices.
function read(json,bin,index) {
  const a=json.accessors?.[index];
  if(!a||a.sparse)throw new Error('unsupported or missing accessor');
  const T=TYPES[a.componentType],n=WIDTH[a.type];
  if(!T||!n)throw new Error('unsupported accessor type');
  const out=a.componentType===5125||a.type==='SCALAR'&&a.componentType!==5126?new Uint32Array(a.count*n):new Float32Array(a.count*n);
  if(a.bufferView===undefined)return out;
  const bv=json.bufferViews[a.bufferView],base=(bv.byteOffset||0)+(a.byteOffset||0),stride=bv.byteStride||T.BYTES_PER_ELEMENT*n;
  if(base+stride*(a.count-1)+T.BYTES_PER_ELEMENT*n>bin.byteLength)throw new Error('accessor reads past the buffer');
  const dv=new DataView(bin.buffer,bin.byteOffset),norm=a.normalized&&NORMALIZE[a.componentType];
  const get={5120:'getInt8',5121:'getUint8',5122:'getInt16',5123:'getUint16',5125:'getUint32',5126:'getFloat32'}[a.componentType];
  for(let i=0;i<a.count;i++)for(let k=0;k<n;k++){
    const v=dv[get](base+i*stride+k*T.BYTES_PER_ELEMENT,true);
    out[i*n+k]=norm?Math.max(v/norm,-1):v;
  }
  return out;
}

const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function multiply(a,b) {
  const o=new Array(16);
  for(let c=0;c<4;c++)for(let r=0;r<4;r++)o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
  return o;
}
function local(node) {
  if(node.matrix)return node.matrix;
  const [x,y,z,w]=node.rotation||[0,0,0,1],[sx,sy,sz]=node.scale||[1,1,1],[tx,ty,tz]=node.translation||[0,0,0];
  return [(1-2*(y*y+z*z))*sx,2*(x*y+z*w)*sx,2*(x*z-y*w)*sx,0,
    2*(x*y-z*w)*sy,(1-2*(x*x+z*z))*sy,2*(y*z+x*w)*sy,0,
    2*(x*z+y*w)*sz,2*(y*z-x*w)*sz,(1-2*(x*x+y*y))*sz,0,tx,ty,tz,1];
}
const apply=(m,p)=>[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
const rotate=(m,p)=>{const v=[m[0]*p[0]+m[4]*p[1]+m[8]*p[2],m[1]*p[0]+m[5]*p[1]+m[9]*p[2],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]],l=Math.hypot(...v)||1;return v.map(n=>n/l);};

export function buildVehicle({json,bin}) {
  const vertices=[],indices=[],batches=[],used=new Set(),markers={engines:[],exhausts:[]};
  const visit=(i,parent,depth=0)=>{
    const node=json.nodes?.[i];
    if(!node||depth>32)throw new Error('bad node tree');
    const m=multiply(parent,local(node)),name=node.name||'';
    const at=toModel(...m.slice(12,15));
    if(name==='Cockpit')markers.cockpit=at;
    else if(/^Exhaust[LR]$/.test(name))markers.exhausts.push({side:name.at(-1),at});
    else if(/^Engine[LR]$/.test(name))markers.engines.push({side:name.at(-1),at});
    if(node.mesh!==undefined)for(const prim of json.meshes[node.mesh].primitives||[])primitive(prim,m);
    for(const child of node.children||[])visit(child,m,depth+1);
  };
  const primitive=(prim,m)=>{
    if((prim.mode??4)!==4)throw new Error('only triangle meshes are supported');
    const pos=read(json,bin,prim.attributes.POSITION),count=pos.length/3;
    const nrm=prim.attributes.NORMAL!==undefined?read(json,bin,prim.attributes.NORMAL):undefined;
    const uv=prim.attributes.TEXCOORD_0!==undefined?read(json,bin,prim.attributes.TEXCOORD_0):undefined;
    const col=prim.attributes.COLOR_0!==undefined?read(json,bin,prim.attributes.COLOR_0):undefined;
    const colW=col?col.length/count:0;
    const mat=json.materials?.[prim.material]||{},pbr=mat.pbrMetallicRoughness||{},base=pbr.baseColorFactor||[1,1,1,1];
    const base0=vertices.length/12;
    if(base0+count>LIMITS.vertices)throw new Error('vehicle model has too many vertices');
    for(let v=0;v<count;v++){
      const p=toModel(...apply(m,[pos[v*3],pos[v*3+1],pos[v*3+2]]));
      const n=nrm?toModel(...rotate(m,[nrm[v*3],nrm[v*3+1],nrm[v*3+2]])):[0,0,1];
      const c=colW?[col[v*colW],col[v*colW+1],col[v*colW+2],colW===4?col[v*colW+3]:1]:[1,1,1,1];
      vertices.push(...p,...n,uv?uv[v*2]:0,uv?uv[v*2+1]:0,base[0]*c[0],base[1]*c[1],base[2]*c[2],base[3]*c[3]);
    }
    const idx=prim.indices!==undefined?read(json,bin,prim.indices):Array.from({length:count},(_,i)=>i);
    if(idx.length%3||indices.length+idx.length>LIMITS.indices)throw new Error('vehicle model has too many or malformed triangles');
    const first=indices.length;
    for(const i of idx){if(i>=count)throw new Error('index out of range');indices.push(base0+i);}
    const tex=pbr.baseColorTexture?.index,image=tex!==undefined?json.textures?.[tex]?.source:undefined;
    if(image!==undefined)used.add(image);
    const sampler=json.samplers?.[json.textures?.[tex]?.sampler]||{};
    batches.push({firstIndex:first,indexCount:idx.length,texture:image!==undefined?`vehicle\\${image}`:null,
      blend:mat.alphaMode==='BLEND'?'alpha':'opaque',alphaCutoff:mat.alphaMode==='MASK'?mat.alphaCutoff??.5:0,
      doubleSided:true,wrapX:sampler.wrapS!==33071,wrapY:sampler.wrapT!==33071,
      emissive:Math.max(...(mat.emissiveFactor||[0]))>.5?1:0});
  };
  const scene=json.scenes?.[json.scene??0];
  if(!scene)throw new Error('GLB has no scene');
  for(const root of scene.nodes||[])visit(root,identity());
  if(!indices.length)throw new Error('GLB has no triangles');
  const images=[...used].map(index=>{
    const img=json.images?.[index],bv=json.bufferViews?.[img?.bufferView];
    if(!bv)throw new Error('only embedded textures are supported');
    return {key:`vehicle\\${index}`,mime:img.mimeType||'image/png',
      bytes:bin.slice(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength)};
  });
  if(images.length>LIMITS.textures)throw new Error('vehicle model has too many textures');
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices),batches,images,markers};
}

// Renderer metadata for a built vehicle: cockpit eye anchor (cockpitAnchor adds .75 above the seat) and exhausts.
export function vehicleMetadata({markers}) {
  return {display:0,scale:1,pose:'glb',exhausts:markers.exhausts.map(e=>e.at),
    posedAttachment0:markers.cockpit?{space:'model-local',pose:'stand-frame-0',position:[markers.cockpit[0],markers.cockpit[1],markers.cockpit[2]-.75]}:undefined};
}
