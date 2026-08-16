import { settings } from '../config/settings.js';

/**
 * The forbidden word (spec §4.9 禁咒): one full-field ultimate per wuxing.
 * Charged by kills and reactions, armed at `chargeMax`, fired by whichever
 * element the run started with (Task 4 sets `wuxing` from the first loadout
 * seat). Every effect is a field-scale call into the existing
 * EnemySystem/PlayerState API at a radius that covers the whole 40m arena —
 * no dedicated VFX class, no new damage pipeline; pure logic here, fully
 * playable headless. Multi-beat effects (fire's three waves, wood's
 * heal-over-time) are scheduled by `fire()` and paid out by `tick()`.
 */
const FIELD_RADIUS = 1e3; // arena is 40m across; this just means "everyone"

export class Ultimate {
  constructor(systems) {
    this.s = systems; // { enemies, player, combat, rng } — combat/rng are for Task 4+'s VFX/audio hookups, unused here
    this.charge = 0;
    this.wuxing = -1; // home element; -1 = undecided
    this._wavesLeft = 0; // fire: waves still owed
    this._waveTimer = 0; // fire: seconds until the next owed wave
    this._healLeft = 0; // wood: seconds of heal-over-time still owed
  }

  ready() {
    return this.charge >= settings.ultimate.chargeMax;
  }

  gainKill() {
    const u = settings.ultimate;
    this.charge = Math.min(u.chargeMax, this.charge + u.chargePerKill);
  }

  gainReaction() {
    const u = settings.ultimate;
    this.charge = Math.min(u.chargeMax, this.charge + u.chargePerReaction);
  }

  /**
   * Ready plus a decided home element fires that element's field effect and
   * clears the charge; otherwise a no-op that returns false. `center` is the
   * player's position — every effect is centred on the caster, not the origin.
   */
  fire(center) {
    if (!this.ready() || this.wuxing < 0) return false;
    const u = settings.ultimate;
    const enemies = this.s.enemies;
    switch (this.wuxing) {
      case 0: // 金 万剑归宗: full-field hit, then a low-hp execute pass
        enemies.damage(center, FIELD_RADIUS, u.metal.damage, 0);
        enemies.executeBelow(center, FIELD_RADIUS, u.metal.executeHp);
        break;
      case 1: // 木 世界树: field slow now; the heal drip is paid out by tick()
        enemies.slow(center, FIELD_RADIUS, u.wood.slowFactor, u.wood.slowTime);
        this._healLeft = u.wood.healTime;
        break;
      case 2: // 水 绝对零度: full freeze, factor 1.0
        enemies.slow(center, FIELD_RADIUS, 1.0, u.water.freezeTime);
        break;
      case 3: // 火 陨星天坠: three waves, paid out by tick() at waveGap spacing
        this._wavesLeft = u.fire.waves;
        this._waveTimer = 0;
        break;
      case 4: // 土 天崩: hit + stun (approximated as a full-field slow — no stun state exists)
        enemies.damage(center, FIELD_RADIUS, u.earth.damage, 4);
        enemies.slow(center, FIELD_RADIUS, 1.0, u.earth.stunTime);
        break;
      default:
        return false;
    }
    this.charge = 0;
    return true;
  }

  /** Pays out fire()'s scheduled effects. A no-op for the other three
   * elements — they resolve entirely inside fire() and never touch these. */
  tick(step, center) {
    const u = settings.ultimate;
    if (this._wavesLeft > 0) {
      this._waveTimer -= step;
      if (this._waveTimer <= 0) {
        this._waveTimer = u.fire.waveGap;
        this.s.enemies.damage(center, FIELD_RADIUS, u.fire.damagePerWave, 3);
        this._wavesLeft--;
      }
    }
    if (this._healLeft > 0) {
      this._healLeft = Math.max(0, this._healLeft - step);
      this.s.player.heal(u.wood.healPerSecond * step);
    }
  }

  /** Clears the charge and cancels any in-flight scheduled effect. Leaves
   * `wuxing` alone — the home element is a loadout choice, not run state. */
  reset() {
    this.charge = 0;
    this._wavesLeft = 0;
    this._waveTimer = 0;
    this._healLeft = 0;
  }
}
