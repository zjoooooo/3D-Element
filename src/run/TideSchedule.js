import { settings } from '../config/settings.js';

/**
 * The run's five 3-minute weather fronts (spec §7).
 *
 * A seeded Fisher-Yates deals the five elements into an order once per run;
 * everything else is arithmetic on elapsed seconds. Spawning asks
 * `rollElement` so 70% of a tide wears its colour and the rest keeps the
 * field mixed — a pure table, no state advances, which is what keeps it
 * assertable and (one day) lockstep-safe.
 */
export const WUXING = ['metal', 'wood', 'water', 'fire', 'earth'];
export const WUXING_LABEL = ['金', '木', '水', '火', '土'];
/** 相克 across the cycle: BEATS[i] is the element i overcomes. */
export const BEATS = [1, 4, 3, 0, 2];

export class TideSchedule {
  constructor(rng) {
    this.order = [0, 1, 2, 3, 4];
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const swap = this.order[i];
      this.order[i] = this.order[j];
      this.order[j] = swap;
    }
    this._out = { index: 0, element: 0, progress: 0, timeLeft: 0, nextElement: 0 };
  }

  /** Which tide `elapsed` seconds sits in. Returns a reused scratch object. */
  tideAt(elapsed) {
    const len = settings.tides.length;
    const index = Math.min(this.order.length - 1, (elapsed / len) | 0);
    const out = this._out;
    out.index = index;
    out.element = this.order[index];
    out.progress = Math.min(1, (elapsed - index * len) / len);
    out.timeLeft = Math.max(0, (index + 1) * len - elapsed);
    out.nextElement = this.order[Math.min(index + 1, this.order.length - 1)];
    return out;
  }

  /** An element for one spawn: the tide's own at `bias` odds, else any other. */
  rollElement(rng, elapsed) {
    const tide = this.tideAt(elapsed).element;
    if (rng() < settings.tides.bias) return tide;
    const other = (tide + 1 + ((rng() * 4) | 0)) % 5;
    return other;
  }
}
