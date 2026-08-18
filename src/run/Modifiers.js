import { settings } from '../config/settings.js';

/**
 * The run's temporary strength (spec §2 "数值分层").
 *
 * Effective value = settings base × whatever lives here. Upgrades only ever
 * write to this object and the whole thing is discarded when the run ends, so
 * the editor's sliders — the game's factory numbers — never get polluted by
 * one lucky build.
 */
export const PASSIVES = {
  swift: { name: '疾行', max: 3 },
  vitality: { name: '淬体', max: 3 },
  focus: { name: '凝神', max: 3 },
  scavenger: { name: '拾荒', max: 3 },
  echo: { name: '施法回响', max: 3 },
  reroll: { name: '时来运转', max: 3 }
};

export class Modifiers {
  constructor() {
    this.reset();
  }

  reset() {
    this._damage = Object.create(null); // element -> added multiplier
    /** 满级异化 (M9 T2): element -> Set of mutation ids taken on it. Every
     * query below folds these on top of the global passives rather than
     * replacing them, so a build's broad choices and its per-skill ones
     * compose the way a player would expect. */
    this._mutations = new Map();
    this._passives = Object.create(null); // id -> level
    this._resonance = [0, 0, 0, 0, 0]; // wuxing index -> active count
    this._quench = false; // armed until the next metal cast spends it
  }

  bumpDamage(element) {
    this._damage[element] = (this._damage[element] ?? 0) + settings.upgrades.damagePerLevel;
  }

  bumpPassive(id) {
    const level = this._passives[id] ?? 0;
    if (level >= PASSIVES[id].max) return false;
    this._passives[id] = level + 1;
    return true;
  }

  passiveLevel(id) {
    return this._passives[id] ?? 0;
  }

  damageMult(element) {
    return (1 + (this._damage[element] ?? 0)) * this._mutationMult(element, 'damage');
  }

  /* --- 满级异化 (M9 T2) --- */

  /** The product of every taken mutation's `key` multiplier, or 1. */
  _mutationMult(element, key) {
    const taken = this._mutations.get(element);
    if (!taken) return 1;
    let mult = 1;
    for (const id of taken) {
      const value = settings.upgrades.mutations[id]?.[key];
      if (value !== undefined) mult *= value;
    }
    return mult;
  }

  hasMutation(element, id) {
    return this._mutations.get(element)?.has(id) ?? false;
  }

  /** Which mutations this skill carries — array so callers can count/list. */
  mutationsOn(element) {
    return [...(this._mutations.get(element) ?? [])];
  }

  /** Room for another? The cap is per skill, not per build. */
  canMutate(element) {
    return this.mutationsOn(element).length < settings.upgrades.mutationMax;
  }

  /** Take one. Idempotent, and silently refuses past the cap — the draft
   * already gates on `canMutate`, so this is the belt to that's braces. */
  takeMutation(element, id) {
    let taken = this._mutations.get(element);
    if (!taken) { taken = new Set(); this._mutations.set(element, taken); }
    if (taken.has(id)) return;
    if (taken.size >= settings.upgrades.mutationMax) return;
    taken.add(id);
  }

  moveSpeedMult() {
    return 1 + settings.upgrades.swiftPerLevel * this.passiveLevel('swift');
  }

  maxHpMult() {
    return 1 + settings.upgrades.vitalityPerLevel * this.passiveLevel('vitality');
  }

  xpMult() {
    return 1 + settings.upgrades.scavengerPerLevel * this.passiveLevel('scavenger');
  }

  /** @param {string} [element] M9 T2: a skill's own cooldown, once
   * mutations exist. Called with nothing it is the build-wide passive alone,
   * which is what every pre-M9 call site meant and still gets. */
  cooldownMult(element = null) {
    const global = Math.max(
      settings.upgrades.cooldownFloor,
      Math.pow(settings.upgrades.focusPerLevel, this.passiveLevel('focus'))
    );
    return element ? global * this._mutationMult(element, 'cooldown') : global;
  }

  /** @param {string} [element] M9 T2: same shape as cooldownMult above —
   * the 回响 mutation ADDS its chance to the global passive's. */
  echoChance(element = null) {
    const global = settings.upgrades.echoPerLevel * this.passiveLevel('echo');
    if (!element) return global;
    const taken = this._mutations.get(element);
    if (!taken) return global;
    let extra = 0;
    for (const id of taken) extra += settings.upgrades.mutations[id]?.echo ?? 0;
    return global + extra;
  }

  /** Recount actives per wuxing (spec §4.8). App calls after start/acquire/fuse;
   * wuxingList is the on-loadout skills' wuxing — a fused slot contributes two,
   * already expanded by the caller. */
  computeResonance(wuxingList) {
    this._resonance = [0, 0, 0, 0, 0];
    for (const wux of wuxingList) this._resonance[wux]++;
  }

  /** True once a wuxing's active count clears the resonance threshold. */
  resonates(wuxing) {
    return this._resonance[wuxing] >= settings.resonance.threshold;
  }

  /** 周天: every wuxing represented at least once. */
  cycleActive() {
    return this._resonance.every((count) => count >= 1);
  }

  /** Fire resonance rides the burn tick — CombatSystem reads this via mods?.dotMult?.(). */
  dotMult() {
    return this.resonates(3) ? settings.resonance.fireDot : 1;
  }

  /** Arms the next metal cast to land quenched. Spent via consumeQuench() at
   * every App cast write-site (_cast, _quickCastToward's plain and fusion
   * branches), which stamps the result onto ability.quenched itself (M4 I3 —
   * this comment used to claim that wiring existed before App actually did). */
  armQuench() {
    this._quench = true;
  }

  /** Spends the latch only on a metal cast (wuxingOf[element] === 0); anything else passes through unarmed. */
  consumeQuench(element) {
    if (!this._quench || settings.combat.wuxingOf[element] !== 0) return false;
    this._quench = false;
    return true;
  }
}
