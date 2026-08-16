/**
 * One "things you can hit" service for every ability (spec §3).
 *
 * The sandbox registers the training dummies, the run mode registers the
 * enemy system; abilities talk to this and never know which is live. The
 * contract is the dummies' own hits/damage pair — `damage` and `damageOnce`
 * tally the hit counts each population reports, not damage dealt. Populations
 * that support per-cast dedup (`damageOnce`) or slows opt in by implementing
 * them, and the facade quietly degrades for those that don't.
 */
export class Targets {
  constructor() {
    this._populations = [];
  }

  register(population) {
    this._populations.push(population);
  }

  hits(point, radius) {
    for (const p of this._populations) if (p.hits(point, radius)) return true;
    return false;
  }

  damage(point, radius, amount, wuxing = -1) {
    let total = 0;
    for (const p of this._populations) total += p.damage(point, radius, amount, wuxing);
    return total;
  }

  damageOnce(castId, point, radius, amount, wuxing = -1) {
    let total = 0;
    for (const p of this._populations) {
      total += p.damageOnce
        ? p.damageOnce(castId, point, radius, amount, wuxing)
        : p.damage(point, radius, amount, wuxing);
    }
    return total;
  }

  slow(point, radius, factor, duration) {
    for (const p of this._populations) p.slow?.(point, radius, factor, duration);
  }

  /** Damage only within an annulus [innerRadius, radius] of point (M6 T4:
   * an aura's orbiting ring/flames/orbs occupy a band, not a filled disc).
   * Populations that don't implement it degrade to a plain disc — the same
   * quiet-degradation contract damageOnce already documents above. */
  damageRing(point, innerRadius, radius, amount, wuxing = -1) {
    let total = 0;
    for (const p of this._populations) {
      total += p.damageRing
        ? p.damageRing(point, innerRadius, radius, amount, wuxing)
        : p.damage(point, radius, amount, wuxing);
    }
    return total;
  }
}
