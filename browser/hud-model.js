// Own-art bottom HUD: engine heat is the boost reserve inverted; 0.8 matches sfx.js heatStage's warning zone.
export const hudModel = heatIn => {
  const heat = Math.min(1, Math.max(0, Number.isFinite(heatIn) ? heatIn : 0));
  return { heat, arc: Math.round((1 - heat) * 100), warn: heat >= .8, stage: heat >= .8 ? 2 : heat >= .5 ? 1 : 0 };
};
