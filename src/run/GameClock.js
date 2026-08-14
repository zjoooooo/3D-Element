/**
 * Fixed-timestep accumulator (spec §2).
 *
 * Game systems tick at a constant rate no matter how the browser slices
 * frames, which keeps hit maths identical on a 60Hz laptop and a 144Hz
 * monitor — and is the ground a future lockstep mode stands on. Rendering
 * reads the leftover fraction (`alpha`) to interpolate positions.
 *
 * The accumulator is clamped so a background tab does not return with a
 * thousand queued ticks and freeze the frame it wakes on.
 */
// seconds of catch-up allowed after a stall — one second (60 ticks) bounds the
// freeze a woken background tab can cause, and is loose enough that a whole
// second delivered in one frame still ticks 60 times, which check-game relies on.
const MAX_QUEUED = 1;

export class GameClock {
  constructor(hz) {
    this.step = 1 / hz;
    this._acc = 0;
  }

  /** Feed one frame's real dt; runs `tick(step)` per whole step. Returns alpha. */
  advance(dt, tick) {
    this._acc = Math.min(this._acc + dt, MAX_QUEUED);
    while (this._acc >= this.step - 1e-9) {
      this._acc -= this.step;
      tick(this.step);
    }
    return this._acc / this.step;
  }
}
