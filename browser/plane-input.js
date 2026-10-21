// Plane keyboard layout (signs as the user flies them): S pitches up, W down, A/D roll (D=+steer), Q/E rudder left/right,
// Shift/Ctrl throttle up/down, Space boost. Arrow Up/Down alias W/S.
export function planeKeys(keys) {
  const k=code=>Number(keys.has(code));
  return {
    throttle:k('ShiftLeft')+k('ShiftRight')-k('ControlLeft')-k('ControlRight'),
    pitch:Math.max(-1,Math.min(1,k('KeyS')+k('ArrowDown')-k('KeyW')-k('ArrowUp'))),
    roll:k('KeyD')-k('KeyA'),
    yaw:k('KeyE')-k('KeyQ'),
    flags:k('Space')<<1,
  };
}