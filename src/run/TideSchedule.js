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
/** 相生 across the cycle: FEEDS[i] is the element i generates. */
export const FEEDS = [2, 3, 1, 4, 0];

export class TideSchedule {
  constructor(rng) {
    this.order = [0, 1, 2, 3, 4];
    this.reshuffle(rng);
    this._out = { index: 0, element: 0, progress: 0, timeLeft: 0, nextElement: 0 };
  }

  /** Fisher-Yates the tide order in place — construction, and one fresh deal per run. */
  reshuffle(rng) {
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const swap = this.order[i];
      this.order[i] = this.order[j];
      this.order[j] = swap;
    }
  }

  /** Which tide `elapsed` seconds sits in. Returns a reused scratch object. */
  tideAt(elapsed) {
    const len = settings.tides.length;
    // M9 T3: past the last scheduled front the order WRAPS rather than
    // clamping. Inside a scheduled run this changes nothing — the five
    // fronts exactly cover `run.duration`, so the index never reaches the
    // end — but an endless run would otherwise sit on one element forever,
    // with `timeLeft` pinned at zero and the banner frozen.
    const raw = (elapsed / len) | 0;
    const cycles = Math.floor(raw / this.order.length);
    const index = raw - cycles * this.order.length;
    const out = this._out;
    out.index = index;
    out.element = this.order[index];
    out.progress = Math.min(1, (elapsed - raw * len) / len);
    out.timeLeft = Math.max(0, (raw + 1) * len - elapsed);
    out.nextElement = this.order[(index + 1) % this.order.length];
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
