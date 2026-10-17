export class WorldClient {
  constructor(onEvent,onError) {
    this.onEvent=onEvent;this.onError=onError;this.next=0;this.requests=new Map();
    this.elapsed=0;this.inFlight=false;
  }
  stop() {
    this.worker?.terminate();this.worker=undefined;
    for(const request of this.requests.values()) request.reject(new DOMException('World closed','AbortError'));
    this.requests.clear();this.inFlight=false;this.elapsed=0;
  }
  request(action,fields={}) {
    if(!this.worker) return Promise.reject(new Error('Select the local Data folder first.'));
    return new Promise((resolve,reject)=>{
      const id=++this.next;
      this.requests.set(id,{resolve,reject});
      this.worker.postMessage({id,action,...fields});
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
    if(this.inFlight || !this.worker)return;
    const worker=this.worker,elapsed=this.elapsed;this.elapsed=0;this.inFlight=true;
    this.request('frame',{dt:elapsed,throttle,steer,flags,focus,distant}).then(state=>{
      if(this.worker===worker)this.state=state;
    }).catch(error=>{if(error.name!=='AbortError')this.onError(error);}).finally(()=>{
      if(this.worker===worker)this.inFlight=false;
    });
  }
}
