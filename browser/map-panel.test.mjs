import test from 'node:test';
import assert from 'node:assert/strict';
import {MapPanel} from './map-panel.js';

test('showing the map twice never leaves a second marker timer running', () => {
  const realSet=globalThis.setInterval,realClear=globalThis.clearInterval,live=new Set();let next=1;
  globalThis.setInterval=()=>{live.add(next);return next++;};
  globalThis.clearInterval=id=>live.delete(id);
  globalThis.document={activeElement:null,createElement:()=>({getContext:()=>({}),style:{}})};
  globalThis.fetch=async()=>({ok:false});
  try {
    const dialog={open:false,addEventListener(){},show(){this.open=true;}},hook={addEventListener(){}};
    const panel=new MapPanel({dialog,canvas:{},stage:{ownerDocument:{createElement:()=>({}) },append(){},appendChild(){}},status:{},close:hook},{requestArt(){},teleport(){},pose:()=>[0,0,0]});
    panel.manifest={regions:[]};panel.render=()=>{};
    panel.show();panel.show();
    assert.equal(live.size,1);
    panel.stop();
    assert.equal(live.size,0);
  } finally {
    globalThis.setInterval=realSet;globalThis.clearInterval=realClear;delete globalThis.document;delete globalThis.fetch;
  }
});

test('each body from config gets a button that flies there', () => {
  const els=[],make=()=>({style:{},dataset:{},addEventListener(t,f){this[t]=f;},remove(){},getContext:()=>({clearRect(){},save(){},restore(){}})});
  globalThis.document={createElement:()=>make()};globalThis.fetch=async()=>({ok:false});
  const stage={ownerDocument:{createElement:()=>make()},style:{setProperty(){}},querySelectorAll:()=>[],append:e=>els.push(e)},flown=[];
  try {
    const panel=new MapPanel({dialog:{addEventListener(){},close(){}},canvas:{width:100,getContext:()=>({clearRect(){},save(){},restore(){},fillRect(){},strokeRect(){},fillText(){},beginPath(){},rect(){},stroke(){},fill(){}})},stage,status:{},close:{addEventListener(){}}},{requestArt(){},teleport:icon=>flown.push(icon.body),pose:()=>null,bodies:()=>[{id:'elune',label:'Elune'},{id:'second',label:'Second'}]});
    panel.manifest={spawn:[0,0,0],sea_level:0,ocean:[5333,-16000,13525,17066],world_bounds:[[0,0,51,56]],horizons:[{region:0,source_bounds:[0,0,51,56]}],regions:[{map:'K',tile_origin:[0,0],tile_count:[64,64],placement:[-21866,-12266]}]};panel.you=make();panel.world=()=>{};
    panel.render();
    const buttons=els.filter(e=>e.dataset.body);
    assert.deepEqual(buttons.map(b=>b.textContent),['Elune','Second']);
    buttons[0].click();buttons[1].click();
    assert.deepEqual(flown,['elune','second']);
  } finally { delete globalThis.document;delete globalThis.fetch; }
});

