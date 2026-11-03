// Radio playlist: YouTube video IDs and titles only (no audio or art is stored). IDs were checked against YouTube's oEmbed endpoint
// (HTTP 200 = public and embeddable). Peacebloom stays first; the player also skips any track YouTube refuses to embed at runtime.
export const RADIO_PLAYLIST = Object.freeze([
  {id: 'l0fCvz8dOtA', title: 'Peacebloom Burn Slow'},
  {id: 'uMIDcvwgJIs', title: 'Wise Tauren - Peacebloom & Alcohol'},
  {id: 'cx0CFEbsVdk', title: 'Vanilla Login Screen'},
  {id: 'bXQLPZ8nHfI', title: 'Legends of Azeroth (Main Title)'},
  {id: 'MW4fASDkQXA', title: 'Elwynn Forest'},
  {id: 'roMWEeV2P4U', title: 'Stormwind'},
  {id: 'aFbCofgwdXo', title: 'Ironforge'},
  {id: 'jpb1nH2q_0k', title: 'Duskwood'},
  {id: 'Gli5allDOa8', title: "Stranglethorn Vale and Zul'Gurub"},
  {id: 'L_QA-ZUAOHk', title: 'Orgrimmar'},
  {id: 'YONdeDeSgrQ', title: 'The Barrens'},
  {id: 'q8PqlJBeuT0', title: 'Mulgore'},
  {id: 'VRE1WjivRaU', title: 'Thunder Bluff'},
  {id: 'WaG9K6Agx-0', title: 'Undercity'},
  {id: 'wLY-5S-6xuY', title: 'Darnassus'},
  {id: 'BV-v9bdMQp0', title: 'Teldrassil'},
  {id: 'rbM0eGQepgc', title: 'Moonglade'},
  {id: 'G2dq7zL-O5g', title: 'Taverns of Azeroth'},
].map(Object.freeze));
