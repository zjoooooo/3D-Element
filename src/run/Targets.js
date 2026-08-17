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

  damage(point, radius, amount, wuxing = -1, wuxingB = -1) {
    let total = 0;
    for (const p of this._populations) total += p.damage(point, radius, amount, wuxing, wuxingB);
    return total;
  }

  damageOnce(castId, point, radius, amount, wuxing = -1, wuxingB = -1) {
    let total = 0;
    for (const p of this._populations) {
      total += p.damageOnce
        ? p.damageOnce(castId, point, radius, amount, wuxing, wuxingB)
        : p.damage(point, radius, amount, wuxing, wuxingB);
    }
    return total;
  }

  slow(point, radius, factor, duration, innerRadius = 0) {
    for (const p of this._populations) p.slow?.(point, radius, factor, duration, innerRadius);
  }

  knockback(point, radius, impulse) {
    for (const p of this._populations) p.knockback?.(point, radius, impulse);
  }

  /** Vuln application over the same annulus damageRing tests (M7 T4
   * 锋岩星阵's 破甲). Optional per population, like slow/knockback above —
   * the sandbox dummies carry no vuln channel and quietly skip it. */
  applyVuln(point, innerRadius, radius, amt, time) {
    for (const p of this._populations) p.applyVuln?.(point, innerRadius, radius, amt, time);
  }

  /** Damage only within an annulus [innerRadius, radius] of point (M6 T4:
   * an aura's orbiting ring/flames/orbs occupy a band, not a filled disc).
   * Populations that don't implement it degrade to a plain disc — the same
   * quiet-degradation contract damageOnce already documents above. */
  damageRing(point, innerRadius, radius, amount, wuxing = -1, wuxingB = -1, kbScale = 1) {
    let total = 0;
    for (const p of this._populations) {
      total += p.damageRing
        ? p.damageRing(point, innerRadius, radius, amount, wuxing, wuxingB, kbScale)
        : p.damage(point, radius, amount, wuxing, wuxingB);
    }
    return total;
  }
}
