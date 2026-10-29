import {LAUNCH} from './pod-launch.js';

/** HUD model for the powered pickup boost. `remaining` counts boost-seconds still available (spent only while boosting under throttle), so the bar tracks use, not wall time. */
export function boostView(pod,max=LAUNCH.charge) {
  const remaining=Number(pod?.remaining);
  if(!Number.isFinite(remaining)||remaining<=0)return {visible:false,fraction:0,text:'',low:false};
  const left=Math.min(max,remaining),fraction=left/max;
  return {visible:true,fraction,text:`${left.toFixed(1)} s`,low:fraction<=.25};
}

/** Applies the view to the DOM only when it changes, so the per-frame call costs nothing while idle. */
export function renderBoost(root,view) {
  const key=view.visible?`${view.text}|${view.low}`:'';
  if(root.dataset.key===key)return;
  root.dataset.key=key;root.hidden=!view.visible;
  if(!view.visible)return;
  root.dataset.low=String(view.low);
  root.querySelector('#boost-fill').style.width=`${(view.fraction*100).toFixed(1)}%`;
  root.querySelector('#boost-sec').textContent=view.text;
  root.setAttribute('aria-valuenow',view.text);
}
