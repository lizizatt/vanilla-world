# Sim time contract

One authoritative clock, `SimClock` in `sim-clock.js`, owned by `WorldRenderer` (`renderer.clock`).

- `clock.now()` – sim time of day in minutes, period `DAY_PERIOD` = 2880. 1440 = noon (sun overhead), 0 = midnight.
- `clock.dt` – sim minutes elapsed this frame (real `dt` × scale / 60); 0 when paused.
- `scale` – sim seconds per real second: 0 (pause), 1, 10, 100, 1000. Stored in `settings.timeScale`, persisted in
  `localStorage` (`racer.timeScale`) and carried in the F8 pose link (`time` + `settings.timeScale`).
- `timeLock` (pose import / test hook) pins `now()`; the clock keeps running underneath so unlocking resumes.
- Night toggle eases the clock to midnight/noon (`easeTo`), then free-runs.

Sun direction is `sunDirection(timeOfDay)` (clouds.js) and is the single source for the sky, cloud march, planet
terminator (`spaceUniform`), craft shadow direction/strength, and `daylight` (`daylightAt(now)`). The planet terminator
therefore follows the sun both from the surface and from orbit.

Real time (unscaled): physics/worker sim, camera, audio engine, UI, input, frame guards, fade timers, particles.
Sim time (scaled): sun/moon, sky colours, zone lighting hour blend, shadows. Cloud flow/Maelstrom animate with the
wall-clock `time` argument and are intentionally not scaled yet; to scale them, multiply that accumulator by
`clock.scale` in `drawClouds` (cloud agent's files). NPC wander and race timers stay real time.
