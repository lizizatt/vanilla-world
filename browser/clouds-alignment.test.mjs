import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {maelstromCentre,MAELSTROM_MAP} from './clouds.js';
import {worldAt} from './cloud-march.js';
import {planetFactors} from './terrain-transition.js';
import {bendRel,subPoint,PLANET_RADIUS as R,WORLD_CENTRE,FALLBACK_RECTS,MAELSTROM_Z,MAELSTROM_LAT} from './space.js';

const manifest={ocean:[5333.333,-16000,13525.333,17066.667],world_bounds:[[0,0,51,56],[24,20,45,62]],regions:[{placement:[-21866.667,-7466.667]},{placement:[725.333,-16000]}]};
const deg=r=>r*180/Math.PI;

// Ground truth from the user's world map (800x533): land x 95-300 (Kalimdor) and 535-720 (EK), the spiral centre at (405,265).
const MAP={kalimdor:{x:[95,300],y:[100,455]},east:{x:[535,720],y:[45,445]},spiral:[405,265]};

test('Maelstrom centre matches the world map: horizontal fraction between the continents', () => {
  const c=maelstromCentre(manifest),[kal,east]=FALLBACK_RECTS;
  const mapAcross=(MAP.spiral[0]-MAP.kalimdor.x[1])/(MAP.east.x[0]-MAP.kalimdor.x[1]);
  const ourAcross=(c[0]-kal[2])/(east[0]-kal[2]);
  assert.ok(Math.abs(ourAcross-mapAcross)<.03,`across ours ${ourAcross.toFixed(3)} map ${mapAcross.toFixed(3)}`);
  assert.ok(Math.abs(c[0]-(kal[2]+mapAcross*(east[0]-kal[2])))<400,`x ${c[0]}`);
  assert.equal(MAELSTROM_MAP.across,.43);
});

test('Maelstrom centre vertical position stays within the map-derived band and at lat 20', () => {
  const c=maelstromCentre(manifest),[kal,east]=FALLBACK_RECTS;
  const fk=(MAP.spiral[1]-MAP.kalimdor.y[0])/(MAP.kalimdor.y[1]-MAP.kalimdor.y[0]),fe=(MAP.spiral[1]-MAP.east.y[0])/(MAP.east.y[1]-MAP.east.y[0]);
  const mapZ=(kal[1]+fk*(kal[3]-kal[1])+east[1]+fe*(east[3]-east[1]))/2,sp=subPoint(...c);
  assert.ok(Math.abs(c[1]-MAELSTROM_Z)<2);
  assert.ok(Math.abs(deg(sp.lat)-MAELSTROM_LAT)<.01);
  // The map is not to scale between continents, so this is a loose band (about 4.3 degrees of latitude today).
  assert.ok(Math.abs(c[1]-mapZ)<4500,`z ours ${c[1]} map ${Math.round(mapZ)}`);
});

test('every layer takes the Maelstrom centre from maelstromCentre()', () => {
  for(const f of ['clouds.js','ocean-mesh.js','world-engine.js','renderer-events.js','camera-collision.js','map-panel.js','app-hud.js']) {
    assert.match(readFileSync(new URL(f,import.meta.url),'utf8'),/maelstromCentre/,f);
  }
  const water=readFileSync(new URL('water-shader.js',import.meta.url),'utf8');
  assert.ok(!/MAELSTROM_Z|3507/.test(water));
  assert.match(readFileSync(new URL('renderer-events.js',import.meta.url),'utf8'),/whirlpool:manifest\.world_bounds&&maelstromCentre\(manifest\)/);
});

const wrapX=dx=>{const turn=2*Math.PI*R;return ((dx+turn/2)%turn+turn)%turn-turn/2;};
// Orbit ring: eyes on a ring of longitudes/latitudes at several altitudes, looking at landmarks placed by the terrain's own bend mapping.
const eyes=[];
for(const lat of [-60,-20,0,20,45,70])for(const lonDeg of [-120,-60,0,40,120,170])for(const alt of [5000,20000,60000,150000])eyes.push([WORLD_CENTRE[0]+R*lonDeg*Math.PI/180,alt,WORLD_CENTRE[1]-R*lat*Math.PI/180]);
const maelstrom=maelstromCentre(manifest);
const landmarks=[maelstrom,[(FALLBACK_RECTS[0][0]+FALLBACK_RECTS[0][2])/2,(FALLBACK_RECTS[0][1]+FALLBACK_RECTS[0][3])/2],[(FALLBACK_RECTS[1][0]+FALLBACK_RECTS[1][2])/2,(FALLBACK_RECTS[1][1]+FALLBACK_RECTS[1][3])/2],[FALLBACK_RECTS[0][0],FALLBACK_RECTS[0][1]],[FALLBACK_RECTS[1][2],FALLBACK_RECTS[1][3]]];

test('clouds map a surface landmark back to its own flat position from any orbit camera (offset ~0 at globe altitudes)', () => {
  let worst=0;
  for(const eye of eyes)for(const lm of landmarks) {
    const flat=[wrapX(lm[0]-eye[0]),-eye[1],lm[1]-eye[2]];
    if(Math.hypot(flat[0],flat[2])>R*1.2)continue;
    const rel=bendRel(flat,eye,1),w=worldAt(eye,rel),dx=wrapX(w[0]-lm[0]),dz=w[2]-lm[1];
    worst=Math.max(worst,Math.hypot(dx,dz));
    assert.ok(Math.hypot(dx,dz)<2,`eye ${eye.map(Math.round)} landmark ${lm.map(Math.round)} offset ${dx.toFixed(1)},${dz.toFixed(1)}`);
    assert.ok(Math.abs(w[1])<1,`height ${w[1]}`);
  }
  assert.ok(worst<2);
});

