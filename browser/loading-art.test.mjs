import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadingScreen,loadLoadingArt,LoadingArt} from './loading-art.js';

export function screenDbc() {
  const strings=new TextEncoder().encode('\0Kalimdor\0Interface\\Glues\\LoadingScreens\\one.blp\0Azeroth\0Interface\\Glues\\LoadingScreens\\two.blp\0');
  const bytes=new Uint8Array(44+strings.length),view=new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('WDBC'));
  [2,3,12,strings.length,3,1,10,4,54,62].forEach((n,i)=>view.setUint32(4+i*4,n,true));
  // Compute offsets independently of path lengths.
  const text=new TextDecoder().decode(strings);
  view.setUint32(36,text.indexOf('Azeroth'),true);view.setUint32(40,text.indexOf('Interface',11),true);
  bytes.set(strings,44);return bytes;
}
test('loading screen uses the authored continent row or a DBC default, with strict bounds',()=>{
  const bytes=screenDbc();
  assert.equal(loadingScreen(bytes).name,'Kalimdor');
  assert.equal(loadingScreen(bytes,'azeroth').path,'Interface\\Glues\\LoadingScreens\\two.blp');
  for(const offset of [4,8,12,16,24,28]){
    const bad=bytes.slice();new DataView(bad.buffer).setUint32(offset,0xffffffff,true);
    assert.throws(()=>loadingScreen(bad),/DBC|bounds/);
  }
  assert.throws(()=>loadingScreen(bytes.subarray(0,-1)),/DBC/);
});
const decode=()=>({width:1,height:1,rgba:new Uint8Array([50,80,120,255])});
test('DBC is the first read; artwork is optional, preemptible and retries deferred extraction',async()=>{
  const reads=[],events=[];let deferred=false;
  const source={read:async(path,options)=>{
    reads.push({path,options});
    if(path.endsWith('.dbc'))return screenDbc();
    assert(options.background);assert.equal(options.shouldDefer(),false);
    if(!deferred){deferred=true;throw Object.assign(Error('required world read'),{code:'DEFERRED'});}
    return new Uint8Array([1]);
  }};
  await loadLoadingArt(source,decode,e=>events.push(e),()=>false,'Azeroth');
  assert.equal(reads[0].path,'DBFilesClient\\LoadingScreens.dbc');
  assert.match(reads[1].path,/two\.blp$/);
  assert.deepEqual(events.map(e=>e.kind),['screen','background','fill','border']);
  assert.equal(reads.length,6);
});
test('missing DBC or individual art falls back explicitly, without blocking world work',async()=>{
  const events=[];
  await loadLoadingArt({read:async()=>{throw Object.assign(Error('missing'),{code:'NOT_FOUND'});}},decode,e=>events.push(e),()=>false);
  assert.equal(events[0].event,'loading-art-warning');
  events.length=0;
  await loadLoadingArt({read:async path=>{
    if(path.endsWith('.dbc'))return screenDbc();
    if(path.endsWith('one.blp'))throw Object.assign(Error('missing'),{code:'NOT_FOUND'});
    return new Uint8Array([1]);
  }},decode,e=>events.push(e),()=>false);
  assert.equal(events.filter(e=>e.event==='loading-art').length,3);
  assert.match(events[0].message,/screen artwork: missing/);
});
test('dismissal prevents late decoding and publication',async()=>{
  let release,stopped=false,decoded=0;const events=[];
  const work=loadLoadingArt({read:async path=>path.endsWith('.dbc')?screenDbc():await new Promise(resolve=>{release=resolve;})},
    ()=>{decoded++;return decode();},e=>events.push(e),()=>stopped);
  await new Promise(resolve=>setImmediate(resolve));stopped=true;release(new Uint8Array([1]));await work;
  assert.equal(decoded,0);assert.equal(events.length,0);
});
test('loading canvases retain no pixel surfaces after dismissal and ignore late events',()=>{
  const old=globalThis.ImageData;
  globalThis.ImageData=class {constructor(data,width,height){Object.assign(this,{data,width,height});}};
  const draws=[],classes=new Set(),context={putImageData(){},drawImage(){},save(){},restore(){},beginPath(){},clip(){},
    rect(...args){draws.push(args);}};
  const document={createElement:()=>({width:0,height:0,getContext:()=>context,ownerDocument:document})};
  const screen=document.createElement(),bar=document.createElement(),dialog={open:true,classList:{
    add:name=>classes.add(name),remove:(...names)=>names.forEach(name=>classes.delete(name))}};
  try{
    const art=new LoadingArt(screen,bar,dialog);
    for(const kind of ['screen','background','fill','border'])art.event({kind,...decode()});
    art.progress(1,4);assert.equal(draws.at(-1)[2],.25);
    const surfaces=[...art.parts.values()];dialog.open=false;art.clear();
    assert.equal(art.parts.size,0);assert.equal(classes.size,0);
    for(const canvas of [screen,bar,...surfaces])assert.equal(canvas.width*canvas.height,0);
    art.event({kind:'screen',...decode()});assert.equal(screen.width,0);
  }finally{globalThis.ImageData=old;}
});
