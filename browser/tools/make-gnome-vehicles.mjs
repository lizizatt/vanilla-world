// Generates the original gnomish vehicle models shipped in browser/vehicles/ (no game art involved).
// Usage: node browser/tools/make-gnome-vehicles.mjs   (rewrites vehicles/gnome-car.glb and vehicles/gnome-tower.glb)
// Conventions match glb.js: 1 unit = 1 yard, +Y up, -Z forward; Cockpit/Exhaust* empties are named markers.
import {writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {makeGlb} from '../glb-fixture.mjs';

const sub=(a,b)=>a.map((v,i)=>v-b[i]),add=(a,b)=>a.map((v,i)=>v+b[i]),mul=(a,k)=>a.map(v=>v*k);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>{const l=Math.hypot(...a)||1;return a.map(v=>v/l);};

class Mesh {
  pos=[];nrm=[];col=[];idx=[];
  // Flat-shaded polygon (counter-clockwise seen from outside), fan-triangulated.
  face(points,normal,color) {
    const b=this.pos.length/3;
    for(const p of points){this.pos.push(...p);this.nrm.push(...normal);this.col.push(...color,1);}
    for(let i=1;i<points.length-1;i++)this.idx.push(b,b+i,b+i+1);
  }
  // Prism/frustum along a to b: `sides` corners, radius ra at a and rb at b, optional end caps.
  frustum(a,b,ra,rb,sides,color,{caps=true,twist=0}={}) {
    const axis=norm(sub(b,a)),ref=Math.abs(axis[1])<.9?[0,1,0]:[1,0,0],u=norm(cross(axis,ref)),v=cross(axis,u);
    const ring=(c,r,k)=>{const t=(k/sides+twist)*Math.PI*2;return add(c,add(mul(u,Math.cos(t)*r),mul(v,Math.sin(t)*r)));};
    for(let k=0;k<sides;k++){
      const q=[ring(a,ra,k),ring(a,ra,k+1),ring(b,rb,k+1),ring(b,rb,k)];
      const n=norm(cross(sub(q[1],q[0]),sub(q[3],q[0])));
      this.face(q,n,color);
    }
    if(caps){
      this.face(Array.from({length:sides},(_,k)=>ring(b,rb,k)),axis,color);
      this.face(Array.from({length:sides},(_,k)=>ring(a,ra,sides-k)),mul(axis,-1),color);
    }
  }
  // Square bar from a to b.
  bar(a,b,half,color) {this.frustum(a,b,half*Math.SQRT2,half*Math.SQRT2,4,color,{twist:.125});}
  // Axis-aligned box.
  box([cx,cy,cz],[hx,hy,hz],color) {
    const c=(sx,sy,sz)=>[cx+sx*hx,cy+sy*hy,cz+sz*hz];
    this.face([c(1,-1,-1),c(1,1,-1),c(1,1,1),c(1,-1,1)],[1,0,0],color);
    this.face([c(-1,-1,1),c(-1,1,1),c(-1,1,-1),c(-1,-1,-1)],[-1,0,0],color);
    this.face([c(-1,1,-1),c(-1,1,1),c(1,1,1),c(1,1,-1)],[0,1,0],color);
    this.face([c(-1,-1,1),c(-1,-1,-1),c(1,-1,-1),c(1,-1,1)],[0,-1,0],color);
    this.face([c(1,-1,1),c(1,1,1),c(-1,1,1),c(-1,-1,1)],[0,0,1],color);
    this.face([c(-1,-1,-1),c(-1,1,-1),c(1,1,-1),c(1,-1,-1)],[0,0,-1],color);
  }
  wheel([x,y,z],r,width,tyre,hub) {
    const s=Math.sign(x)||1;
    this.frustum([x-s*width/2,y,z],[x+s*width/2,y,z],r,r,10,tyre);
    this.frustum([x+s*width/2,y,z],[x+s*(width/2+.04),y,z],r*.45,r*.45,6,hub);
  }
}

const STEEL=[.34,.37,.4],DARK=[.2,.22,.25],COPPER=[.72,.38,.24],BRASS=[.78,.62,.25],RUBBER=[.1,.1,.11],CLOTH=[.82,.7,.3];

function glb(mesh,nodes,bounds) {
  const p=new Float32Array(mesh.pos),n=new Float32Array(mesh.nrm),c=new Float32Array(mesh.col),i=new Uint32Array(mesh.idx);
  const parts=[p,n,c,i],bin=new Uint8Array(parts.reduce((s,a)=>s+a.byteLength,0));
  const views=[];let off=0;
  for(const a of parts){bin.set(new Uint8Array(a.buffer),off);views.push({buffer:0,byteOffset:off,byteLength:a.byteLength});off+=a.byteLength;}
  return makeGlb({asset:{version:'2.0',generator:'make-gnome-vehicles.mjs'},scene:0,scenes:[{nodes:[0]}],
    nodes:[{name:'Gnome',children:[1,...nodes.map((_,k)=>k+2)]},{name:'Body',mesh:0},...nodes],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,COLOR_0:2},indices:3,material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],metallicFactor:0,roughnessFactor:.8}}],
    buffers:[{byteLength:bin.length}],bufferViews:views,
    accessors:[{bufferView:0,componentType:5126,count:p.length/3,type:'VEC3',min:bounds.min,max:bounds.max},
      {bufferView:1,componentType:5126,count:n.length/3,type:'VEC3'},
      {bufferView:2,componentType:5126,count:c.length/4,type:'VEC4'},
      {bufferView:3,componentType:5125,count:i.length,type:'SCALAR'}]},bin);
}
function bounds(m) {
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let k=0;k<m.pos.length;k++){min[k%3]=Math.min(min[k%3],m.pos[k]);max[k%3]=Math.max(max[k%3],m.pos[k]);}
  return {min,max};
}
const withBody=(mesh,marks)=>{const nodes=marks.map(([name,translation])=>({name,translation}));return glb(mesh,nodes,bounds(mesh));};

