// On-demand: loads ?body=elune headless (needs browser/pkg with moon_manifest), waits for the world, drives, screenshots.
// Usage: node browser/elune-smoke.mjs  -> test-results/elune/*.png; exit 1 on page errors.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {extname} from 'node:path';

const root=new URL('./',import.meta.url),out=new URL('./test-results/elune/',import.meta.url);
await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.wasm':'application/wasm','.css':'text/css','.json':'application/json'};
const server=createServer(async(req,res)=>{
  let path=new URL(req.url,'http://x').pathname;if(path==='/')path='/index.html';
  try{const f=await readFile(new URL('.'+path,root));res.setHeader('content-type',mime[extname(path)]||'application/octet-stream');res.end(f);}
  catch{res.statusCode=404;res.end();}
}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const port=server.address().port;
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio','--enable-unsafe-webgpu','--use-angle=default','--enable-features=Vulkan']});
const errors=[];
try{
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?body=elune&test`);
  await page.waitForFunction(()=>document.getElementById('status')&&!document.getElementById('error').hidden||window.worldTest,null,{timeout:60000}).catch(()=>{});
  await page.waitForTimeout(8000);
  await writeFile(new URL('idle.png',out),await page.screenshot());
  await page.keyboard.down('w');await page.waitForTimeout(4000);await page.keyboard.up('w');
  await writeFile(new URL('driven.png',out),await page.screenshot());
  console.log('error panel:',await page.evaluate(()=>document.getElementById('error').textContent));
}finally{await browser.close();server.close();}
console.log('errors:',errors);
process.exit(errors.length?1:0);
