import {SCENE_LIMITS} from './scene-stream.js';
let nextProducer=0;

// Source ownership remains here: one serialized, preemptible optional read, no second MPQ index.
export class FarChannel {
  constructor(createWorker,source,manifest,send,shouldDefer) {
    this.source=source;this.send=send;this.shouldDefer=shouldDefer;
    this.epoch=0;this.active=true;
    this.producer=++nextProducer;
    this.readStats={reads:0,bytes:0,peakBytes:0,deferred:0};
    this.state={resident:0,peak:0,limit:SCENE_LIMITS.distantTiles,loads:0,pending:0,failures:[]};
    try {
      this.worker=createWorker();
      this.worker.onmessage=({data})=>{void this.receive(data).catch(error=>this.fail(error));};
      this.worker.onerror=event=>{event.preventDefault?.();this.fail(Error(event.message));};
      this.worker.onmessageerror=()=>this.fail(Error('Distant worker message could not be decoded'));
      this.post({action:'init',manifest});
    } catch(error) {this.fail(error);}
  }
  post(data,transfers=[]) {
    if(this.active)try {this.worker.postMessage(data,transfers);}
    catch(error) {this.fail(error);}
  }
  focus(region,position,enabled) {
    if(region!==this.region||enabled!==this.enabled) {
      if(region!==this.region)this.state={...this.state,resident:0,pending:0,scene:undefined};
      this.epoch++;this.region=region;this.enabled=enabled;
    }
    this.latest={action:'focus',epoch:this.epoch,region,position,enabled};
    this.flushFocus();
  }
  flushFocus() {
    if(!this.active||this.focusPending||!this.latest)return;
    const next=this.latest;this.latest=undefined;this.focusPending=true;
    this.post(next);
  }
  near(ids) {this.latestNear=ids;this.flushNear();}
  flushNear() {
    if(!this.active||this.nearPending||!this.latestNear)return;
    const ids=this.latestNear;this.latestNear=undefined;this.nearPending=true;
    this.post({action:'near',ids});
  }
  async receive(data) {
    if(!this.active)return;
    if(data.event==='far-focus-ack'){this.focusPending=false;this.flushFocus();return;}
    if(data.event==='far-near-ack'){this.nearPending=false;this.flushNear();return;}
    if(data.event==='far-error') {
      if(data.epoch===undefined||data.epoch===this.epoch)this.fail(Error(data.error));
      return;
    }
    if(data.event==='far-scene') {
      if(data.epoch!==this.epoch||!this.enabled){this.post({action:'ack',token:data.token});return;}
      if(this.uploadToken!==undefined)throw Error('Distant worker exceeded its transfer budget');
      this.uploadToken=data.token;
      this.state=data.stats;
      const transfers=[...data.assets.flatMap(a=>[a.vertices.buffer,a.indices.buffer]),
        ...data.textures.map(t=>t.rgba.buffer)];
      this.send({...data,producer:this.producer},transfers);return;
    }
    if(data.event!=='far-read')throw Error('Unknown distant worker message');
    if(this.reading)throw Error('Distant worker exceeded its source-read budget');
    this.reading=true;
    const deferred=()=>!this.active||data.epoch!==this.epoch||!this.enabled||this.shouldDefer();
    try {
      if(deferred())throw Object.assign(Error('Distant source read deferred'),{code:'DEFERRED'});
      const bytes=await this.source.read(data.path,{background:true,shouldDefer:deferred});
      this.readStats.reads++;this.readStats.bytes+=bytes.byteLength;
      this.readStats.peakBytes=Math.max(this.readStats.peakBytes,bytes.byteLength);
      if(bytes.byteLength>64*1024*1024)throw Error('Encoded distant resource exceeds 64 MiB');
      if(deferred())throw Object.assign(Error('Distant source read deferred'),{code:'DEFERRED'});
      this.post({action:'read-result',id:data.id,bytes},[bytes.buffer]);
    } catch(error) {
      if(error.code==='DEFERRED')this.readStats.deferred++;
      if(this.active)this.post({action:'read-result',id:data.id,
        error:String(error.message||error),code:error.code||'READ'});
    } finally {this.reading=false;}
  }
  ack(token,producer) {
    if(producer!==this.producer||token!==this.uploadToken)return;
    this.uploadToken=undefined;this.post({action:'ack',token});
  }
  reject(token,producer) {
    if(producer===this.producer&&token===this.uploadToken)
      this.fail(Error('Distant render upload failed; retry resources to restart it'));
  }
  snapshot() {return {...this.state,enabled:this.enabled,source:{...this.readStats}};}
  retry() {if(this.active){this.state.failures=[];this.post({action:'retry'});}}
  fail(error) {
    this.state.failures=[`Distant worker: ${error.message||error}`];
    this.worker?.terminate();this.active=false;
  }
  close() {this.active=false;this.worker?.terminate();}
}