// Gnome car: low rivetted tub, bench seat, front boiler, big brass exhaust stack out the back, four chunky wheels.
export function gnomeCar() {
  const m=new Mesh();
  m.box([0,.55,0],[.65,.22,1.3],STEEL);
  m.box([0,.9,.55],[.6,.18,.5],DARK);
  m.box([0,.95,.05],[.55,.1,.35],CLOTH);
  m.frustum([0,.8,-1.35],[0,.8,-.4],.38,.38,12,COPPER);
  m.frustum([0,.8,-1.35],[0,.8,-1.5],.2,.2,8,BRASS);
  m.frustum([0,.95,-.9],[0,1.5,-.9],.1,.07,8,BRASS);
  m.frustum([.35,.75,1.3],[.35,1.1,1.75],.12,.14,8,BRASS);
  m.frustum([-.35,.75,1.3],[-.35,1.1,1.75],.12,.14,8,BRASS);
  m.bar([-.6,1.15,.1],[-.6,1.55,-.05],.04,DARK);m.bar([.6,1.15,.1],[.6,1.55,-.05],.04,DARK);
  m.bar([-.6,1.55,-.05],[.6,1.55,-.05],.04,DARK);
  for(const x of [-.85,.85])for(const z of [-.85,.85])m.wheel([x,.42,z],.42,.3,RUBBER,BRASS);
  return withBody(m,[['Cockpit',[0,1.1,.05]],['ExhaustL',[-.35,1.1,1.8]],['ExhaustR',[.35,1.1,1.8]]]);
}

// Gnome tower: a riveted steel lattice tower on a little wheeled cab, topped by a big copper horn, a rope trailing behind.
export function gnomeTower() {
  const m=new Mesh(),top=4.4,foot=.6,spread=.85,narrow=.55;
  const cab=(x,z)=>[x*foot,.75,z*foot],head=(x,z)=>[x*narrow,top,z*narrow];
  m.box([0,.45,0],[.85,.25,.85],DARK);
  for(const [x,z] of [[-1,-1],[1,-1],[-1,1],[1,1]]){
    m.bar(cab(x,z),head(x,z),.09,STEEL);
    m.box([x*.85,.85,z*.85],[.05,.3,.05],STEEL);
  }
  for(const y of [1.5,2.4,3.3]){
    const k=(y-.75)/(top-.75),w=foot+(narrow-foot)*k;
    for(const [a,b] of [[[-w,y,-w],[w,y,-w]],[[w,y,-w],[w,y,w]],[[w,y,w],[-w,y,w]],[[-w,y,w],[-w,y,-w]]])m.bar(a,b,.05,STEEL);
  }
  for(const [x,z] of [[-1,-1],[1,1]])m.bar([x*foot,.75,z*foot],[-x*narrow,top,z*narrow],.04,DARK);
  m.box([0,top+.1,0],[.75,.12,.75],STEEL);
  const dir=norm([-.45,.45,-.25]);
  m.frustum([0,top+.5,0],add([0,top+.5,0],mul(dir,2.2)),.55,1.3,10,COPPER);
  m.frustum([0,top+.5,0],[0,top+.2,0],.45,.45,10,BRASS,{caps:false});
  m.bar([.45,top+.4,.3],[1.3,top+.2,1.9],.06,COPPER);
  m.bar([-.8,.6,.8],[-.9,0,2.8],.03,[.6,.45,.25]);
  m.box([0,.2,0],[.3,.1,.3],DARK);
  for(const x of [-.95,.95])for(const z of [-.55,.55])m.wheel([x,.38,z],.38,.28,RUBBER,BRASS);
  m.box([0,1.05,-.7],[.45,.05,.1],DARK);
  return withBody(m,[['Cockpit',[0,.95,0]],['ExhaustL',[-.45,top+.2,.9]],['ExhaustR',[.45,top+.2,.9]]]);
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const out=fileURLToPath(new URL('../vehicles/',import.meta.url));
  mkdirSync(out,{recursive:true});
  for(const [name,build] of [['gnome-car',gnomeCar],['gnome-tower',gnomeTower]]){
    const bytes=Buffer.from(build());writeFileSync(`${out}${name}.glb`,bytes);console.log(`${name}.glb ${bytes.length} bytes`);
  }
}
