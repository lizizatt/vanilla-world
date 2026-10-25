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
