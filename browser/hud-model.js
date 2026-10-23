// Own-art bottom HUD: engine heat is the boost reserve inverted; 0.8 matches sfx.js heatStage's warning zone.
export const hudModel = boost => {
  const b = Math.min(1, Math.max(0, Number.isFinite(boost) ? boost : 1)), heat = 1 - b;
  return { heat, arc: Math.round(b * 100), warn: heat >= .8 };
};
