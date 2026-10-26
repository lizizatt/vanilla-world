import test from 'node:test';
import assert from 'node:assert/strict';
import {synthAdt,ADT_TILE as T} from './adt-synth.js';
import {adtChunks,mcnkAreas,translateAdt,adtHeights} from './graft-adt.js';
import {graftSource,heightGrid,sampleGrid} from './graft-source.js';
import {moonSource,MOON_SEED} from './moon-source.js';
import {SITES,tilesOf,siteRect,siteMask,outside} from './elune-sites.js';
import {moonHeightChart} from './moon-terrain.js';

const site=SITES.elune[0];
const chunk=(magic,body)=>{const o=new Uint8Array(8+body.length),v=new DataView(o.buffer);for(let i=0;i<4;i++)o[i]=magic.charCodeAt(3-i);v.setUint32(4,body.length,true);o.set(body,8);return o;};
const cat=parts=>{const o=new Uint8Array(parts.reduce((n,a)=>n+a.length,0));let p=0;for(const a of parts){o.set(a,p);p+=a.length;}return o;};
/** A "real" tile: synthetic terrain in area 493 plus one doodad and one WMO placement in file coordinates. */
function fakeTile(sx,sy,height=()=>300) {
  const base=synthAdt(height,sx,sy,'Tileset\\Moonglade\\Grass.blp',493),mddf=new Uint8Array(36),mv=new DataView(mddf.buffer),modf=new Uint8Array(64),wv=new DataView(modf.buffer);
  mv.setFloat32(8,sx*T+100,true);mv.setFloat32(12,300,true);mv.setFloat32(16,sy*T+50,true);
  wv.setFloat32(8,sx*T+10,true);wv.setFloat32(12,300,true);wv.setFloat32(16,sy*T+20,true);
  [32,36,40,44,48,52].forEach((o,i)=>wv.setFloat32(o,[sx*T,290,sy*T,sx*T+20,310,sy*T+40][i],true));
  return cat([base,chunk('MDDF',mddf),chunk('MODF',modf)]);
}
const f32=(b,magic,off)=>{const v=new DataView(b.buffer,b.byteOffset,b.byteLength);for(const c of adtChunks(b))if(c.magic===magic)return v.getFloat32(c.start+off,true);};

test('translating a tile moves corner, doodads and WMO extents by whole tiles and lifts heights, keeping area ids', () => {
  const src=fakeTile(36,17),out=translateAdt(src,{from:[36,17],to:[30,12],yOffset:-250});
  assert.equal(out.length,src.length);
  assert.deepEqual([...new Set(mcnkAreas(out))],[493]);
  assert.ok(Math.abs(f32(out,'MCNK',0x68)-(f32(src,'MCNK',0x68)+5*T))<1e-2);// five tiles toward the north origin: file z shrinks => corner x grows
  assert.ok(Math.abs(f32(out,'MCNK',0x6c)-(f32(src,'MCNK',0x6c)+6*T))<1e-2);
  assert.ok(Math.abs(f32(out,'MDDF',8)-(f32(src,'MDDF',8)-6*T))<1e-2);
  assert.ok(Math.abs(f32(out,'MDDF',16)-(f32(src,'MDDF',16)-5*T))<1e-2);
  assert.equal(f32(out,'MDDF',12),50);
  assert.ok(Math.abs(f32(out,'MODF',44)-(f32(src,'MODF',44)-6*T))<1e-2);
  assert.ok(Math.abs(f32(out,'MODF',52)-(f32(src,'MODF',52)-5*T))<1e-2);
  assert.equal(adtHeights(out).mean,adtHeights(src).mean-250);
  assert.notDeepEqual(out,src);assert.ok(f32(src,'MDDF',12)===300);// source untouched
});

const real=()=>({fingerprint:'real',archives:['a'],stats:{},reads:[],
  async read(path){this.reads.push(path);const m=/Kalimdor_(\d+)_(\d+)\.adt$/i.exec(path);
    if(m)return fakeTile(+m[1],+m[2],(x,z)=>300+(+m[1]*T+x)*.05+(+m[2]*T+z)*.02);
    if(/moonglade\\tree\.m2$/i.test(path))return new Uint8Array([7]);
    throw Object.assign(new Error('nf'),{code:'NOT_FOUND'});},close(){}});

