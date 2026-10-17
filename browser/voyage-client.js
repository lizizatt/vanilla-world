import { importRoute, readRoute, writeRouteSave } from './voyage-store.js';

export class RouteClient {
  constructor(onGeometry,onEvict,onStatus,onError,onClear,onHorizon,onSeams) {
    this.onGeometry = onGeometry; this.onEvict = onEvict; this.onStatus = onStatus; this.onError = onError;
    this.onClear = onClear;
    this.onHorizon = onHorizon; this.onSeams = onSeams;
    this.pending = new Map(); this.next = 0; this.inFlight = false; this.elapsed = 0;
  }
  request(action, fields = {}) {
    return new Promise((resolve,reject) => {
      const id = ++this.next;
      this.pending.set(id,{resolve,reject});
      this.worker.postMessage({id,action,...fields});
    });
  }
  stop() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const request of this.pending.values()) request.reject(new DOMException('Route session closed','AbortError'));
    this.pending.clear();
    this.inFlight = false;
    this.elapsed = 0;
    this.state = undefined;
  }
  async open(pack, pose) {
    this.stop();
    this.onClear();
    this.pack = pack;
    this.worker = new Worker('./voyage-worker.js',{type:'module'});
    this.worker.onerror = event => {
      this.onError(new Error(`Route worker failed: ${event.message}`));
      for (const request of this.pending.values()) request.reject(new Error(event.message));
      this.pending.clear();
      this.stop();
    };
    this.worker.onmessage = ({data}) => {
      if (data.event === 'detail') {
        for (const index of data.removed) this.onEvict(index);
        for (const tile of data.tiles) this.onGeometry(tile);
        this.onSeams(data.seams);
      }
      else if (data.event === 'horizon' || data.event === 'horizon-index') this.onHorizon(data);
      else if (data.event === 'loading') this.onStatus(data.text);
      else {
        const request = this.pending.get(data.id);
        if (!request) return;
        this.pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
      }
    };
    this.state = await this.request('open',{pose});
    return this.state;
  }
  async import(files) {
    const pack = await importRoute(files,async (json,files) => {
      const validator = new Worker('./voyage-worker.js',{type:'module'});
      try {
        await new Promise((resolve,reject) => {
          validator.onerror = event => reject(new Error(`Pack validation worker: ${event.message}`));
          validator.onmessage = ({data}) => {
            if (data.event === 'loading') this.onStatus(data.text);
            else if (data.error) reject(new Error(data.error));
            else if (data.id === 1) resolve();
          };
          validator.postMessage({id:1,action:'validate',json,files});
        });
      } finally { validator.terminate(); }
    });
    await this.open(pack);
    localStorage.setItem('racer-mode','route');
  }
  async resume() {
    const pack = await readRoute('meta','pack');
    if (!pack) throw new Error('Route pack is missing; import it again or choose the single-tile lab.');
    if (pack.manifest.version === 2) { await this.open(pack); return; }
    const save = await readRoute('meta','save');
    if (save) this.validateSave(save,pack);
    await this.open(pack,save?.vehicle.pose);
  }
  validateSave(save,pack) {
    if (save.version !== 2 || save.packId !== pack.id || save.vehicle?.type !== 'hovercraft'
      || !Array.isArray(save.vehicle.pose) || save.vehicle.pose.length !== 4
      || !save.vehicle.pose.every(v => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error('Route save incompatible or damaged. Reimport its original pack, or Reset route then Save to replace it. Legacy single-tile saves are unchanged.');
    }
  }
  async save() {
    const snapshot = await this.request('snapshot');
    await writeRouteSave({version:2,packId:this.pack.id,vehicle:{type:'hovercraft',pose:snapshot.telemetry.slice(0,4)}});
    return snapshot.telemetry.slice(0,4);
  }
  async load() {
    const save = await readRoute('meta','save');
    if (!save) throw new Error('No route save yet.');
    this.validateSave(save,this.pack);
    this.state = await this.request('restore',{pose:save.vehicle.pose});
  }
  async reset() {
    if (!this.worker) {
      const pack = await readRoute('meta','pack');
      if (!pack) throw new Error('Import a route pack before resetting.');
      await this.open(pack);
    } else this.state = await this.request('reset');
  }
  frame(dt,throttle,steer,flags,focus) {
    this.elapsed = Math.min(this.elapsed+dt,0.1);
    if (!this.worker || this.inFlight) return;
    this.inFlight = true;
    const elapsed = this.elapsed; this.elapsed = 0;
    this.request('frame',{dt:elapsed,throttle,steer,flags,focus}).then(state => { this.state = state; })
      .catch(error => { if (error.name !== 'AbortError') this.onError(error); }).finally(() => { this.inFlight = false; });
  }
}
