import init,* as wasmTypes from './pkg/flats_racer_web.js';
import {FarStream} from './far-stream.js';
import {errorText,replyError} from './worker-rpc.js';

let stream,read,serial=0,timer;
const ready=init();
const deferred=()=>Object.assign(Error('Distant source read deferred'),{code:'DEFERRED'});
const send=(message,transfers=[])=>postMessage(message,transfers);
const fault=error=>send({event:'far-error',epoch:stream?.epoch,error:errorText(error)});
function schedule() {
  if(timer!==undefined||!stream?.enabled)return;
  timer=setTimeout(()=>{
    timer=undefined;
    void stream.step().catch(fault).finally(schedule);
  },25);
}
onmessage=({data})=>{
  if(data.action==='read-result') {
    if(!read||data.id!==read.id)return;
    const pending=read;read=undefined;
    if(data.error)pending.reject(replyError(data));
    else if(pending.epoch!==stream.epoch||pending.shouldDefer?.())pending.reject(deferred());
    else pending.resolve(data.bytes);
    return;
  }
  if(data.action==='ack'){stream?.ack(data.token);return;}
  void ready.then(wasm=>{
    if(data.action==='init') {
      stream=new FarStream({read(path,{shouldDefer}={}) {
        if(read)throw Error('Distant worker exceeded its single-read budget');
        if(!stream.enabled||shouldDefer?.())return Promise.reject(deferred());
        return new Promise((resolve,reject)=>{
          read={id:++serial,epoch:stream.epoch,shouldDefer,resolve,reject};
          send({event:'far-read',id:read.id,epoch:read.epoch,path});
        });
      }},wasmTypes,data.manifest,send,()=>wasm.memory.buffer.byteLength);
    } else if(data.action==='focus') {
      stream.focus(data);send({event:'far-focus-ack'});schedule();
    } else if(data.action==='near') {
      stream.near(data.ids);send({event:'far-near-ack'});
    } else if(data.action==='retry')stream.retry();
    else throw Error('Unknown distant worker operation');
  }).catch(fault);
};
