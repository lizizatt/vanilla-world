import test from 'node:test';
import assert from 'node:assert/strict';
import {synthAdt,ADT_TILE as T} from './adt-synth.js';
import {adtChunks,mcnkAreas,translateAdt,adtHeights} from './graft-adt.js';
import {graftSource,heightGrid,sampleGrid} from './graft-source.js';
import {moonSource,MOON_SEED} from './moon-source.js';
import {SITES,tilesOf,siteRect,siteMask,siteCentre,domeCentre,domeMask,outside} from './elune-sites.js';
import {reshapeAdt} from './graft-adt.js';
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
  assert.ok(mcnkAreas(grafted).includes(493),'Moonglade chunks inside the circle keep their area');
  const far=await s.read('world/maps/elune/elune_5_5.adt');
  assert.deepEqual(far,await plain.read('world/maps/elune/elune_5_5.adt'));
  assert.deepEqual([...(await s.read('World\\Maps\\Elune\\Elune.wdt'))],[...(await plain.read('World\\Maps\\Elune\\Elune.wdt'))]);
  assert.deepEqual([...await s.read('Creature\\Moonglade\\Tree.m2')],[7]);
  assert.ok((await s.read('Tileset\\Elune\\Regolith.blp')).length>0);// falls through to the moon's own texture
  assert.match(s.fingerprint,/real/);
});

test('each read of a cached graft tile is its own buffer, so transferring one cannot detach the next', async () => {
  const s=graftSource(moonSource(),real(),{bodyId:'elune',seed:MOON_SEED}),  t=tilesOf(site)[4],path=`world/maps/elune/elune_${t.dx}_${t.dy}.adt`;
  const a=await s.read(path),b=await s.read(path);
  assert.notEqual(a.buffer,b.buffer);
  structuredClone(a,{transfer:[a.buffer]});
  assert.ok(b.byteLength>0);assert.ok((await s.read(path)).byteLength>0);
});

test('reshapeAdt re-heights every vertex from its chart position', () => {
  const seen={minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity},src=fakeTile(36,17);
  const out=reshapeAdt(src,{tile:[31,16],cx:30,cy:15,height:(x,z)=>{seen.minX=Math.min(seen.minX,x);seen.maxX=Math.max(seen.maxX,x);seen.minZ=Math.min(seen.minZ,z);seen.maxZ=Math.max(seen.maxZ,z);return 5;}});
  const h=adtHeights(out);assert.equal(h.min,5);assert.equal(h.max,5);
  assert.ok(Math.abs(seen.minX-T)<1e-3&&Math.abs(seen.maxX-2*T)<T/64&&Math.abs(seen.minZ-T)<1e-3&&Math.abs(seen.maxZ-2*T)<T/64);
  assert.equal(out.length,src.length);
});

test('dome: full inside, soft shell, nothing outside or on other bodies; terrain mask shares the footprint', () => {
  const [mx,mz]=domeCentre(site,30,15),{radius,shell}=site.dome;
  assert.equal(domeMask('elune',mx,mz),1);assert.equal(domeMask('elune',mx+radius,mz),1);
  assert.equal(domeMask('elune',mx+radius+shell,mz),0);
  const mid=domeMask('elune',mx+radius+shell/2,mz);assert.ok(mid>.4&&mid<.6);
  assert.ok(domeMask('elune',mx,mz,30,15,radius+shell/2)<.6,'it is a sphere: high altitude leaves it');
  assert.equal(domeMask('azeroth',mx,mz),0);
  assert.ok(radius<=siteRect(site)[2]-siteRect(site)[0]);
  assert.equal(siteMask(site,mx+radius,mz),1);assert.equal(siteMask(site,mx,mz+radius+1),0);
});

const mtex=b=>{for(const c of adtChunks(b))if(c.magic==='MTEX')return new TextDecoder().decode(b.subarray(c.start,c.start+c.size)).split('\0').filter(Boolean);};
const chunkInfo=b=>{const v=new DataView(b.buffer,b.byteOffset,b.byteLength),out=new Map();for(const c of adtChunks(b)){if(c.magic!=='MCNK')continue;
  let tex=null;for(const sc of adtChunks(b,c.start+128,c.start+c.size))if(sc.magic==='MCLY')tex=v.getUint32(sc.start,true);
  out.set(v.getUint32(c.start+8,true)*16+v.getUint32(c.start+4,true),{area:v.getUint32(c.start+0x34,true),tex});}return out;};

