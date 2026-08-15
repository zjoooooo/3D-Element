import { settings, ELEMENTS } from '../config/settings.js';
import { PASSIVES } from './Modifiers.js';

/**
 * What the level-up can offer (spec §6 卡池).
 *
 * Candidates are generated fresh from the live loadout + modifiers every draw:
 * upgrades for seated skills that aren't maxed, new actives while a seat is
 * open, generic passives below their caps. Weighted sampling without
 * replacement gives up to three distinct cards; milestone levels bump a new
 * active into the hand while one exists, a ripe sheng pair bumps its fusion
 * gold card in the same way (spec 条件达成必出), and a completely full build
 * simply draws nothing — the UI turns that into the skip-heal.
 */
const UPGRADE_BODY = '伤害 +25%';

export class UpgradePool {
  constructor(rng, loadout, modifiers) {
    this.rng = rng;
    this.loadout = loadout;
    this.modifiers = modifiers;
  }

  draw(level, sinceLevel = level, onlyWuxing = null) {
    const w = settings.upgrades.passiveWeights;
    const candidates = [];

    for (const element of this.loadout.equippedList()) {
      if (this.loadout.isMaxed(element)) continue;
      candidates.push({
        weight: w.upgrade,
        card: {
          kind: 'upgrade',
          element,
          title: `升级 · Lv${this.loadout.levelOf(element) + 1}`,
          body: UPGRADE_BODY
        }
      });
    }

    if (this.loadout.hasEmpty()) {
      for (const element of ELEMENTS) {
        if (this.loadout.has(element)) continue;
        candidates.push({
          weight: w.newActive,
          card: { kind: 'new', element, title: '新技能', body: '进入下一个空位' }
        });
      }
    }

    for (const [id, meta] of Object.entries(PASSIVES)) {
      if (this.modifiers.passiveLevel(id) >= meta.max) continue;
      candidates.push({
        weight: w.passive,
        card: {
          kind: 'passive',
          passive: id,
          title: meta.name,
          body: `${meta.name} Lv${this.modifiers.passiveLevel(id) + 1}`
        }
      });
    }

    // A shard's directed hand (spec 残章): only the shard's own wuxing may
    // appear, and a passive never carries an element, so it sits out entirely.
    if (onlyWuxing !== null) {
      for (let i = candidates.length - 1; i >= 0; i--) {
        const card = candidates[i].card;
        const keep =
          card.kind !== 'passive' &&
          settings.combat.wuxingOf[card.element] === onlyWuxing;
        if (!keep) candidates.splice(i, 1);
      }
    }

    const hand = [];
    const wantNew =
      settings.upgrades.milestones.some((m) => m > sinceLevel - 1 && m <= level) &&
      candidates.some((c) => c.card.kind === 'new');
    if (wantNew) {
      hand.push(this._take(candidates.filter((c) => c.card.kind === 'new'), candidates));
    }

    // A ripe sheng pair guarantees its gold card too (spec 条件达成必出),
    // slotted with the same priority as the milestone above. A shard's
    // directed hand never carries one — it only deals that one wuxing's cards.
    if (onlyWuxing === null) {
      const fusionCard = this._fusionCard();
      if (fusionCard) hand.push(fusionCard);
    }

    while (hand.length < 3 && candidates.length > 0) {
      hand.push(this._take(candidates, candidates));
    }
    return hand;
  }

  /** The one guaranteed fusion card, or null if nothing's ripe. Kept off the
   * general `candidates` pool so it can never be drawn a second time there. */
  _fusionCard() {
    const eligible = this.loadout.eligibleFusions();
    if (eligible.length === 0) return null;
    const choices = eligible.map((f) => ({
      weight: 1,
      card: { kind: 'fusion', a: f.a, b: f.b, title: f.name, body: '合而为一，腾出一席' }
    }));
    return this._take(choices, choices);
  }

  /** Weighted pick from `from`, removed from `all` so a hand never repeats. */
  _take(from, all) {
    let total = 0;
    for (const c of from) total += c.weight;
    let roll = this.rng() * total;
    let chosen = from[from.length - 1];
    for (const c of from) {
      roll -= c.weight;
      if (roll <= 0) {
        chosen = c;
        break;
      }
    }
    all.splice(all.indexOf(chosen), 1);
    return chosen.card;
  }
}
