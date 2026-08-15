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
    return 1 + (this._damage[element] ?? 0);
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

  cooldownMult() {
    return Math.max(
      settings.upgrades.cooldownFloor,
      Math.pow(settings.upgrades.focusPerLevel, this.passiveLevel('focus'))
    );
  }

  echoChance() {
    return settings.upgrades.echoPerLevel * this.passiveLevel('echo');
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

  /** Arms the next metal cast to land quenched (App consumes and sets ability.quenched). */
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
