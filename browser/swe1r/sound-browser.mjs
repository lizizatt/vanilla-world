// Local sound browser: lists/plays every wav under the Racer install's wavs\ folder (22K, 11K, Music, Voice). Nothing is copied or saved.
//   $env:SWE1R_DATA='...\Star Wars Episode I Racer\data'; node swe1r/sound-browser.mjs   ->  http://127.0.0.1:4185/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const data = process.env.SWE1R_DATA, root = data && [path.join(data, 'wavs'), path.join(data, 'data', 'wavs')].find(d => fs.existsSync(d));
if (!root) { console.error('Set SWE1R_DATA to the Racer data folder (the one containing wavs\\).'); process.exit(1); }

const list = fs.readdirSync(root, { recursive: true }).filter(f => /\.wav$/i.test(f)).map(f => {
  const b = fs.readFileSync(path.join(root, f)), rate = b.readUInt32LE(28);
  return { id: f.replace(/\\/g, '/'), dur: rate ? +((b.length - 44) / rate).toFixed(2) : 0, mb: +(b.length / 1048576).toFixed(2) };
}).sort((a, b) => a.id.localeCompare(b.id));

const page = `<!doctype html><meta charset=utf-8><title>Racer sounds</title>
<style>body{font:14px sans-serif;background:#161616;color:#ddd;margin:0;display:flex;flex-direction:column;height:100vh}
#bar{padding:8px;border-bottom:1px solid #333;display:flex;gap:12px;align-items:center}#list{overflow:auto;flex:1}
.row{padding:3px 10px;cursor:pointer;display:flex;gap:12px}.row.cur{background:#335}.row b{margin-left:auto;font-weight:normal;color:#999}</style>
<div id=bar><input id=q placeholder="filter (e.g. music, crash, voice/ra)" size=34><label><input type=checkbox id=auto> autoplay next</label>
<span id=now></span><span>space play/pause, n/p next/prev</span></div><div id=list></div>
<script>
var items=[],view=[],at=0,a=new Audio();function $(i){return document.getElementById(i)}
function draw(){$('list').innerHTML='';view.forEach(function(x,i){var d=document.createElement('div');d.className='row'+(i===at?' cur':'');
 d.innerHTML='<span>'+x.id+'</span><b>'+x.dur+'s / '+x.mb+' MB</b>';d.onclick=function(){at=i;play()};$('list').appendChild(d)});
 var e=$('list').children[at];if(e)e.scrollIntoView({block:'nearest'});$('now').textContent=view[at]?view[at].id:'';}
function play(){if(!view[at])return;a.src='/wav/'+view[at].id;a.play();draw()}
function go(d){at=Math.max(0,Math.min(view.length-1,at+d));play()}
function filt(){var q=$('q').value.toLowerCase();view=items.filter(function(x){return x.id.toLowerCase().indexOf(q)>=0});at=0;draw()}
a.onended=function(){if($('auto').checked)go(1)};$('q').oninput=filt;
document.addEventListener('keydown',function(e){if(e.target.id==='q')return;if(e.key===' '){e.preventDefault();a.paused?a.play():a.pause()}else if(e.key==='n')go(1);else if(e.key==='p')go(-1)});
fetch('/list').then(function(r){return r.json()}).then(function(l){items=l;filt()});
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), send = (c, b, t = 'text/plain') => { res.writeHead(c, { 'content-type': t }); res.end(b); };
  if (url.pathname === '/') return send(200, page, 'text/html');
  if (url.pathname === '/list') return send(200, JSON.stringify(list), 'application/json');
  const id = decodeURIComponent(url.pathname.slice(5));
  if (url.pathname.startsWith('/wav/') && list.some(x => x.id === id)) return send(200, fs.readFileSync(path.join(root, id)), 'audio/wav');
  send(404, 'not found');
}).listen(4185, '127.0.0.1', () => console.log(`${list.length} wavs under ${root}\nOpen http://127.0.0.1:4185/`));
