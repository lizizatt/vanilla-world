export class AssetSource {
  constructor(worker) {
    this.worker=worker;this.pending=new Map();this.serial=0;this.stats={};
    worker.onmessage=({data})=>{
      if(['progress','loading-art','loading-art-warning'].includes(data.event)){this.onProgress?.(data);return;}
      const request=this.pending.get(data.id);
      if(!request)return;
      this.pending.delete(data.id);
      if(data.stats)this.stats=data.stats;
      try {
        if(data.error)request.reject(Object.assign(Error(data.error),{code:data.code}));
        else if(request.shouldDefer?.())request.reject(Object.assign(Error('Obsolete background resource'),{code:'DEFERRED'}));
        else request.resolve(data.result);
      } catch(error){request.reject(error);}
      finally {this.post({action:'ack',id:data.id});}
    };
    worker.onerror=event=>{event.preventDefault?.();this.fail(Error(`Asset worker: ${event.message}`));};
    worker.onmessageerror=()=>this.fail(Error('Asset worker message could not be decoded'));
  }
  post(data,transfers=[]) {
    if(this.error)return;
    try {this.worker.postMessage(data,transfers);}
    catch(error){this.fail(error);}
  }
  request(action,fields={},shouldDefer,transfers=[]) {
    if(this.error)return Promise.reject(this.error);
    if(shouldDefer?.())return Promise.reject(Object.assign(Error('Background resource deferred'),{code:'DEFERRED'}));
    return new Promise((resolve,reject)=>{
      const id=++this.serial;
      this.pending.set(id,{resolve,reject,shouldDefer,cancelled:false});
      this.post({action,id,...fields},transfers);
    });
  }
  read(path,{background=false,shouldDefer}={}) {
    return this.request('read',{path,background},shouldDefer);
  }
  readTexture(path,output='rgba',shouldDefer) {
    return this.request('texture',{path,background:true,output},shouldDefer);
  }
  prepareDetail(detail) {
    return this.request('detail',{detail,background:true},undefined,
      [...detail.tiles,...detail.seams].map(t=>t.vertices.buffer));
  }
  refresh() {
    for(const [id,request] of this.pending)if(!request.cancelled&&request.shouldDefer?.()){
      request.cancelled=true;this.post({action:'cancel',id});
    }
  }
  fail(error) {
    this.error=error;this.worker.terminate();
    for(const request of this.pending.values())request.reject(error);
    this.pending.clear();
  }
  close(){this.fail(Object.assign(Error('Data source closed'),{code:'CLOSED'}));}
  stopLoadingArt(){this.post({action:'stop-art'});}
}

export async function openAssetSource(folder,createWorker=()=>new Worker('./asset-worker.js',{type:'module'}),onProgress,{loadingArt=false,map}={}) {
  const source=new AssetSource(createWorker());
  source.onProgress=onProgress;
  try {Object.assign(source,await source.request('open',{folder,loadingArt,map}));return source;}
  catch(error){source.close();throw error;}
}
