import {BEND_RANGE,SPACE_RANGE} from './terrain-transition.js';

// Altitude regimes, derived in one place from the transition ranges: the terrain starts bending at `atmosphere`
// and space is fully faded in at `orbit`. Camera and HUD read the tag instead of repeating altitude literals.
export const REGIME_BANDS=Object.freeze({atmosphere:BEND_RANGE[0],orbit:SPACE_RANGE[1]});
export const regimeOf=altitude=>altitude>=REGIME_BANDS.orbit?'orbit':altitude>=REGIME_BANDS.atmosphere?'atmosphere':'ground';
