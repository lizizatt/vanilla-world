import test from 'node:test';
import assert from 'node:assert/strict';
import {SETTLEMENTS,DEMO_SETTLEMENTS,PALETTES,FIRE,NIGHT_W,NIGHT_H,FLAG_ARCANE,FLAG_EERIE,settlementPositions,settlementLights,bakeNightLights,nightLightsWgsl} from './night-lights.js';
import {spaceShader,patchShader,subPoint} from './space.js';

const manifest={world_bounds:[[0,0,0,0],[0,0,0,0]],regions:[
  {map:'Kalimdor',placement:[-5000,-3000],tile_origin:[0,0]},{map:'Azeroth',placement:[9000,1000],tile_origin:[0,0]}]};
const texel=(out,s,w=NIGHT_W,h=NIGHT_H)=>{
  const {lat,lon}=subPoint(...s.pos),x=Math.floor((lon/(2*Math.PI)+.5)*w),y=Math.floor((.5-lat/Math.PI)*h),i=(y*w+x)*4;
  return [...out.slice(i,i+4)];
};

test('table is well formed with unique ids and the two special cities', () => {
  assert.equal(new Set(SETTLEMENTS.map(s=>s.id)).size,SETTLEMENTS.length);
  for(const s of SETTLEMENTS){assert.ok(['Kalimdor','Azeroth'].includes(s.map));assert.ok(s.size>=1&&s.size<=5);assert.equal(s.wow.length,2);}
  assert.equal(SETTLEMENTS.find(s=>s.id==='dalaran').palette,'dalaran');
  assert.equal(SETTLEMENTS.find(s=>s.id==='karazhan').palette,'karazhan');
  assert.ok(PALETTES.dalaran.colours.length>=3&&PALETTES.karazhan.colours.length>=3);
});

test('positions follow manifest region offsets; demo world falls back to rect fractions', () => {
  const rects=[[-1e5,-1e5,1e5,1e5]],real=settlementPositions(manifest,rects),demo=settlementPositions(undefined);
  assert.equal(real.length,SETTLEMENTS.length);
  assert.equal(settlementPositions(manifest,[[0,0,100,100]]).length,DEMO_SETTLEMENTS.length,'tiny demo island gets demo settlements');
  assert.equal(demo.length,DEMO_SETTLEMENTS.length);
  const org=real.find(s=>s.id==='orgrimmar'),kx=-5000+32*1600/3,kz=-3000+32*1600/3;
  assert.ok(Math.abs(org.pos[0]-(4400+kx))<1e-6&&Math.abs(org.pos[1]-(-1500+kz))<1e-6);
  assert.ok(demo.some(s=>s.palette==='dalaran'));
});

test('bake: fire cities glow warm, scaled by size; Dalaran/Karazhan are multi-colour and flagged', () => {
  const real=settlementPositions(manifest,[[-1e5,-1e5,1e5,1e5]]),out=bakeNightLights(real);
  assert.equal(out.length,NIGHT_W*NIGHT_H*4);
  const big=texel(out,real.find(s=>s.id==='orgrimmar')),small=texel(out,real.find(s=>s.id==='freewind-post'));
  assert.ok(big[0]>small[0]&&big[0]>80,`${big} vs ${small}`);
  assert.ok(big[0]>big[1]&&big[1]>big[2]&&big[3]===0,'warm firelight, no flag');
  const hue=id=>{const l=settlementLights(real.find(s=>s.id===id));return new Set(l.map(p=>p.rgb.join())).size;};
  assert.ok(hue('dalaran')>=3&&hue('karazhan')>=3);
  assert.ok(settlementLights(real.find(s=>s.id==='orgrimmar')).every(p=>p.rgb[0]>=p.rgb[2]),'default lights never go blue');
  const flags=id=>Math.max(...settlementLights(real.find(s=>s.id===id)).map(p=>p.flag));
  assert.equal(flags('dalaran'),FLAG_ARCANE);assert.equal(flags('karazhan'),FLAG_EERIE);assert.equal(flags('orgrimmar'),0);
  assert.deepEqual(FIRE.map(c=>c>0),[true,true,true]);
});

test('shader inputs: both globe shaders bind and call the lights texture', () => {
  for(const src of [spaceShader,patchShader]){
    assert.ok(src.includes('@binding(4) var lightsTex'));
    assert.ok(src.includes(nightLightsWgsl)&&src.includes('lightsAt('));
  }
});