test('the graft ends exactly at the dome circle: chunk ground, texture and area switch to regolith, nothing outside is Moonglade', async () => {
  const s=graftSource(moonSource(),real(),{bodyId:'elune',seed:MOON_SEED}),[mx,mz]=domeCentre(site,30,15),{radius}=site.dome;
  let inside=0,outsideChunks=0;
  for(const t of tilesOf(site)) {
    const b=await s.read(`world/maps/elune/elune_${t.dx}_${t.dy}.adt`),tex=mtex(b),info=chunkInfo(b);
    for(const [k,c] of info) {
      const x=(t.dx-30)*T+((k%16)+.5)*T/16,z=(t.dy-15)*T+(Math.floor(k/16)+.5)*T/16,inCircle=Math.hypot(x-mx,z-mz)<=radius;
      if(inCircle){inside++;assert.equal(c.area,493);assert.match(tex[c.tex],/Grass/);}
      else{outsideChunks++;assert.equal(c.area,90001,'outside the circle is the moon');assert.equal(tex[c.tex],'Tileset\\Elune\\Regolith.blp');}
    }
  }
  assert.ok(inside>20&&outsideChunks>20,'the circle cuts through the graft block');
  // a tile entirely outside the circle is the untouched procedural tile
  const rect=siteRect(site),far=tilesOf(site).find(t=>Math.hypot((t.dx-30+.5)*T-mx,(t.dy-15+.5)*T-mz)>radius+T);
  if(far)assert.deepEqual(await s.read(`world/maps/elune/elune_${far.dx}_${far.dy}.adt`),await moonSource().read(`world/maps/elune/elune_${far.dx}_${far.dy}.adt`));
  assert.ok(rect[2]>0);
  assert.equal(siteMask(site,mx+radius,mz),1);assert.equal(siteMask(site,mx+radius+.01,mz),0,'hard edge, no ease band');
});

test('the circle cuts the minimap too: inside real, outside regolith, straddling tiles masked per block', async () => {
  const {graftMinimapRows,maskedHash,REGOLITH_HASH}=await import('./graft-source.js'),{maskMinimap}=await import('./graft-adt.js'),{regolithBlp}=await import('./moon-source.js');
  const hash='0123456789abcdef0123456789abcdef.blp',lines=tilesOf(site).map(t=>`Kalimdor\\map${t.sx}_${t.sy}.blp\t${hash}`).join('\n')+'\n';
  const rows=new TextDecoder().decode(graftMinimapRows(new TextEncoder().encode(lines),[site],'Elune'));
  const kinds=new Set(tilesOf(site).map(t=>{const row=rows.split('\n').find(l=>l.startsWith(`Elune\\map${t.dx}_${t.dy}.blp`));return row.endsWith(hash)?'in':row.endsWith(REGOLITH_HASH)?'out':row.includes(maskedHash(t.dx,t.dy))?'cut':'?';}));
  assert.ok(kinds.has('cut')&&!kinds.has('?'));
  const dxt=new Uint8Array(148+32768),v=new DataView(dxt.buffer);dxt.set([0x42,0x4c,0x50,0x32]);v.setUint32(4,1,true);dxt[8]=2;v.setUint32(12,256,true);v.setUint32(16,256,true);v.setUint32(20,148,true);v.setUint32(84,32768,true);
  for(let i=0;i<4096;i++)v.setUint16(148+i*8,0x07e0,true);
  const out=maskMinimap(dxt,(u)=>u<.5),ov=new DataView(out.buffer);
  assert.equal(ov.getUint16(148,true),0x07e0);assert.notEqual(ov.getUint16(148+63*8,true),0x07e0);
  assert.equal(regolithBlp().length>0,true);
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

test('reshapeAdt keep() culls MDDF/MODF placements outside the footprint by invalidating their name index', () => {
  const T=533.3333333,cx=30,cy=15,tx=31,ty=16;
  const place=(len,x,z)=>{const b=new Uint8Array(len),v=new DataView(b.buffer);v.setUint32(0,7,true);v.setFloat32(8,x,true);v.setFloat32(16,z,true);return b;};
  const cat=(...a)=>{const o=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let p=0;for(const x of a){o.set(x,p);p+=x.length;}return o;};
  const bytes=cat(chunk('MDDF',cat(place(36,tx*T+10,ty*T+10),place(36,tx*T+400,ty*T+400))),chunk('MODF',cat(place(64,tx*T+10,ty*T+10),place(64,tx*T+400,ty*T+400))));
  const out=reshapeAdt(bytes,{tile:[tx,ty],cx,cy,height:h=>h,keep:(x,z)=>x<T+100&&z<T+100});
  const ids=[...adtChunks(out)].flatMap(c=>{const len=c.magic==='MDDF'?36:64,v=new DataView(out.buffer,out.byteOffset,out.byteLength);return [0,1].map(i=>v.getUint32(c.start+i*len,true));});
  assert.deepEqual(ids,[7,0xffffffff,7,0xffffffff]);
  assert.equal(out.length,bytes.length);
});

test('procedural moon textures are regolith, never the demo green checker (plain and via the graft source)', async () => {
  const {demoBlp}=await import('./demo-source.js');
  const tex='world/../tileset\\elune\\regolith.blp'.replace('world/../','');
  const plain=moonSource(),grafted=graftSource(moonSource(),real(),{bodyId:'elune',seed:MOON_SEED});
  const demo=Buffer.from(demoBlp());
  for(const s of [plain,grafted]) {
    const ground=Buffer.from(await s.read(tex)),mini=Buffer.from(await s.read('textures/minimap/elune/map10_10.blp'));
    assert.ok(!ground.equals(demo)&&!mini.equals(demo));
    const pal=i=>[ground[148+i*4+2],ground[148+i*4+1],ground[148+i*4]];
    const used=new Set(ground.subarray(1172));
    assert.ok(used.size>8,'mottled, not flat');
    for(const i of used){const [r,g,b]=pal(i);assert.ok(r>=g&&g>=b&&r-b<40&&r>60,`shade ${i} not grey-tan: ${r},${g},${b}`);}
  }
});
