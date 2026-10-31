// Ocean-coverage sweep. One command, two modes (see design/ocean.md):
//   node browser/ocean-sweep.mjs [--step 12] [--lag 900] [--height 3] [--stepyd 160]   CPU geometric model, no WoW data; exit 1 on any gap.
//   WOW_DATA=<Data> PORT=<free port, never 4173> node browser/heavy-lock.mjs --label ocean-sweep -- node browser/ocean-sweep.mjs --real [--poses 40] [--seed 1] [--label x]
// Real mode drives the app with the debug colour pass (renderer.debugWater): water stays its colour, sea-floor terrain below sea level is pure red,
// so any red pixel is a tear. Failing poses are listed (and screenshotted under runtime/gate-preview/<label>).
import {mkdir,writeFile} from 'node:fs/promises';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {syntheticScene,syntheticPaths,sweepPath} from './ocean-coverage.js';

const argv=process.argv.slice(2),opt=(k,d)=>{const i=argv.indexOf(`--${k}`);return i<0?d:(typeof d==='number'?+argv[i+1]:argv[i+1]);};

// Minimal PNG reader (8-bit RGB/RGBA, non-interlaced) so no image dependency is needed; counts pure-red debug pixels.
function redPixels(png) {
  const idat=[];let w,h,bpp,p=8;
  while(p<png.length){const len=png.readUInt32BE(p),type=png.toString('latin1',p+4,p+8);
    if(type==='IHDR'){w=png.readUInt32BE(p+8);h=png.readUInt32BE(p+12);bpp=png[p+17]===6?4:3;}
    if(type==='IDAT')idat.push(png.subarray(p+8,p+8+len));p+=12+len;}
  const raw=zlib.inflateSync(Buffer.concat(idat)),stride=w*bpp,img=Buffer.alloc(stride*h);let red=0;
  for(let y=0;y<h;y++){
    const f=raw[y*(stride+1)],row=y*stride;
    for(let i=0;i<stride;i++){
      const x=raw[y*(stride+1)+1+i],a=i>=bpp?img[row+i-bpp]:0,b=y?img[row-stride+i]:0,c=y&&i>=bpp?img[row-stride+i-bpp]:0;
      const pa=Math.abs(b-c),pb=Math.abs(a-c),pc=Math.abs(a+b-2*c);
      img[row+i]=(x+(f===0?0:f===1?a:f===2?b:f===3?(a+b)>>1:(pa<=pb&&pa<=pc?a:pb<=pc?b:c)))&255;
    }
  }
  for(let i=0;i<img.length;i+=bpp)if(img[i]>200&&img[i+1]<40&&img[i+2]<40)red++;
  return red;
}
async function cpu() {
  const t0=Date.now(),scene=syntheticScene({seed:opt('seed',7)}),heights=argv.includes('--height')?[opt('height',3)]:[3,300],lags=[0,opt('lag',900)];
  let poses=0,points=0,gaps=0,flood=0;const bad=[];
  for(const height of heights)for(const lag of lags)for(const path of syntheticPaths())
    for(const p of sweepPath(scene,path,{height,lag,stepYd:opt('stepyd',160),scan:{step:opt('step',12)}})){
      poses++;points+=p.points;gaps+=p.gaps.length+(p.gapsMore||0);flood+=p.flood.length;
      if(p.gaps.length||p.flood.length)bad.push({eye:p.eye.map(Math.round),lag,gaps:p.gaps.slice(0,3),flood:p.flood.slice(0,3)});
    }
  console.log(JSON.stringify({mode:'cpu',poses,points,gaps,flood,failingPoses:bad.length,ms:Date.now()-t0}));
  for(const b of bad.slice(0,20))console.log('FAIL',JSON.stringify(b));
  process.exitCode=bad.length?1:0;
}

async function real() {
  const {chromium}=await import('playwright'),assert=(await import('node:assert/strict')).default;
  assert(process.env.WOW_DATA,'Set WOW_DATA to the read-only local Data directory');
  assert(process.env.PORT&&process.env.PORT!=='4173','Set PORT to a free port (never 4173)');
  const label=opt('label','ocean-sweep');assert(/^[\w-]+$/.test(label));
  const out=new URL(`../runtime/gate-preview/${label}/`,import.meta.url);await mkdir(out,{recursive:true});
  let s=opt('seed',1)>>>0;const rnd=()=>(s=(Math.imul(s,1664525)+1013904223)>>>0)/2**32;
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']}),report={mode:'real',poses:0,failing:[],errors:[]};
  try{
    const page=await (await browser.newContext({viewport:{width:960,height:600},serviceWorkers:'block'})).newPage();
    page.on('pageerror',e=>report.errors.push(e.message));
    await page.goto(`http://127.0.0.1:${process.env.PORT}/?test`);
    await page.waitForFunction(()=>!document.getElementById('select').disabled||worldEvidence.errors.length);
    await page.locator('#files').setInputFiles(process.env.WOW_DATA);
    await page.waitForFunction(()=>worldEvidence.ready||worldEvidence.errors.length,null,{timeout:240000});
    await page.evaluate(()=>{for(const e of document.querySelectorAll('body *'))if(e.tagName!=='CANVAS'&&!e.contains(document.querySelector('canvas')))e.style.visibility='hidden';});
    const [ox,oz,rx,rz]=await page.evaluate(()=>worldEvidence.info.manifest.ocean);
    await page.evaluate(async()=>{worldTest.settings({waves:true,clouds:false,weather:false});worldTest.renderer().debugWater=1;});
    const count=async()=>redPixels(await page.locator('canvas').first().screenshot());
    const n=opt('poses',40);
    for(let i=0;i<n;i++){
      const x=ox+(rx-ox)*rnd(),z=oz+(rz-oz)*rnd(),yaw=rnd()*6.28,height=[3,120,1500][i%3],flight=[x,height,z,yaw,height>100?-.35:-.12];
      await page.evaluate(async f=>{const {SimClock}=await import('./sim-clock.js'),r=worldTest.renderer();r.clock=new SimClock(2083.58,1);r.timeLock=2083.58;worldTest.focus(f);},flight);
      await page.waitForTimeout(opt('settle',4000));
      const red=await count();report.poses++;
      if(red>=30){report.failing.push({flight,red});await page.screenshot({path:fileURLToPath(new URL(`fail-${i}.png`,out))});}
    }
  } finally {await browser.close();await writeFile(new URL('sweep.json',out),JSON.stringify(report,null,2));}
  console.log(JSON.stringify({mode:'real',poses:report.poses,failing:report.failing.length,errors:report.errors.length}));
  for(const f of report.failing)console.log('FAIL',JSON.stringify(f));
  process.exitCode=report.failing.length||report.errors.length?1:0;
}

await (argv.includes('--real')?real():cpu());
