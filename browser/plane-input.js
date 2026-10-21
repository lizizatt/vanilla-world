// Plane keyboard layout: W/S pitch up/down, A/D roll left/right (via steer), Q/E rudder left/right,
// Shift/Ctrl throttle up/down, Space boost. Arrow Up/Down alias W/S.
export function planeKeys(keys) {
  const k=code=>Number(keys.has(code));
  return {
    throttle:k('ShiftLeft')+k('ShiftRight')-k('ControlLeft')-k('ControlRight'),
    pitch:Math.max(-1,Math.min(1,k('KeyW')+k('ArrowUp')-k('KeyS')-k('ArrowDown'))),
    yaw:k('KeyE')-k('KeyQ'),
    flags:k('Space')<<1,
  };
}