test('cloud height above the globe is the true radial altitude (shell concentric with the globe)', () => {
  for(const eye of eyes.filter((e,i)=>i%7===0))for(const alt of [900,3000,8000]) {
    const flat=[4000,alt-eye[1],-6000],rel=bendRel(flat,eye,1),w=worldAt(eye,rel);
    assert.ok(Math.abs(w[1]-alt)<.5,`alt ${alt} got ${w[1]}`);
  }
});

test('near the ground the cloud mapping blends to the flat terrain frame (landmark offset bounded and 0 at both ends)', () => {
  const lat=20;
  for(const alt of [20,100,150,400,800,1200,1500,3000]) {
    const bend=planetFactors(alt).bend,eye=[WORLD_CENTRE[0]+3000,alt,WORLD_CENTRE[1]-R*lat*Math.PI/180];
    for(const d of [[30000,0],[0,-30000],[-20000,20000],[40000,-40000]]) {
      const flat=[d[0],0,d[1]],rel=bendRel(flat,eye,bend),w=worldAt(eye,rel),err=Math.hypot(w[0]-eye[0]-d[0],w[2]-eye[2]-d[1]);
      // exact at bend 0 (flat) and 1 (globe); in between the shell uses its own effective radius, so measured worst about 11% of range at 56 km, 800 yd
      const tol=bend>=1?2:bend<=0?.006*Math.hypot(...d):.12*Math.hypot(...d);
      assert.ok(err<tol,`alt ${alt} bend ${bend.toFixed(3)} d ${d} err ${err.toFixed(0)}`);
    }
  }
});

test('Maelstrom eye stays put as the camera orbits (time and cloud tier do not move the centre)', () => {
  const eye0=null;
  void eye0;
  const centre=maelstrom;
  for(const eye of eyes) {
    const flat=[wrapX(centre[0]-eye[0]),-eye[1],centre[1]-eye[2]];
    if(Math.hypot(flat[0],flat[2])>R)continue;
    const w=worldAt(eye,bendRel(flat,eye,1));
    assert.ok(Math.hypot(wrapX(w[0]-centre[0]),w[2]-centre[1])<2);
    assert.ok(Math.abs(deg(subPoint(w[0],w[2]).lat)-MAELSTROM_LAT)<.01);
  }
  // centre is a pure function of the manifest: no clock or tier input exists
  assert.deepEqual(maelstromCentre(manifest),maelstromCentre(JSON.parse(JSON.stringify(manifest))));
});

test('storm centre offsets wrap to the nearest turn, so the vortex and funnel stay pinned from any longitude (body-fixed frame)', async () => {
  const {cloudShader}=await import('./clouds.js');
  const src=typeof cloudShader==='string'?cloudShader:String(cloudShader);
  assert.ok(!/pos\.xz-c\.cloud\.xy/.test(src),'raw unwrapped storm offset left in the shader');
  assert.equal((src.match(/stormOffset\(pos\.xz\)/g)||[]).length,2);
  assert.ok(src.includes((2*Math.PI*R).toFixed(1)));
  const [mx,mz]=maelstrom;
  for(const eye of eyes) {
    const flat=[wrapX(mx-eye[0]),-eye[1],mz-eye[2]];
    if(Math.hypot(flat[0],flat[2])>R*1.2)continue;
    const w=worldAt(eye,bendRel(flat,eye,1)),turn=2*Math.PI*R,d=w[0]-mx,off=d-turn*Math.round(d/turn);
    assert.ok(Math.hypot(off,w[2]-mz)<2,`eye ${eye.map(Math.round)} wrapped offset ${off}`);
  }
});

test('cloud uniform frame (storm centre, east/up/south basis, lon/lat origin) is body-fixed: independent of sim time and cloud clock, and equals the globe planetFrame', async () => {
  const {cloudUniform}=await import('./clouds.js');
  const {planetFrame}=await import('./space.js');
  const mk=eye=>({eye,right:[1,0,0],up:[0,1,0],look:[0,0,-1],aspect:1.7});
  for(const eye of [[-5452.9987,21105.157,9655.307],[WORLD_CENTRE[0]+R*Math.PI,21105,9655],[WORLD_CENTRE[0]-R*2,60000,-9000]]) {
    const a=cloudUniform(mk(eye),10,1,manifest,1,null,undefined,1440),b=cloudUniform(mk(eye),3.9e6,.2,manifest,1,null,undefined,300),f=planetFrame(eye[0],eye[2]);
    assert.deepEqual([...a.slice(16,18)],[...b.slice(16,18)]);
    assert.deepEqual([...a.slice(48,60)],[...b.slice(48,60)]);
    assert.deepEqual([...a.slice(48,60)],[...f.east,WORLD_CENTRE[0],...f.up,WORLD_CENTRE[1],...f.south,R].map(Math.fround));
  }
});
