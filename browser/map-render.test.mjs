import test from 'node:test';
import assert from 'node:assert/strict';
import {MapRaster,MAP_CELL,mapFields,shadeMap,boxBlur,heightColour} from './map-render.js';
import {MapPanel} from './map-panel.js';
import {mapFrame,moonFrame,moonSpot,toMap,mapIcons} from './worldmap.js';

const manifest={spawn:[0,5,0],sea_level:0,ocean:[5333.33,-7466.667,13525.33,22400],world_bounds:[[0,0,51,56],[24,20,45,62]],horizons:[{region:0,source_bounds:[0,0,51,56]},{region:1,source_bounds:[24,20,45,62]}],
  regions:[{id:'k',map:'Kalimdor',tile_origin:[0,0],tile_count:[64,64],placement:[-21866.667,-7466.667]},{id:'e',map:'Azeroth',tile_origin:[0,0],tile_count:[64,64],placement:[725.333,-16000]}]};
const TILE=1600/3;

/** A flat-topped island of radius `r` yd centred on chart (cx,cz), fed as horizon vertices like the worker sends them. */
function island(raster,cx,cz,r,height=300) {
  const v=[];for(let x=cx-r*1.4;x<=cx+r*1.4;x+=30)for(let z=cz-r*1.4;z<=cz+r*1.4;z+=30)v.push(x,Math.hypot(x-cx,z-cz)<r?height:-515,z,0,0,0,0);
  raster.addHeights(Float32Array.from(v),[0,0]);
}
const px=(out,w,x,y)=>[...out.slice((y*w+x)*4,(y*w+x)*4+3)];

test('raster: heights and minimap colour land in the cell of their chart position', () => {
  const r=new MapRaster(manifest);
  r.addHeights(Float32Array.from([10,120,20,0,0,0,0]),[1000,2000]);
  const k=r.cell(1010,2020);assert.ok(k>=0);assert.equal(r.hsum[k]/r.hn[k],120);
  const rgba=new Uint8Array(32*32*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=255;rgba[i+3]=255;}
  r.addMinimap(rgba,[3000,4000]);
  const c=r.cell(3000+TILE/2,4000+TILE/2);assert.ok(r.cn[c]>0);assert.ok(Math.abs(r.csum[c*3]/r.cn[c]-1)<1e-6);
  assert.equal(r.cell(-1e6,0),-1);assert.equal(r.tiles.size,1);
});

test('land mask: an island is land inside, sea outside, with a smooth coast', () => {
  const r=new MapRaster(manifest),c=[-3000,2000];island(r,c[0],c[1],2500);
  const f=mapFields(r,0),at=(x,z)=>{const k=r.cell(x,z);return f.land[k];};
  assert.ok(at(c[0],c[1])>.95);assert.ok(at(c[0]+5000,c[1])<.02);
  const mid=at(c[0]+2500,c[1]);assert.ok(mid>.1&&mid<.9,`coast ${mid}`);
});

test('shading: land is tinted differently from sea, coast is inked dark, hillshade lights the north-west face', () => {
  const r=new MapRaster(manifest),c=[-3000,2000],v=[];
  for(let x=c[0]-3000;x<=c[0]+3000;x+=30)for(let z=c[1]-3000;z<=c[1]+3000;z+=30){const d=Math.hypot(x-c[0],z-c[1]);v.push(x,d<2500?600*Math.cos(d/2500*Math.PI/2)+5:-515,z,0,0,0,0);}
  r.addHeights(Float32Array.from(v),[0,0]);
  const frame={x0:c[0]-4000,z0:c[1]-4000,width:8000,height:8000},W=200,out=shadeMap(mapFields(r,0),r,frame,W,W);
  const sea=px(out,W,5,5),land=px(out,W,100,100),nw=px(out,W,70,70),se=px(out,W,130,130);
  assert.notDeepEqual(sea,land);
  const lum=p=>p[0]+p[1]+p[2],cx=100+Math.round(2500/8000*W),coast=[-4,-3,-2,-1,0,1,2,3,4].map(d=>px(out,W,cx+d,100)).sort((p,q)=>lum(p)-lum(q))[0],sea2=px(out,W,cx+25,100);
  assert.ok(lum(coast)<lum(land)*.7&&lum(coast)<lum(sea2)*.7,`coast ${coast} land ${land} sea ${sea}`);
  assert.ok(lum(nw)>lum(se),`nw ${nw} se ${se}`);
  assert.deepEqual(shadeMap(mapFields(r,0),r,frame,W,W),out);
});

