import { settings, ELEMENTS } from '../config/settings.js';
import { PASSIVES } from './Modifiers.js';
import { ABILITY_TYPES } from '../abilities/AbilityManager.js';
import { t } from '../ui/strings.js';

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
      const nextLevel = this.loadout.levelOf(element) + 1;
      // M6 T12: Lv3/Lv5 are 质变 breakpoints, not just another +25% — append
      // that tier's one-line description (strings `bp.<element>.lv3`/`.lv5`,
      // t() so a language flip picks it up like every other UI string).
      // M8 T2 (review catch): only a skill that actually HAS that tier gets
      // the line. The second wave ships no breakpoint tables, and an
      // unconditional append printed the raw fallback key onto the card
      // ("伤害 +25% · bp.hailstorm.lv3") — t()'s bottom rung is loud by
      // design, which is right for a missing translation and wrong for a
      // tier that legitimately doesn't exist.
      const tier = settings[element]?.breakpoints?.[`lv${nextLevel}`];
      const bp = tier ? ` · ${t(`bp.${element}.lv${nextLevel}`)}` : '';
      candidates.push({
        weight: w.upgrade,
        card: {
          kind: 'upgrade',
          element,
          title: `升级 · Lv${nextLevel}`,
          body: UPGRADE_BODY + bp
        }
      });
    }

    if (this.loadout.hasEmpty()) {
      for (const element of ELEMENTS) {
        // M6 T2: ELEMENTS carries thirteen ids with no class yet (T4-6 land
        // them) — offering one as a draft card would seat a skill that can
        // never actually cast, so the pool only draws from what can.
        if (!ABILITY_TYPES[element]) continue;
        if (this.loadout.has(element) || this.loadout.isFusedParent(element)) continue;
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
      hand.push(this._takeByCategory(candidates));
    }
    return hand;
  }

  /**
   * Pick a card the way `passiveWeights` reads: choose a CATEGORY by weight,
   * then a card uniformly inside it (M9 T1).
   *
   * The old shape pushed a per-card weight into one flat pool, which made a
   * category's share scale with how many of its cards happened to exist —
   * so registering skills silently rewrote the draft. M8's ten took
   * new-skill cards from 68% of a hand to 77% at four seats and squeezed
   * upgrades and passives to match, without a single weight being edited.
   * Categories are a fixed, tiny set, so this is the shape that makes the
   * numbers in settings mean what they say.
   *
   * A category with nothing to give simply isn't in the running, and the
   * remaining weights renormalise on their own (the roll is taken over the
   * present categories' total) — a full build with no seat to fill still
   * deals a full hand out of upgrades and passives.
   */
  _takeByCategory(candidates) {
    const w = settings.upgrades.passiveWeights;
    // Explicit table, and a throw for anything not in it (review catch). A
    // catch-all `: w.passive` would hand a brand-new card kind the passive
    // weight in silence — which is the exact failure this task exists to
    // kill, in a new shape: something joins the pool and the draft's shape
    // changes with nobody editing a number. A kind belongs here or it does
    // not draw.
    const WEIGHTS = { upgrade: w.upgrade, new: w.newActive, passive: w.passive };
    const weightOf = (kind) => {
      const weight = WEIGHTS[kind];
      if (weight === undefined) {
        throw new Error(`UpgradePool: card kind '${kind}' has no category weight — add one to settings.upgrades.passiveWeights`);
      }
      return weight;
    };

    // Which categories are actually present, and their total weight. Built
    // per draw (three times a hand, off a level-up — not a hot path).
    const kinds = [];
    let total = 0;
    for (const c of candidates) {
      if (kinds.includes(c.card.kind)) continue;
      kinds.push(c.card.kind);
      total += weightOf(c.card.kind);
    }

    let roll = this.rng() * total;
    let kind = kinds[kinds.length - 1];
    for (const k of kinds) {
      roll -= weightOf(k);
      if (roll <= 0) { kind = k; break; }
    }

    const inKind = candidates.filter((c) => c.card.kind === kind);
    return this._take(inKind, candidates);
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
