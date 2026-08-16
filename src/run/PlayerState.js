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
    this.mana = settings.run.manaMax;
    /** M6 T5 (冰晶甲/石肤): an absorption pool that eats damage before hp does.
     * `shieldT` is the sole "is it still up" clock — it decays on its own
     * (tick) and is also cut to 0 the instant the pool itself hits 0 via
     * absorption, so anything watching shieldT (ShieldSkill's own VFX, e.g.)
     * never needs to also watch `shield` separately. */
    this.shield = 0;
    this.shieldT = 0;
    /** 石肤 only: share of *absorbed* damage RunManager reflects back at a
     * toucher. Rides along with shield/shieldT as one bundle — see addShield. */
    this.reflectShare = 0;
    /** 勘误 D-M6-2: contact's own mercy window, separate from `iframes`.
     * EnemySystem's contact tick carries no cadence limiter of its own — the
     * "one full hit per ~0.5s window" design anchor (see its own doc) is
     * entirely `iframes` doing the rate-limiting downstream, on every OTHER
     * damage path. A shield absorbing a contact hit arms no iframes (by
     * design: 盾不触发无敌帧), so without this a swarm toucher standing on
     * the player grinds a shield down at 60Hz instead of one bite per
     * window. See takeDamage's own `contact` flag. */
    this.contactMercyT = 0;
  }

  /**
   * @param {boolean} contact 勘误 D-M6-2: true only for EnemySystem's own
   *   contact-tick path (RunManager's the only caller that ever passes
   *   true) — a ranged bolt stays false and is untouched by contactMercyT
   *   entirely, same as before this fix: it neither checks nor arms it,
   *   still gated only by `iframes` like every other non-contact hit.
   */
  takeDamage(amount, source = null, contact = false) {
    if (!this.alive || settings.run.godMode) return false;
    if (this.iframes > 0) return false;
    if (contact) {
      // A second contact hit inside the same window is eaten whole — no
      // shield drain, no hp, not even a partial absorb.
      if (this.contactMercyT > 0) return false;
      // Landed: arm the window now, before the shield/hp split below, so it
      // covers every outcome that split can produce (fully absorbed, a bare
      // hp hit with no shield up, or a pierce-through) — "whether it drained
      // shield, hp, or both" per the ruling.
      this.contactMercyT = settings.run.iframes;
    }

    let remaining = amount;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
      if (this.shield <= 0) {
        this.shield = 0;
        this.shieldT = 0;
        this.reflectShare = 0;
      }
      // Fully absorbed: the pool ate the whole hit, hp never moves and no
      // iframes get spent — a shield-only hit must not gate the next one
      // (contactMercyT above is the only rate limit a shield-absorbed
      // contact hit ever gets).
      if (remaining <= 0) return true;
    }
    this.hp -= remaining;
    this.iframes = settings.run.iframes;
    this.lastHitBy = source;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
    return true;
  }

  /**
   * 覆盖式取大 (M6 T5): a new cast only replaces the current shield when it's
   * at least as strong — amount, duration and reflectShare replace together
   * as one bundle, never independently-maxed, so the pool can never end up
   * mismatched with a clock or a reflect share from a completely different
   * cast (implementer's choice — the plan left "jointly or independently"
   * open; jointly is both the smaller rule and the one that can't produce a
   * Frankenstein state).
   */
  addShield(amount, duration, reflectShare = 0) {
    if (amount >= this.shield) {
      this.shield = amount;
      this.shieldT = duration;
      this.reflectShare = reflectShare;
    }
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

  spendMana(cost) {
    if (!this.alive || this.mana < cost) return false;
    this.mana -= cost;
    return true;
  }

  gainMana(amount) {
    if (!this.alive) return;
    this.mana = Math.min(settings.run.manaMax, this.mana + amount);
  }

  tick(step) {
    this.iframes = Math.max(0, this.iframes - step);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - step);
    this.contactMercyT = Math.max(0, this.contactMercyT - step);
    // Natural expiry: decay the clock, and the moment it runs out the pool
    // (and the reflect share riding with it) goes with it — same "shieldT
    // hits 0" signal a damage-side wipeout already produces in takeDamage.
    if (this.shieldT > 0) {
      this.shieldT = Math.max(0, this.shieldT - step);
      if (this.shieldT <= 0) {
        this.shield = 0;
        this.reflectShare = 0;
      }
    }
    if (this.alive) {
      this.mana = Math.min(settings.run.manaMax, this.mana + settings.run.manaRegen * step);
    }
  }
}
