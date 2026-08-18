import { settings } from '../config/settings.js';
import { bearingOf } from './Arena.js';

/**
 * 五行祭坛 (M12 T2) — the encounter layer over the five arena steles.
 *
 * The steles already exist (`Arena`) and already glow with the tide
 * (`steleGlowAt`); this class is what makes the glow MEAN something: stand
 * within `run.altar.claimRadius` of the CURRENT tide's stele for
 * `channelTime` seconds and it grants a directional hand of that element,
 * once per tide. The reward rides `RunManager.onShardHand` — the elite
 * shard's own path — so the freeze gate, the dead-run guard and the
 * empty-offer heal all come along for free.
 *
 * There is exactly one copy of the stele-placement formula in the project:
 * `Arena.bearingOf`, imported here rather than retyped, because a second
 * copy is a mirror and mirrors drift (M11's rule — the suite stands the
 * player on Arena's own spot and expects this class to notice).
 *
 * The channel is a DURATION in seconds (M8's channel rule): it accrues by
 * `step`, resets the moment the player steps out, and claims at
 * `channelTime` regardless of tick length.
 */
export class AltarSystem {
  /** @param {import('./TideSchedule.js').TideSchedule} tides unused today —
   *  tide identity arrives per tick via `tideInfo`; kept so a future altar
   *  that peeks at `nextElement` (预热碑) needs no rewiring. */
  constructor(tides = null) {
    this.tides = tides;
    /** Fired once per successful claim, with the tide element. */
    this.onClaim = null;
    this.reset();
  }

  reset() {
    /** Seconds accrued standing in the circle. */
    this._channel = 0;
    /** Tide index the claim below belongs to (tideAt's own `index`). */
    this._tideIndex = -1;
    /** Whether THIS tide's blessing is already taken. */
    this._claimed = false;
  }

  /** 0..1 of the channel, for the HUD's thin bar. 0 when idle or claimed. */
  get progress01() {
    if (this._claimed) return 0;
    return Math.min(1, this._channel / settings.run.altar.channelTime);
  }

  /**
   * @param {number} step seconds
   * @param {{index:number, element:number}} tideInfo the run's own tide read
   *   (`RunManager#tide()`) — identity comes from here, never a second clock
   * @param {{x:number,z:number}} playerPos
   */
  tick(step, tideInfo, playerPos) {
    // A new tide re-arms the altar and moves it to the new element's stele.
    // Consecutive tides always differ in index (0..4 cycling, endless wraps
    // 4→0 included), so index change is the whole detection.
    if (tideInfo.index !== this._tideIndex) {
      this._tideIndex = tideInfo.index;
      this._claimed = false;
      this._channel = 0;
    }
    if (this._claimed || !playerPos) return;

    const a = settings.run.altar;
    const b = bearingOf(tideInfo.element);
    const r = settings.run.arenaRadius;
    const dx = playerPos.x - Math.sin(b) * r;
    const dz = playerPos.z - Math.cos(b) * r;
    if (dx * dx + dz * dz <= a.claimRadius * a.claimRadius) {
      this._channel += step;
      if (this._channel >= a.channelTime) {
        this._claimed = true;
        this.onClaim?.(tideInfo.element);
      }
    } else if (this._channel > 0) {
      // Stepping out resets outright rather than draining: half a channel is
      // not a savings account, it is an interrupted ritual.
      this._channel = 0;
    }
  }
}
