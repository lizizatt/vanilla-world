// Radio playlist (fan-made and community WoW songs, not the Blizzard soundtrack): YouTube video IDs and titles only (no audio or art is stored). IDs were checked against YouTube's oEmbed endpoint
// (HTTP 200 = public and embeddable). Peacebloom stays first; the player also skips any track YouTube refuses to embed at runtime.
export const RADIO_PLAYLIST = Object.freeze([
  {id: 'l0fCvz8dOtA', title: 'Peacebloom Burn Slow'},
  {id: 'uMIDcvwgJIs', title: 'Wise Tauren - Peacebloom & Alcohol'},
  {id: 'xcPW4qVMVrc', title: 'Cranius - Big Blue Dress'},
  {id: 'bBELbkJPZhw', title: 'Elite Tauren Chieftain - Power of the Horde'},
  {id: 'I3qwcxLIzvM', title: 'Storm, Earth and Fire'},
  {id: 'uvZlNQDmgdc', title: 'Elite Tauren Chieftain - I Am Murloc'},
  {id: 'w3TVkxaJ5Y8', title: 'L70ETC - Rogues Do it From Behind'},
  {id: 'w1ALcWS3E2Y', title: 'Horde For Life (WoW Parody)'},
  {id: 'VgVoB4x-elI', title: "Red and Black'in FTH (WoW Parody)"},
  {id: 'Lak9dx04xuA', title: 'The Bard Song - WoW'},
  {id: 'n4TyqYsC26g', title: "That's the World of Warcraft That You Play!"},
  {id: '-0L6sdagN6o', title: 'Vanilla Song (WoW)'},
  {id: 'dmdrvHH9Sz8', title: 'WoW Fan Song: LFG UBRS'},
  {id: '1E54wycZaYE', title: 'A Whole New World of Warcraft (Aladdin Parody)'},
].map(Object.freeze));