test('every race start gets a pin at its own map position', () => {
  const els=[],make=()=>({style:{},dataset:{},addEventListener(){},remove(){},getContext:()=>({clearRect(){},save(){},restore(){}})});
  globalThis.document={createElement:()=>make()};globalThis.fetch=async()=>({ok:false});
  const stage={ownerDocument:{createElement:()=>make()},style:{setProperty(){}},querySelectorAll:()=>[],append:e=>els.push(e)};
  const tracks=[{id:'a',start:{pos:[-20000,0,-5000]}},{id:'b',start:{pos:[15000,0,3000]}}];
  try {
    const panel=new MapPanel({dialog:{addEventListener(){}},canvas:{width:100,getContext:()=>({clearRect(){},save(){},restore(){},fillRect(){},strokeRect(){},fillText(){},beginPath(){},rect(){},stroke(){},fill(){}})},stage,status:{},close:{addEventListener(){}}},{requestArt(){},teleport(){},pose:()=>null,tracks:()=>tracks});
    panel.manifest={spawn:[0,0,0],sea_level:0,ocean:[5333,-16000,13525,17066],world_bounds:[[0,0,51,56],[24,20,45,62]],horizons:[{region:0,source_bounds:[0,0,51,56]},{region:1,source_bounds:[24,20,45,62]}],regions:[{map:'K',tile_origin:[0,0],tile_count:[64,64],placement:[-21866,-12266]},{map:'E',tile_origin:[0,0],tile_count:[64,64],placement:[725,-16000]}]};panel.you=make();panel.world=()=>{};
    panel.render();
    const pins=els.filter(e=>e.className==='map-track');
    assert.equal(pins.length,2);
    assert.notEqual(pins[0].style.left,pins[1].style.left);
    assert.ok(pins.every(p=>/^-?[\d.]+%$/.test(p.style.left)&&/^-?[\d.]+%$/.test(p.style.top)));
  } finally { delete globalThis.document;delete globalThis.fetch; }
});

test('configuring with a moon manifest (no world_bounds) keeps Azeroth\'s map, so opening the map on Elune cannot crash', () => {
  const els=[],make=()=>({style:{},dataset:{},addEventListener(){},remove(){},getContext:()=>({clearRect(){},save(){},restore(){}})});
  globalThis.document={createElement:()=>make()};globalThis.fetch=async()=>({ok:false});
  const stage={ownerDocument:{createElement:()=>make()},style:{setProperty(){}},querySelectorAll:()=>[],append:e=>els.push(e)};
  try {
    const panel=new MapPanel({dialog:{addEventListener(){}},canvas:{width:100,getContext:()=>({clearRect(){},save(){},restore(){},fillRect(){},strokeRect(){},fillText(){},beginPath(){},rect(){},stroke(){},fill(){}})},stage,status:{},close:{addEventListener(){}}},{requestArt(){},teleport(){},pose:()=>undefined});
    const azeroth={spawn:[0,0,0],sea_level:0,ocean:[5333,-16000,13525,17066],world_bounds:[[0,0,51,56]],horizons:[{region:0,source_bounds:[0,0,51,56]}],regions:[{map:'K',tile_origin:[0,0],tile_count:[64,64],placement:[-21866,-12266]}]};
    panel.configure(azeroth);panel.configure({spawn:[0,0,0],regions:[{map:'Elune',tile_origin:[0,0],tile_count:[60,30],placement:[0,0]}]});
    assert.equal(panel.manifest,azeroth);
    panel.you=make();panel.world=()=>{};
    assert.doesNotThrow(()=>panel.render());
    panel.configure(Object.assign({},azeroth));assert.notEqual(panel.manifest,azeroth);
  } finally { delete globalThis.document;delete globalThis.fetch; }
});

test('map teleport schema: optional body id; Elune lands on the site in its own chart, Azeroth entries swap back from a moon', async () => {
  const {teleportPlan,siteChartPose}=await import('./elune-pose.js');
  const {ELUNE}=await import('./bodies.js');const {sitesOf,domeMask}=await import('./elune-sites.js');
  const up=teleportPlan({id:'elune',body:'elune'},'azeroth');
  assert.equal(up.body,'elune');assert.equal(up.swap,true);assert.deepEqual(up.pose,siteChartPose(ELUNE,250));
  assert.ok(Math.abs(up.pose[0]-523.9)<60&&Math.abs(up.pose[2]-287)<60);
  assert.equal(teleportPlan({id:'elune',body:'elune'},'elune').swap,false);
  const home=teleportPlan({id:'stormwind',pose:[1,2,3]},'elune');
  assert.equal(home.body,'azeroth');assert.equal(home.swap,true);assert.equal(home.pose,undefined);
  assert.equal(teleportPlan({id:'stormwind'},'azeroth').swap,false);void sitesOf;void domeMask;
});
