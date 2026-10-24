import {PLANET_RAMPS} from './space.js';

// Altitude regimes, derived in one place from the planet ramps: the terrain starts bending at `atmosphere`
// and space is fully faded in at `orbit`. Camera and HUD read the tag instead of repeating altitude literals.
export const REGIME_BANDS=Object.freeze({atmosphere:PLANET_RAMPS.bend[0],orbit:PLANET_RAMPS.space[1]});
export const regimeOf=altitude=>altitude>=REGIME_BANDS.orbit?'orbit':altitude>=REGIME_BANDS.atmosphere?'atmosphere':'ground';
