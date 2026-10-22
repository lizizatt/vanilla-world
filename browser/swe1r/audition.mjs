// Local voice-line audition/tagging tool. Serves a page on 127.0.0.1 that plays the wavs from your own SWE1R install and saves
// your tags to runtime/voice-tags.json (git-ignored). Export writes browser/swe1r/voice-map.json: event -> ids only, no audio.
//   $env:SWE1R_DATA='...\Star Wars Episode I Racer\data'; node swe1r/audition.mjs   ->  http://127.0.0.1:4184/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMap, EVENTS } from './voice-map.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = process.env.SWE1R_DATA;
if (!data) { console.error('Set SWE1R_DATA to the Racer data folder (the one containing wavs\\).'); process.exit(1); }
const voiceDir = ['22K', '11K'].map(r => path.join(data, 'wavs', r, 'Voice')).concat([22, 11].map(r => path.join(data, 'data', 'wavs', `${r}K`, 'Voice'))).find(d => fs.existsSync(d));
if (!voiceDir) { console.error('No wavs\\22K\\Voice folder under', data); process.exit(1); }
const tagFile = path.resolve(here, '..', '..', 'runtime', 'voice-tags.json'), mapFile = path.join(here, 'voice-map.json');
fs.mkdirSync(path.dirname(tagFile), { recursive: true });
const readTags = () => { try { return JSON.parse(fs.readFileSync(tagFile, 'utf8')); } catch { return {}; } };

function duration(file) {
  const b = fs.readFileSync(file);
  return b.length > 44 && b.readUInt32LE(28) ? +((b.length - 44) / b.readUInt32LE(28)).toFixed(2) : 0;
}
const list = fs.readdirSync(voiceDir).filter(f => /\.wav$/i.test(f)).sort().map(f => ({ id: f.slice(0, -4), dur: duration(path.join(voiceDir, f)) }));

