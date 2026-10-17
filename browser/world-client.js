export class WorldClient {
  constructor(onEvent,onError,canFrame=()=>true) {
    this.onEvent=onEvent;this.onError=onError;this.next=0;this.requests=new Map();
    this.elapsed=0;this.inFlight=false;this.canFrame=canFrame;
  }
  stop() {
    this.worker?.terminate();this.worker=undefined;
    for(const request of this.requests.values()) request.reject(new DOMException('World closed','AbortError'));
    this.requests.clear();this.inFlight=false;this.discardFrame();
  }
  request(action,fields={}) {
    if(!this.worker) return Promise.reject(new Error('Select the local Data folder first.'));
    if(action==='reset' || action==='restore')this.discardFrame();
    return new Promise((resolve,reject)=>{
      const id=++this.next;
      this.requests.set(id,{resolve,reject,action});
      try{this.worker.postMessage({id,action,...fields});}
      catch(error){this.requests.delete(id);reject(error);}
    });
  }
  async open(folder) {
    this.stop();
    const worker=new Worker('./world-worker.js',{type:'module'});
    this.worker=worker;
    worker.onerror=event=>{
      for(const request of this.requests.values()) request.reject(new Error(event.message));
      this.requests.clear();this.onError(new Error(`World worker failed: ${event.message}`));
    };
    worker.onmessage=({data})=>{
      if(data.event) {this.onEvent(data);return;}
      const request=this.requests.get(data.id);
      if(!request)return;
      this.requests.delete(data.id);
      if(data.error)request.reject(new Error(data.error));else request.resolve(data.result);
    };
    const result=await this.request('open',{folder});
    this.info=result.info;this.state=result.state;
    return result;
  }
  frame(dt,throttle,steer,flags,focus,distant=true) {
    this.elapsed=Math.min(.1,this.elapsed+dt);
    this.pendingFrame={throttle,steer,flags,focus,distant};
    this.flushFrame();
  }
  discardFrame() {
    this.pendingFrame=undefined;this.elapsed=0;
  }
  flushFrame() {
    if(!this.worker || !this.canFrame()){this.discardFrame();return;}
    for(const request of this.requests.values())if(request.action==='reset' || request.action==='restore'){
      this.discardFrame();return;
    }
    if(this.inFlight || !this.pendingFrame)return;
    const worker=this.worker,fields=this.pendingFrame,elapsed=this.elapsed;
    this.discardFrame();this.inFlight=true;
    this.request('frame',{dt:elapsed,...fields}).then(state=>{
      if(this.worker===worker)this.state=state;
    }).catch(error=>{
      if(this.worker===worker){
        this.discardFrame();
        if(error.name!=='AbortError')this.onError(error);
      }
    }).finally(()=>{
      if(this.worker===worker){this.inFlight=false;this.flushFrame();}
    });
  }
}