test('chart exactness: a feature placed at a city shows up at the pixel the icon uses (within 2px)', () => {
  const frame=moonFrame(mapFrame([[-21867,-7467,5333,22400],[13525,-5333,24725,17067]],[[8856,3507]])),W=500,Hh=Math.round(W*frame.height/frame.width);
  const r=new MapRaster(manifest);
  const cities=mapIcons(manifest,[8856,3507]).filter(i=>['orgrimmar','stormwind','undercity','darnassus'].includes(i.id));
  for(const c of cities)island(r,c.position[0],c.position[1],900);
  const out=shadeMap(mapFields(r,0),r,frame,W,Hh);
  for(const c of cities){
    const [u,v]=toMap(frame,...c.position),cx=u*W,cy=v*Hh;let sx=0,sy=0,n=0;
    for(let y=Math.max(0,Math.round(cy)-15);y<Math.min(Hh,Math.round(cy)+15);y++)for(let x=Math.max(0,Math.round(cx)-15);x<Math.min(W,Math.round(cx)+15);x++){
      const p=px(out,W,x,y);if(p[0]-p[2]>12){sx+=x+.5;sy+=y+.5;n++;} // warm parchment land against cool sea
    }
    assert.ok(n>20,`${c.id} land pixels ${n}`);
    assert.ok(Math.hypot(sx/n-cx,sy/n-cy)<2,`${c.id} centroid ${(sx/n).toFixed(1)},${(sy/n).toFixed(1)} vs icon ${cx.toFixed(1)},${cy.toFixed(1)}`);
  }
});

test('moon spot sits in the band above the continents and over the Maelstrom column', () => {
  const base=mapFrame([[-21867,-7467,5333,22400],[13525,-5333,24725,17067]],[[8856,3507]]),f=moonFrame(base),m=moonSpot(f,[8856,3507]);
  assert.equal(m[0],8856);assert.ok(m[1]<base.z0&&m[1]>f.z0);
  const [u,v]=toMap(f,...m);assert.ok(u>0&&u<1&&v>0&&v<.2);
});

test('panel: far events feed the raster, the generated map replaces the schematic, Elune sits on the moon, icons use the same chart', () => {
  const els=[],make=()=>({style:{},dataset:{},addEventListener(){},remove(){},getContext:()=>({clearRect(){},drawImage(){},save(){},restore(){}})});
  globalThis.document={createElement:()=>make()};globalThis.fetch=async()=>({ok:false});
  const stage={ownerDocument:{createElement:()=>make()},style:{setProperty(){}},querySelectorAll:()=>[],append:e=>els.push(e)},drawn=[];
  try {
    const panel=new MapPanel({dialog:{addEventListener(){},open:true},canvas:{width:100,getContext:()=>({clearRect(){},drawImage:i=>drawn.push(i),save(){},restore(){},fillRect(){},strokeRect(){},fillText(){},beginPath(){},rect(){},stroke(){},fill(){}})},stage,status:{},close:{addEventListener(){}}},
      {requestArt(){},teleport(){},pose:()=>undefined,bodies:()=>[{id:'elune',label:'Elune'}]});
    panel.renderer=({frame,moon})=>({marker:'generated',frame,moon});
    panel.you=make();panel.configure(manifest,'fp');
    panel.render();assert.equal(drawn.length,0,'no generated map before any terrain');
    panel.far({event:'horizon',vertices:Float32Array.from([10,120,20,0,0,0,0]),placement:[1000,2000]});
    panel.far({event:'horizon-material',region:0,x:5,y:5,rgba:new Uint8Array(32*32*4)});
    clearTimeout(panel.refine);panel.refine=0;
    panel.render();
    assert.equal(drawn.at(-1)?.marker,'generated');
    const icon=mapIcons(manifest,[8856,3507])[0],btn=els.findLast(e=>e.dataset.icon===icon.id),[u,v]=toMap(panel.frame,...icon.position);
    assert.equal(btn.style.left,`${u*100}%`);assert.equal(btn.style.top,`${v*100}%`);
    const elune=els.findLast(e=>e.dataset.body==='elune'),[mu,mv]=toMap(panel.frame,...panel.moonAt);
    assert.equal(elune.style.left,`${mu*100}%`);assert.equal(elune.style.top,`${mv*100}%`);
    assert.equal(panel.configure(manifest,'fp'),undefined);assert.ok(panel.raster.tiles.size>0,'same data fingerprint keeps the raster');
  } finally { delete globalThis.document;delete globalThis.fetch; }
});

test('far events that stream in before configure() are queued and replayed', () => {
  const panel=new MapPanel({dialog:{addEventListener(){},open:false},canvas:{},stage:{ownerDocument:{createElement:()=>({style:{},dataset:{}})}},status:{},close:{addEventListener(){}}},{requestArt(){},teleport(){},pose:()=>undefined});
  panel.far({event:'horizon',vertices:Float32Array.from([10,120,20,0,0,0,0]),placement:[1000,2000]});
  panel.far({event:'horizon-material',region:0,x:5,y:5,rgba:new Uint8Array(32*32*4)});
  assert.equal(panel.pending.length,2);
  panel.configure(manifest,'fp');
  assert.equal(panel.pending,undefined);assert.equal(panel.raster.tiles.size,1);
});

test('blur preserves a constant field and height colour ramps from green to pale', () => {
  const a=boxBlur(new Float32Array(100).fill(.5),10,10,2);assert.ok(a.every(v=>Math.abs(v-.5)<1e-6));
  assert.ok(heightColour(0)[1]>heightColour(0)[0]);assert.ok(heightColour(3000)[0]>200);
  assert.equal(MAP_CELL,TILE/8);
});
