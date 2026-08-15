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
}