test('graft source serves translated Moonglade on its tiles, the procedural moon elsewhere, real files first', async () => {
  const r=real(),s=graftSource(moonSource(),r,{bodyId:'elune',seed:MOON_SEED}),plain=moonSource();
  const t=tilesOf(site)[4],grafted=await s.read(`world/maps/elune/elune_${t.dx}_${t.dy}.adt`);
  assert.deepEqual([...new Set(mcnkAreas(grafted))],[493]);
  const far=await s.read('world/maps/elune/elune_5_5.adt');
  assert.deepEqual(far,await plain.read('world/maps/elune/elune_5_5.adt'));
  assert.deepEqual([...(await s.read('World\\Maps\\Elune\\Elune.wdt'))],[...(await plain.read('World\\Maps\\Elune\\Elune.wdt'))]);
  assert.deepEqual([...await s.read('Creature\\Moonglade\\Tree.m2')],[7]);
  assert.ok((await s.read('Tileset\\Elune\\Regolith.blp')).length>0);// falls through to the moon's own texture
  assert.match(s.fingerprint,/real/);
});

test('the apron meets the graft edge exactly and rejoins the moon at its outer limit', async () => {
  const s=graftSource(moonSource(),real(),{bodyId:'elune',seed:MOON_SEED}),rect=siteRect(site);
  const g=tilesOf(site).find(t=>t.dx===site.dest.x+3-1&&t.dy===site.dest.y);// north-east graft tile
  const apronX=g.dx+1,y=g.dy;// the tile east of it
  const a=await s.read(`world/maps/elune/elune_${apronX}_${y}.adt`),b=await s.read(`world/maps/elune/elune_${g.dx}_${y}.adt`);
  assert.deepEqual([...new Set(mcnkAreas(a))],[90003]);
  // shared edge: west column of the apron tile vs east column of the graft tile, same chart z
  const mcvt=(bytes,cx,cy,i)=>{const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let n=0;for(const c of adtChunks(bytes)){if(c.magic!=='MCNK')continue;
    if(v.getUint32(c.start+4,true)===cx&&v.getUint32(c.start+8,true)===cy){const z=v.getFloat32(c.start+0x70,true);for(const sc of adtChunks(bytes,c.start+128,c.start+c.size))if(sc.magic==='MCVT')return z+v.getFloat32(sc.start+i*4,true);}n++;}};
  for(const cy of [0,5,15])for(const row of [0,4,8])assert.ok(Math.abs(mcvt(a,0,cy,row*17)-mcvt(b,15,cy,row*17+8))<.01,`edge row ${row} chunk ${cy}`);
  assert.ok(rect[2]>0&&Math.abs(outside(site,rect[2]+site.apron,rect[1])-site.apron)<1e-6);
  assert.equal(siteMask(site,rect[2]+site.apron,rect[1]),0);assert.equal(siteMask(site,rect[2]-10,rect[1]+10),1);
  // beyond the apron the tile is the untouched moon
  const farTile=Math.ceil((rect[2]+site.apron)/T)+30+1;
  assert.deepEqual(await s.read(`world/maps/elune/elune_${farTile}_${site.dest.y}.adt`),await moonSource().read(`world/maps/elune/elune_${farTile}_${site.dest.y}.adt`));
});

test('graft mean altitude equals the moon height at the site centre (self-consistent basin)', async () => {
  const bytes=tilesOf(site).map(t=>fakeTile(t.sx,t.sy,(x,z)=>300+x*.05)),grid=heightGrid(site,bytes);
  assert.equal(grid.width,385);
  const rect=siteRect(site);
  assert.ok(Math.abs(sampleGrid(grid,rect,rect[0],rect[1])-grid.data[0])<1e-4);
  assert.ok(Math.abs(sampleGrid(grid,rect,rect[2]+500,rect[3]+500)-grid.data[grid.data.length-1])<1e-4);// clamped onto the edge
  const cx=(rect[0]+rect[2])/2,cz=(rect[1]+rect[3])/2;
  assert.equal(typeof moonHeightChart(MOON_SEED,cx,cz),'number');
});
