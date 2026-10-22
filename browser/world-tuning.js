export const TUNING_FIELDS=[
  ['Cruise speed (yd/s)',150],['Boost speed (yd/s)',300],['Thrust',50],['Extra boost thrust',30],
  ['Braking',30],['Drag',.25],['Turn rate',2.2],['Turn response',10],['Grip',8],['Drift grip',1.5],
  ['Drift turn multiplier',1.3],['Hover height (yd)',3],['Spring',90],['Damping',18],
  ['Gravity',48],['Hop speed',7],['Air control',.9],
];
// Older records get the new defaults only where they still hold the old default value (v2: boost 300/30, v3: gravity 48).
export function migrateTuning(record) {
  if(!record || record.defaults===3 || !Array.isArray(record.values))return record;
  const values=record.values.slice();
  if(record.defaults!==2){if(values[1]===1000)values[1]=300;if(values[3]===250)values[3]=30;}
  if(values[14]===24)values[14]=48;
  return {...record,values,defaults:3};
}
export function validateTuningRecord(record) {
  if(!record || record.version!==1 || !Array.isArray(record.values) || record.values.length!==17
    || !record.values.every(n=>typeof n==='number' && Number.isFinite(Math.fround(n)) && n>=0)
    || ![0,1,11,14].every(i=>Math.fround(record.values[i])>0) || record.values[1]<record.values[0]
    || typeof record.cameraSeconds!=='number' || !Number.isFinite(Math.fround(record.cameraSeconds)) || record.cameraSeconds<0) {
    throw new Error('Saved tuning is damaged or outside its physical domains. It has been retained; use Restore defaults to recover.');
  }
  return record;
}
