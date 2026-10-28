import {RpcTable} from './worker-rpc.js';
export class WorldClient {
  constructor(onEvent,onError,canFrame=()=>true) {
    this.onEvent=onEvent;this.onError=onError;this.requests=new RpcTable();
    this.elapsed=0;this.inFlight=false;this.canFrame=canFrame;
    this.poseSamples=[];this.poseFlying=false;
    this.hopSequence=0;this.pendingHop=0;this.hopHeld=false;
  }
  stop() {
    this.worker?.terminate();this.worker=undefined;
    this.requests.rejectAll(new DOMException('World closed','AbortError'));
    this.inFlight=false;this.discardFrame();
  }
  stopLoadingArt(){this.worker?.postMessage({action:'stop-loading-art'});}
  sky(){this.worker?.postMessage({action:'sky'});}
  worldmap(names){this.worker?.postMessage({action:'worldmap',names});}
  animate(on){this.worker?.postMessage({action:'animate',on});}
  budget(bytes,gpu=0){this.worker?.postMessage({action:'budget',bytes,gpu});}
  music(fields){this.worker?.postMessage({action:'music',...fields});}
  request(action,fields={}) {
    if(!this.worker) return Promise.reject(new Error('Select the local Data folder first.'));
    if(action==='reset' || action==='restore')this.discardFrame();
    return new Promise((resolve,reject)=>{
      const id=this.requests.open({resolve,reject,action});
      try{this.worker.postMessage({id,action,...fields});}
      catch(error){this.requests.take(id);reject(error);}
    });
  }
  async open(folder,loadingMap,extra={}) {
    this.stop();
    const worker=new Worker('./world-worker.js',{type:'module'});
    this.worker=worker;this.bind(worker);
    const result=await this.request('open',{folder,loadingMap,...extra,sceneInstanceDeltas:true,sceneInstanceUpdates:true,postFrameVisuals:true});
    this.info=result.info;this.state=result.state;
    return result;
  }
  /** Exchange resident worlds with another client (design/elune.md: warm second engine becomes the near one, no reload). Each object keeps its own handlers and role, so
   * every module holding `app.client` keeps working; only the worker, its RPC table, info/state and body id move (farOnly is a role and stays). */
  swap(other) {
    for(const key of ['worker','requests','info','state','bodyId']){const t=this[key];this[key]=other[key];other[key]=t;}
    for(const c of [this,other]){c.inFlight=false;c.discardFrame();c.poseFlying=false;if(c.worker)c.bind(c.worker);}
  }
  bind(worker) {
    worker.onerror=event=>{
      if(this.worker!==worker)return;
      this.requests.rejectAll(new Error(event.message));
      this.onError(new Error(`World worker failed: ${event.message}`));
    };
    worker.onmessage=({data})=>{
      if(this.worker!==worker)return;
      if(data.event==='world-error'){
        this.discardFrame();this.onError(new Error(data.error));return;
      }
      if(data.event) {
        const receipt={token:data.token,producer:data.producer};
        let accepted;
        try {accepted=this.onEvent(data);}
        catch(error) {
          if(data.event==='far-scene')worker.postMessage({action:'far-reject',...receipt});
          this.onError(error);return;
        }
        if(data.event==='far-scene')worker.postMessage({action:accepted===true?'far-ack':'far-reject',...receipt});
        return;
      }
      const request=this.requests.take(data.id);
      if(!request)return;
      if(data.error)request.reject(new Error(data.error));else request.resolve(data.result);
    };
  }
  frame(dt,throttle,steer,flags,focus,distant=true,view,pitch=0) {
    if(!!focus!==this.poseFlying){this.discardFrame();this.poseFlying=!!focus;}
    const hop=!!(flags&8)&&!focus;
    if(hop&&!this.hopHeld)this.pendingHop=++this.hopSequence;
    this.hopHeld=hop;
    this.elapsed=Math.min(.1,this.elapsed+dt);
    this.pendingFrame={throttle,steer,pitch:focus?0:pitch,flags,focus,distant,sampleTime:performance.now()};
    if(this.farOnly&&focus)this.pendingFrame.farOnly=true;
    if(view!==undefined)this.pendingFrame.view=view;
    this.flushFrame();
  }
  discardFrame() {
    this.pendingFrame=undefined;this.elapsed=0;this.pendingHop=0;this.hopHeld=false;this.clearPose();
  }
  clearPose() {
    this.poseSamples.length=0;this.poseState=undefined;this.lastPoseTime=undefined;
  }
  recordPose(state) {
    this.state=state;
    const p=state.telemetry,time=state.poseTime,previous=this.poseSamples.at(-1);
    if(time!==undefined && (!Number.isFinite(time) || !Array.isArray(p) || p.length<15
      || !p.slice(0,15).every(Number.isFinite) || (p.length>17&&!Number.isFinite(p[17]))))throw new Error('Invalid confirmed vehicle pose');
    if(time===undefined || this.poseFlying || p[8] || state.scene?.waitingCollision) {
      this.clearPose();
    } else {
      if(previous) {
        const rebased=[11,12,13].some(i=>p[i]!==previous.p[i]);
        const travel=Math.hypot(p[0]-previous.p[0],p[2]-previous.p[2]);
        const bound=Math.max(p[5],previous.p[5])*(time-previous.time)/1000+1e-3;
        // Samples are global: an origin-only translation must not restart the presentation delay.
        if(time<previous.time || p[10]!==previous.p[10] || (rebased&&travel>bound))this.clearPose();
      }
      if(this.poseSamples.at(-1)?.time===time)this.poseSamples[this.poseSamples.length-1]={time,p};
      else this.poseSamples.push({time,p});
      if(this.poseSamples.length>32)this.poseSamples.shift();
    }
    this.poseState=state;
  }
  presentation(now=performance.now()) {
    const p=this.state.telemetry;
    if(this.state!==this.poseState || p[8] || this.state.scene?.waitingCollision)this.clearPose();
    if(!this.poseSamples.length)return p;
    const samples=this.poseSamples,last=samples.at(-1);
    const time=Math.max(now-30,this.lastPoseTime ?? -Infinity);
    if(time<samples[0].time || time>=last.time) {
      this.lastPoseTime=last.time;return p;
    }
    while(samples.length>2 && samples[1].time<=time)samples.shift();
    const [a,b]=samples,alpha=(time-a.time)/(b.time-a.time),out=p.slice();
    for(let i=0;i<3;i++)out[i]=a.p[i]+(b.p[i]-a.p[i])*alpha;
    const yaw=b.p[3]-a.p[3];
    out[3]=a.p[3]+Math.atan2(Math.sin(yaw),Math.cos(yaw))*alpha;
    out[4]=a.p[4]+(b.p[4]-a.p[4])*alpha;
    if(p.length>17)out[17]=(a.p[17]??0)+((b.p[17]??0)-(a.p[17]??0))*alpha;
    this.lastPoseTime=time;
    return out;
  }
  flushFrame() {
    if(!this.worker || !this.canFrame()){this.discardFrame();return;}
    for(const request of this.requests.values())if(request.action==='reset' || request.action==='restore'){
      this.discardFrame();return;
    }
    if(this.inFlight || !this.pendingFrame)return;
    const worker=this.worker,fields=this.pendingFrame,elapsed=this.elapsed;
    this.pendingFrame=undefined;this.elapsed=0;this.inFlight=true;
    this.request('frame',{dt:elapsed,...fields,hop:this.pendingHop}).then(state=>{
      if(this.worker===worker){
        if(state.hopConsumed===this.pendingHop)this.pendingHop=0;
        this.recordPose(state);
      }
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
