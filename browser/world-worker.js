import {enqueue} from './world-engine.js';
import {routeImmediate,process} from './world-worker-protocol.js';

onmessage=({data})=>{
  if(routeImmediate(data))return;
  enqueue(()=>process(data));
};
