import test from 'node:test';
import assert from 'node:assert/strict';
import {worldMapAreas,imageRects,schematicRects,mapFrame,toMap,fromMap,mapIcons,regionOffset,CLOUD_TOP_DROP,worldArt,MAELSTROM_ART,ELUNE_ART} from './worldmap.js';
import {CLOUD_ALTITUDE,CLOUD_THICKNESS} from './cloud-config.js';

function dbc(rows) {
  const strings=['\0'],offsets=rows.map(r=>{const o=strings.join('').length;strings.push(r.name+'\0');return o;});
  const block=Buffer.from(strings.join('')),out=Buffer.alloc(20+rows.length*36+block.length);
  out.write('WDBC');out.writeUInt32LE(rows.length,4);out.writeUInt32LE(9,8);out.writeUInt32LE(36,12);out.writeUInt32LE(block.length,16);
  rows.forEach((r,i)=>{const b=20+i*36;out.writeUInt32LE(i+1,b);out.writeInt32LE(r.map,b+4);out.writeUInt32LE(r.area,b+8);out.writeUInt32LE(offsets[i],b+12);
    [r.left,r.right,r.top,r.bottom].forEach((v,k)=>out.writeFloatLE(v,b+16+k*4));});
  block.copy(out,20+rows.length*36);return new Uint8Array(out);
}
const manifest={spawn:[100,5,200],sea_level:0,world_bounds:[[0,0,51,56]],horizons:[],
  regions:[{map:'Kalimdor',placement:[-1000,-500],tile_origin:[16,16]},{map:'Azeroth',placement:[20000,-500],tile_origin:[0,0]}]};
const rows=worldMapAreas(dbc([{map:1,area:0,name:'Kalimdor',left:17000,right:-12000,top:5000,bottom:-8000},
  {map:0,area:0,name:'Azeroth',left:18000,right:-18000,top:3000,bottom:-5000},{map:0,area:12,name:'Elwynn',left:1,right:0,top:1,bottom:0}]));

test('WorldMapArea rows parse and reject bad layouts',()=>{
  assert.equal(rows[0].name,'Kalimdor');assert.equal(rows[0].left,17000);
  assert.throws(()=>worldMapAreas(new Uint8Array(30)));
});
test('continent images land in render space: east is +x, north is -z',()=>{
  const [kx,kz]=regionOffset(manifest.regions[0]);
  const [k]=imageRects(manifest,rows);
  assert.deepEqual(k,[kx-17000,kz-5000,kx+12000,kz+8000]);
  assert.ok(k[0]<k[2]&&k[1]<k[3]);
});
test('Stormwind (WoW x -8800, y 500) is where tile 48/31 puts it',()=>{
  const az={placement:[0,0],tile_origin:[32,32]},[kx,kz]=regionOffset(az);
  assert.ok(Math.abs((kx-500)-(-500))<1e-6&&Math.abs((kz+8800)-8800)<1e-6);
});
test('frame mapping round-trips and icons hold spawn and maelstrom',()=>{
  const frame=mapFrame([[0,0,1000,500]],[[1200,-100]]);
  const [u,v]=toMap(frame,250,125);assert.deepEqual(fromMap(frame,u,v).map(Math.round),[250,125]);
  const icons=mapIcons(manifest,[7,8]);
  assert.deepEqual(icons.map(i=>i.id),['raceway','maelstrom','airport','stormwind','orgrimmar','undercity','darnassus']);
  const [kx,kz]=regionOffset(manifest.regions[0]),og=icons.find(i=>i.id==='orgrimmar').pose,uc=icons.find(i=>i.id==='undercity').pose;
  assert.deepEqual(og,[4420+kx,35,-1330+kz,0]);assert.ok(Math.abs(uc[3]-Math.PI)<1e-9);
  assert.deepEqual(icons[0].position,[100,200]);assert.deepEqual(icons[1].pose,[7,CLOUD_TOP_DROP,8,0]);assert.ok(CLOUD_TOP_DROP>CLOUD_ALTITUDE+CLOUD_THICKNESS/2);
});
import {WORLD_MAPS as WM} from './worldmap.js';
test('single world map names are preferred candidates',()=>{assert.ok(WM.includes('World'));});
import {maelstromCentre as mc} from './clouds.js';
const ART_M={spawn:[0,5,0],sea_level:0,world_bounds:[[0,0,51,56],[24,20,45,62]],ocean:[5333.33,-7466.667,13525.33,22400],horizons:[],regions:[{id:'k',map:'Kalimdor',tile_origin:[0,0],tile_count:[64,64],placement:[-21866.667,-7466.667]},{id:'e',map:'Azeroth',tile_origin:[0,0],tile_count:[64,64],placement:[725.333,-16000]}]};
const KO=[-4800,9600],EO=[17792,1066.67];
// WoW (x north, y west) to render, per continent, then through the fitted chart; px = where the place is painted in world-map-art.jpg (800x533)
const PLACES=[['Orgrimmar',KO,1330,-4420,[230,239]],['Darnassus',KO,9950,2150,[124,90]],['Thunder Bluff',KO,-1280,128,[157,284]],['Gadgetzan',KO,-7150,-3790,[220,386]],['Ratchet',KO,-960,-3830,[221,279]],['Moonglade',KO,7500,-2500,[199,132]],['Stormwind',EO,-8985,497,[582,333]],['Undercity',EO,1890,240,[586,147]],['Booty Bay',EO,-14400,440,[583,425]],['Ironforge',EO,-5000,-880,[603,265]]];
test('map chart: known places land on their painted spot (residuals within 20px, mean under 8)',()=>{
  const f=worldArt(ART_M,mc(ART_M)),res=PLACES.map(([n,o,wx,wy,[px,py]])=>{const p=f(o[0]-wy,o[1]-wx);return [n,Math.hypot(p[0]-px,p[1]-py)];});
  for(const [n,r] of res)assert.ok(r<20,`${n} off by ${r.toFixed(1)}px`);
  assert.ok(res.reduce((s,r)=>s+r[1],0)/res.length<8);
});
test('map chart: Maelstrom centre is the painted eye, and the sea stays monotone (never folds)',()=>{
  const c=mc(ART_M),f=worldArt(ART_M,c),m=f(...c);
  assert.ok(Math.hypot(m[0]-MAELSTROM_ART[0],m[1]-MAELSTROM_ART[1])<2);
  for(const z of [c[1]-6000,c[1],c[1]+6000]){let last=-Infinity;for(let x=-5000;x<=17000;x+=200){const u=f(x,z)[0];assert.ok(u>last,`fold at ${x},${z}`);last=u;}}
  for(const x of [3000,c[0],14000]){let last=-Infinity;for(let z=-6000;z<=21000;z+=200){const v=f(x,z)[1];assert.ok(v>last,`fold at ${x},${z}`);last=v;}}
});
test('map chart: needs both continents and the ocean, Elune icon sits on the painted moon',()=>{
  assert.equal(worldArt({regions:[ART_M.regions[0]]},[0,0]),undefined);
  assert.equal(worldArt({...ART_M,ocean:undefined},[0,0]),undefined);
  assert.ok(Math.hypot(ELUNE_ART[0]-450,ELUNE_ART[1]-92)<=64);
});
