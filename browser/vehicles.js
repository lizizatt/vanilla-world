// Vehicle registry. Pure data plus selection helpers, no DOM. A vehicle type decides which races are visible
// (track.vehicle, default 'podracer'); free flight is just a type without races.
// Skin `source`: 'data' = authored model read at runtime from the user's Data (never shipped), 'glb' = original
// model shipped in browser/vehicles/ (`model`), 'wow' = another creature model (`display` id) read from the user's Data at runtime
// (never shipped; offered only while the Data is open), 'procedural' = drawn in code, 'none' = no body.
export const DEFAULT_CHOICE=Object.freeze({vehicle:'podracer',skin:'rocket'});
const STORAGE_KEY='racer.vehicle';

export const VEHICLES=Object.freeze({
  'free-flight':{id:'free-flight',name:'Free flight',races:false,stats:{Speed:.6,Handling:.7,Boost:.5},
    note:'No race class: explore freely with the free camera.',
    skins:[{id:'camera',name:'Free camera',source:'none'}]},
  podracer:{id:'podracer',name:'Podracer',races:true,stats:{Speed:.9,Handling:.55,Boost:.8},
    note:'Hovering racer on the ground and over water. Boost with Shift.',
    skins:[{id:'rocket',name:'Rocket (current)',source:'data'},
      {id:'gnome-rocket-car',name:'Gnome rocket car',source:'wow',display:2490,model:'Creature\\GnomeRocketCar\\GnomeRocketCar'}]},
});

export const vehicleOf=track=>track?.vehicle??'podracer';
/** Tracks are authored in one body's chart; a track without `body` belongs to Azeroth. Only the active body's tracks are ever drawn, listed or offered. */
export const tracksFor=(tracks,vehicle,body='azeroth')=>tracks.filter(t=>vehicleOf(t)===vehicle&&(t.body??'azeroth')===body);
const isVehicle=id=>typeof id==='string'&&Object.hasOwn(VEHICLES,id);

// Runtime skins from the user's own SWE1R folder ('swe1r' source); replaced wholesale, removed with an empty list.
export function setRuntimeSkins(source,skins,vehicle='podracer') {
  const list=VEHICLES[vehicle].skins,keep=list.filter(s=>s.source!==source);
  list.splice(0,list.length,...keep,...skins);
}

// Garage carousel: next/previous usable skin id with wrap-around; the current id if nothing else is usable.
export function stepSkin(skins,current,dir,usable=()=>true) {
  const n=skins.length,at=Math.max(0,skins.findIndex(s=>s.id===current));
  for(let k=1;k<=n;k++){const s=skins[((at+dir*k)%n+n)%n];if(usable(s))return s.id;}
  return current;
}

// Anything unreadable or unknown falls back to the default; an unknown skin falls back to the type's first skin.
export function normalizeChoice(raw) {
  const vehicle=isVehicle(raw?.vehicle)?raw.vehicle:DEFAULT_CHOICE.vehicle;
  const skins=VEHICLES[vehicle].skins;
  return {vehicle,skin:skins.some(s=>s.id===raw?.skin)?raw.skin:skins[0].id};
}
export function readChoice(storage=globalThis.localStorage) {
  try{return normalizeChoice(JSON.parse(storage.getItem(STORAGE_KEY)));}catch{return {...DEFAULT_CHOICE};}
}
// A fresh page always starts as the rocket podracer at the car spawn; free flight only starts from an explicit Garage switch.
export function bootChoice(storage=globalThis.localStorage) {
  const saved=readChoice(storage);return saved.vehicle==='podracer'?saved:{...DEFAULT_CHOICE};
}
export function writeChoice(choice,storage=globalThis.localStorage) {
  try{storage.setItem(STORAGE_KEY,JSON.stringify(normalizeChoice(choice)));}catch{/* storage unavailable: choice is not persisted */}
}
export const skinOf=choice=>VEHICLES[choice.vehicle].skins.find(s=>s.id===choice.skin);

// Switching is open-world only: never while a race is lining up, counting down or running, nor while editing.
export const canSwitch=({race,editing})=>!race&&!editing;
