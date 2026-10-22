import {chromium} from 'playwright';
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const root=path.resolve('..');const srv=http.createServer((q,r)=>{const f=q.url.split('?')[0]==='/pod.json'?path.join(root,'runtime/crash-proto/pod.json'):path.join(root,'tools/crash-proto.html');r.writeHead(200,{'content-type':f.endsWith('json')?'application/json':'text/html'});r.end(fs.readFileSync(f));}).listen(4186,'127.0.0.1');
const b=await chromium.launch({channel:'msedge'});const p=await b.newPage({viewport:{width:900,height:520}});
p.on('pageerror',e=>console.log('ERR',e.message));p.on('console',m=>m.type()==='error'&&console.log('CON',m.text()));
const out=path.join(root,'runtime/crash-proto');const rep=[];
for(const m of ['shatter','parts','crumple','voronoi'])for(const t of [0,.25,.6,1.4]){
 await p.goto(`http://127.0.0.1:4186/?m=${m}&t=${t}`);await p.waitForFunction(()=>window.result,null,{timeout:15000});
 await p.screenshot({path:path.join(out,`${m}-${t}.png`)});if(t===1.4)rep.push(await p.evaluate(()=>window.result));}
console.log(JSON.stringify(rep));await b.close();srv.close();
