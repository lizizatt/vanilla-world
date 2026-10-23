// Own-art bottom HUD: arc is heat 0-100 (no boost tank); 0.8 matches sfx.js heatStage's warning zone.
export const hudModel = heatIn => {
  const heat = Math.min(1, Math.max(0, Number.isFinite(heatIn) ? heatIn : 0));
  return { heat, arc: Math.round(heat * 100), warn: heat >= .8, stage: heat >= .8 ? 2 : heat >= .5 ? 1 : 0 };
};

// Per-engine level 0-1: the worse of shared heat and that engine's damage (1 - health); same 0.5/0.8 colour stages as the dial.
export const engineLevels = (heat, left = 1, right = 1) => [left, right].map(h => Math.min(1, Math.max(Number.isFinite(heat) ? heat : 0, Number.isFinite(h) ? 1 - h : 0, 0)));
export const levelStage = level => level >= .8 ? 2 : level >= .5 ? 1 : 0;