const page = `<!doctype html><meta charset=utf-8><title>Voice audition</title>
<style>body{font:14px sans-serif;background:#161616;color:#ddd;margin:0;display:grid;grid-template-columns:280px 1fr;height:100vh}
#side{padding:10px;overflow:auto;border-right:1px solid #333}#list{overflow:auto}
.row{padding:3px 8px;cursor:pointer;display:flex;gap:8px}.row.cur{background:#335}.row .t{color:#8f8;margin-left:auto}.row.u .t{display:none}
button,select,input{font:inherit}kbd{background:#333;padding:0 4px;border-radius:3px}#tags button{display:block;margin:2px 0;width:100%;text-align:left}
#tags button.on{background:#264}#now{font-size:20px;margin:8px 0}</style>
<div id=side><div id=now>-</div><label>Prefix <input id=pre size=8 placeholder="ra, rali, raac, mgsp"></label>
<label><input type=checkbox id=unt> untagged only</label><label><input type=checkbox id=auto checked> autoplay next</label>
<p><kbd>space</kbd> play/pause &nbsp;<kbd>n</kbd>/<kbd>p</kbd> next/prev &nbsp;<kbd>1-9</kbd> assign tag from the list (most recent first) &nbsp;<kbd>0</kbd> clear &nbsp;<kbd>r</kbd> replay</p>
<div id=tags></div><p><button id=exp>Export voice-map.json</button> <span id=msg></span></p><div id=count></div></div><div id=list></div>
<script>
var EVENTS=${JSON.stringify(EVENTS)},items=[],tags={},recent=[],view=[],at=0,audio=new Audio();
function $(i){return document.getElementById(i)}
function save(){fetch('/tags',{method:'POST',body:JSON.stringify(tags)})}
function apply(){var p=$('pre').value.toLowerCase(),u=$('unt').checked;
  view=items.filter(function(x){return x.id.toLowerCase().indexOf(p)===0&&(!u||!tags[x.id])});
  if(at>=view.length)at=Math.max(0,view.length-1);draw()}
function order(){var seen={},out=[];recent.concat(EVENTS).forEach(function(e){if(!seen[e]){seen[e]=1;out.push(e)}});return out}
function draw(){
  $('list').innerHTML='';view.forEach(function(x,i){var d=document.createElement('div');d.className='row'+(i===at?' cur':'')+(tags[x.id]?'':' u');
    d.innerHTML=x.id+' <span>'+x.dur+'s</span><span class=t>'+(tags[x.id]||'')+'</span>';d.onclick=function(){at=i;play()};$('list').appendChild(d)});
  var cur=view[at];$('now').textContent=cur?cur.id+'  ('+cur.dur+'s)  '+(tags[cur.id]||'untagged'):'-';
  $('tags').innerHTML='';order().forEach(function(e,i){var b=document.createElement('button');b.textContent=(i<9?(i+1)+'  ':'   ')+e;if(cur&&tags[cur.id]===e)b.className='on';
    b.onclick=function(){tag(e)};$('tags').appendChild(b)});
  var n=Object.keys(tags).length;$('count').textContent=n+' tagged / '+items.length+' ('+view.length+' shown)';
  var el=$('list').children[at];if(el)el.scrollIntoView({block:'nearest'})}
function play(){var cur=view[at];if(!cur)return;audio.src='/wav/'+cur.id;audio.play();draw()}
function tag(e){var cur=view[at];if(!cur)return;if(e===null)delete tags[cur.id];else{tags[cur.id]=e;recent=[e].concat(recent.filter(function(r){return r!==e}))}save();draw()}
function go(d){at=Math.max(0,Math.min(view.length-1,at+d));play()}
audio.onended=function(){if($('auto').checked&&!$('unt').checked&&at<view.length-1)go(1)};
document.addEventListener('keydown',function(ev){if(ev.target.tagName==='INPUT'&&ev.target.type==='text'&&ev.key!=='Escape')return;
  if(ev.key===' '){ev.preventDefault();audio.paused?audio.play():audio.pause()}
  else if(ev.key==='n'||ev.key==='j')go(1);else if(ev.key==='p'||ev.key==='k')go(-1);else if(ev.key==='r')play();
  else if(ev.key==='0')tag(null);else if(/^[1-9]$/.test(ev.key)){var e=order()[+ev.key-1];if(e){tag(e);if($('auto').checked)go(1)}}});
$('pre').oninput=function(){at=0;apply()};$('unt').onchange=function(){at=0;apply()};
$('exp').onclick=function(){fetch('/export',{method:'POST'}).then(function(r){return r.text()}).then(function(t){$('msg').textContent=t})};
Promise.all([fetch('/list').then(function(r){return r.json()}),fetch('/tags').then(function(r){return r.json()})]).then(function(r){items=r[0];tags=r[1];apply()});
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/') return send(200, page, 'text/html');
  if (url.pathname === '/list') return send(200, JSON.stringify(list), 'application/json');
  if (url.pathname === '/tags' && req.method === 'GET') return send(200, JSON.stringify(readTags()), 'application/json');
  if (url.pathname === '/tags') { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { try { fs.writeFileSync(tagFile, JSON.stringify(JSON.parse(body), null, 1)); send(200, 'ok'); } catch { send(400, 'bad'); } }); return; }
  if (url.pathname === '/export' && req.method === 'POST') {
    const map = buildMap(readTags());
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 1) + '\n');
    return send(200, `Wrote ${Object.values(map).flat().length} ids to browser/swe1r/voice-map.json`);
  }
  const m = /^\/wav\/([\w-]+)$/.exec(url.pathname);
  if (m && list.some(x => x.id === m[1])) return send(200, fs.readFileSync(path.join(voiceDir, `${m[1]}.wav`)), 'audio/wav');
  send(404, 'not found');
}).listen(4184, '127.0.0.1', () => console.log(`${list.length} voice lines from ${voiceDir}\nOpen http://127.0.0.1:4184/`));
