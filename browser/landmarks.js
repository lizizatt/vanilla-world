// Skyline landmarks: authored doodads that stay in the far scene at any range (the normal distant radius is 6 kyd). Only the placement (a position, a yaw) lives here; the model is read from the user's own data like any other doodad.
const T=1600/3,CENTRE=32*T;

/** Source-world (x north, y west, z up) placement of the file's MDDF corner-origin position: X = 32 tiles - z, Y = 32 tiles - x. */
export const fromMddf=(x,y,z)=>[CENTRE-z,CENTRE-x,y];

export const LANDMARKS=Object.freeze([
  // Nordrassil, the world tree on the summit of Mount Hyjal (one MDDF uid 345709, repeated in tiles 38/39 x 21/22).
  Object.freeze({id:345709,map:'Kalimdor',path:'world\\kalimdor\\hyjal\\passivedoodads\\theworldtree\\theworldtree.mdx',position:fromMddf(20578.3125,1565.455078125,11605.11328125),rotation:[0,206.92726135253906,0],scale:1}),
]);

/** Landmark range in yards: beyond the horizon the bend/depth test hides them, so this only bounds the selection work. */
export const LANDMARK_RADIUS=150000;

const MAP_NUMBER={Azeroth:0,Kalimdor:1};

/** Scene placements (parsePlacements metadata JSON) for one map number, flagged so the scene selects them at any range. */
export function landmarkPlacements(map) {
  return LANDMARKS.filter(l=>MAP_NUMBER[l.map]===map)
    .map(({id,path,position,rotation,scale})=>({id,kind:'m2',path,position:[...position],rotation:[...rotation],scale,landmark:true}));
}
