// Single source for cloud numbers: slab geometry, maelstrom, whirlpool dip, funnel and per-tier march budgets.
// clouds.js (WGSL generation), cloud-march.js (CPU mirror), ocean-mesh.js and world-engine.js (whirlpool) all read these.
export const CLOUD_ALTITUDE_FACTOR=.8;
// Mt Hyjal summit height in yards, measured from the user's Kalimdor terrain (tile bounds near Hyjal, see README "Clouds").
export const HYJAL_SUMMIT=1971;
export const CLOUD_ALTITUDE=CLOUD_ALTITUDE_FACTOR*HYJAL_SUMMIT;
export const CLOUD_THICKNESS=520;
// High tier only: how far dense storm columns grow above / below the slab (yards, at full storm density).
export const CLOUD_TOWER={up:2400,down:160};
export const CLOUD_HALF_SIZE=250000;
// Tunables in yards / radians per second. Arms rotate counter-clockwise as seen on the world map (north up).
// The storm was authored for the 42,781 yd planet; it scales with the planet (whirlpool dip stays, it is physics).
export const STORM_SCALE=.4;
const S=STORM_SCALE;
export const MAELSTROM={eyeRadius:2200*S,wallRadius:5200*S,radius:24000*S,arms:3,pitch:.7,spin:.012,drift:.006};
// World-map registration: the eye sits 43% of the way from Kalimdor's east coast to the Eastern Kingdoms' west coast,
// and at 35% / 40% of the way down each continent's tile rows, averaged because the two continents are offset provisionally.
export const MAELSTROM_MAP={across:.43,kalimdorDown:.35,easternDown:.4};
/** Kalimdor's row was moved this far north (yd) when Orgrimmar was levelled with the Maelstrom; the Maelstrom keeps its earlier z by adding it back. */
export const KALIMDOR_NORTH_SHIFT=4800;

// Whirlpool dip, the single source of truth for JS and Rust (set_whirlpool in voyage.rs): the ocean surface at distance r
// from the centre sits depth*(1-(r/radius)^2)^2 yd below sea level (zero value and slope at the rim). The funnel ends at the bottom.
export const WHIRLPOOL_DIP={radius:1800,depth:380};

// Funnel: a tapered, rotating column rising far above the sheet at the maelstrom centre (yards). Tunable.
// The column continues below the sheet down to sea level, flaring into a mist skirt (skirtRadius) at the whirlpool.
export const FUNNEL={top:7500*S,seaLevel:-WHIRLPOOL_DIP.depth,skirtRadius:1700*S,baseRadius:500*S,baseDensity:.12,sparseHeight:2200*S,topRadius:3200*S,flare:1.5,spin:.5,twist:5,fadeStart:90000,fadeEnd:170000};

// Funnel march steps are the same on every tier.
export const FUNNEL_STEPS=14;
// Per-tier march budget: sheet steps, tower extents (High only) and the minimum ray span before the distance-proportional cap.
export const TIERS=Object.freeze({
standard:Object.freeze({steps:8,tower:Object.freeze({up:0,down:0}),minSpan:9000}),
high:Object.freeze({steps:28,tower:CLOUD_TOWER,minSpan:40000}),
});
export const tier=high=>high?TIERS.high:TIERS.standard;
