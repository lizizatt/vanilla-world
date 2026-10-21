// Vehicle registry. Pure data plus selection helpers, no DOM. A vehicle type decides which races are visible
// (track.vehicle, default 'podracer'); free flight is just a type without races.
// Skin `source`: 'data' = authored model read at runtime from the user's Data (never shipped), 'glb' = original
// model shipped in browser/vehicles/ (`model`), 'procedural' = drawn in code, 'none' = no body.
export const DEFAULT_CHOICE=Object.freeze({vehicle:'podracer',skin:'rocket'});
export const STORAGE_KEY='racer.vehicle';

// glb skins: \scale\ converts the model's own units to yards (models are authored in metres; tuned against the rocket's footprint).
export const METRES=1.0936;
export const VEHICLES=Object.freeze({
  'free-flight':{id:'free-flight',name:'Free flight',races:false,stats:{Speed:.6,Handling:.7,Boost:.5},
    note:'No race class: explore freely with the free camera.',
    skins:[{id:'camera',name:'Free camera',source:'none'}]},
  podracer:{id:'podracer',name:'Podracer',races:true,stats:{Speed:.9,Handling:.55,Boost:.8},
    note:'Hovering racer on the ground and over water. Boost with Shift.',
    skins:[{id:'rocket',name:'Rocket (current)',source:'data'},
      {id:'dug-racer',name:'Dug racer',source:'glb',model:'./vehicles/dug-racer.glb',scale:METRES},
      {id:'dug-racer-green',name:'Dug racer (green)',source:'glb',model:'./vehicles/dug-racer-green.glb',scale:METRES},
      {id:'dug-racer-crimson',name:'Dug racer (crimson)',source:'glb',model:'./vehicles/dug-racer-crimson.glb',scale:METRES}]},
  plane:{id:'plane',name:'Gnomish plane',races:true,stats:{Speed:.8,Handling:.8,Boost:.4},
    note:'Rigid-body flight model: S/Down pitch up (pull), W/Up pitch down, A/D roll left/right, Q/E rudder, Shift/Ctrl throttle up/down, Space boost; letting go levels the wings and flight path; stalls below about 70 yd/s and recovers when the nose drops. Collides with terrain, water, buildings and trees by skimming off them; creatures are not solid.',
    skins:[{id:'gnomish',name:'Ironforge airfield (game model)',source:'data'},
      {id:'procedural',name:'Plain plane',source:'procedural'}]},
});

export const vehicleOf=track=>track?.vehicle??'podracer';
export const tracksFor=(tracks,vehicle)=>tracks.filter(t=>vehicleOf(t)===vehicle);
export const isVehicle=id=>typeof id==='string'&&Object.hasOwn(VEHICLES,id);

// Anything unreadable or unknown falls back to the default; an unknown skin falls back to the type's first skin.
export function normalizeChoice(raw) {
  const vehicle=isVehicle(raw?.vehicle)?raw.vehicle:DEFAULT_CHOICE.vehicle;
  const skins=VEHICLES[vehicle].skins;
  return {vehicle,skin:skins.some(s=>s.id===raw?.skin)?raw.skin:skins[0].id};
}
export function readChoice(storage=globalThis.localStorage) {
  try{return normalizeChoice(JSON.parse(storage.getItem(STORAGE_KEY)));}catch{return {...DEFAULT_CHOICE};}
}
export function writeChoice(choice,storage=globalThis.localStorage) {
  try{storage.setItem(STORAGE_KEY,JSON.stringify(normalizeChoice(choice)));}catch{}
}
export const skinOf=choice=>VEHICLES[choice.vehicle].skins.find(s=>s.id===choice.skin);

// Switching is open-world only: never while a race is lining up, counting down or running, nor while editing.
export const canSwitch=({race,editing})=>!race&&!editing;

// Ironforge Airfield: gnomish gyrocopter placements in Azeroth_35_40 (WoW x -4740, y -1706, ground ~503). Heading is along the placement row; the exact runway axis is a guess.
export const AIRFIELD=Object.freeze({wowX:-4740,wowY:-1706,wowZ:503,yaw:Math.PI,above:60});
const SCALE=1600/3;
/** Render-space [x,y,z,yaw] for the airfield, or undefined when no Eastern Kingdoms region is in the manifest. */
export function airfieldPose(manifest,a=AIRFIELD) {
  const r=manifest?.regions?.find(r=>/^azeroth$/i.test(r.map));if(!r)return undefined;
  return [r.placement[0]+(32-r.tile_origin[0])*SCALE-a.wowY,a.wowZ+a.above,r.placement[1]+(32-r.tile_origin[1])*SCALE-a.wowX,a.yaw];
}
