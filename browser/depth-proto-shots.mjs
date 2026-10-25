// On-demand: GPU depth prototype (design/elune.md step B). Serves browser/ on a free port, renders every scenario under three depth
// strategies, compares with the analytic reference, writes PNGs to test-results/depth-proto/. Needs Edge with WebGPU.
// Usage: node browser/depth-proto-shots.mjs  (exit 1 if rev32/split disagree with the reference by more than 0.2% of pixels)
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extname} from 'node:path';
import {scenarios} from './depth-proto-math.js';

const root=new URL('./',import.meta.url),out=new URL('./test-results/depth-proto/',import.meta.url);
await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.html':'text/html'};
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://x').pathname;
  if(path==='/'){res.setHeader('content-type','text/html');return res.end('<canvas id=c width=320 height=200></canvas>');}
  try{const f=await readFile(new URL('.'+path,root));res.setHeader('content-type',mime[extname(path)]||'application/octet-stream');res.end(f);}
  catch{res.statusCode=path==='/favicon.ico'?204:404;res.end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const port=server.address().port;
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio','--use-angle=default','--enable-unsafe-webgpu','--enable-features=Vulkan']});
const results=[];
try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(async()=>{const m=await import('/depth-proto.js');window.proto=await m.createProto();});
  for(const s of scenarios()) for(const mode of ['std24','rev32','split']) {
    const r=await page.evaluate(async([s,mode])=>{
      const c=await window.proto.compare(s,mode),shot=await window.proto.render(s,mode);
      return {...c,png:Array.from(shot.px)};
    },[s,mode]);
    const {png,...rest}=r;results.push(rest);
    await writeFile(new URL(`${s.name}-${mode}.rgba`,out),Buffer.from(png));
    console.log(`${s.name.padEnd(26)} ${mode.padEnd(6)} layers=${rest.layers} mismatch=${(rest.fraction*100).toFixed(3)}%`);
  }
  console.log(JSON.stringify({errors}));
  const worst=Math.max(...results.filter(r=>r.mode!=='std24').map(r=>r.fraction));
  process.exitCode=errors.length||worst>.002?1:0;
}finally{await browser.close();server.close();}
