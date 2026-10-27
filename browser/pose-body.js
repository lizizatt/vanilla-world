// Which body a ?pose= link belongs to. Links from before the `body` field existed carry only a chart-frame flight pose, so fall back to a heuristic.
import {sitesOf,domeCentre} from './elune-sites.js';

export const HEURISTIC_RADIUS=6000,HEURISTIC_ALTITUDE=8000;

/** Explicit `body` wins; else a low flight within HEURISTIC_RADIUS yd of an Elune site's dome (where Azeroth's chart has nothing of interest) is read as Elune; else Azeroth. */
export function poseBody(view,known=['azeroth','elune']) {
  if(typeof view?.body==='string'&&known.includes(view.body))return view.body;
  const f=view?.flight;
  if(Array.isArray(f)&&f.length>=3&&f.slice(0,3).every(Number.isFinite)&&f[1]<HEURISTIC_ALTITUDE) {
    for(const body of known) {
      if(body==='azeroth')continue;
      for(const site of sitesOf(body)) {
        const [x,z]=domeCentre(site,30,15);
        if(Math.hypot(f[0]-x,f[2]-z)<HEURISTIC_RADIUS)return body;
      }
    }
  }
  return 'azeroth';
}
