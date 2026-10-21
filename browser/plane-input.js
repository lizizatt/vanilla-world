// Plane keyboard layout (signs as the user flies them): S pitches up, W down, A/D roll (worker steer axis: A=+1 left, D=-1 right, as for the car), Q/E rudder left/right,
// Shift/Ctrl throttle up/down, Space boost. Arrow Up/Down alias W/S.
export function planeKeys(keys) {
  const k=code=>Number(keys.has(code));
  return {
    throttle:k('ShiftLeft')+k('ShiftRight')-k('ControlLeft')-k('ControlRight'),
    pitch:Math.max(-1,Math.min(1,k('KeyS')+k('ArrowDown')-k('KeyW')-k('ArrowUp'))),
    steer:k('KeyA')-k('KeyD'),
    yaw:k('KeyE')-k('KeyQ'),
    flags:k('Space')<<1,
  };
}