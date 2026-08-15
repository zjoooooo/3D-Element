import { settings } from '../config/settings.js';

/**
 * The player's mortal half (spec §7).
 *
 * Contact damage, invulnerability windows and the spacebar dash all live on
 * this one small object; the character controller stays a pure puppet and
 * never learns it can die.
 */
export class PlayerState {
  constructor() {
    this.reset();
  }

  reset() {
    this.hp = settings.run.playerHp;
    /** What the hp bar measures against; upgrades may grow it in M2. */
    this.maxHp = settings.run.playerHp;
    this.alive = true;
    this.iframes = 0;
    this.dodgeCooldown = 0;
    /** {element, behavior} of whoever landed the last hit — the verdict's death line. */
    this.lastHitBy = null;
  }

  takeDamage(amount, source = null) {
    if (!this.alive || this.iframes > 0 || settings.run.godMode) return false;
    this.hp -= amount;
    this.iframes = settings.run.iframes;
    this.lastHitBy = source;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
    return true;
  }

  /** Reaction/resonance heals route through here (spec §4.6/§4.8) — a corpse
   * doesn't drink, and healing never overfills past maxHp. */
  heal(amount) {
    if (!this.alive) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  tryDodge() {
    if (!this.alive || this.dodgeCooldown > 0) return false;
    this.dodgeCooldown = settings.run.dodgeCooldown;
    this.iframes = Math.max(this.iframes, settings.run.dodgeIframes);
    return true;
  }

  tick(step) {
    this.iframes = Math.max(0, this.iframes - step);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - step);
  }
}
