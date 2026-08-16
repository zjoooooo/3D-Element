// src/run/manaGate.js — M6 T3: the pre-cast mana gate, as pure math.
//
// Kept out of App.js so the cost/afford rules (legacy-absent, fusion-max,
// demo/echo exemption) are assertable headlessly (check-game.mjs) without a
// live App/PlayerState. App calls `canAffordCast` once per real cast site
// and only spends for real (`playerState.spendMana(cost)`) after seeing
// `ok === true` — this module never touches playerState beyond reading
// `.mana`, so the actual spend stays App's job, exactly once per cast.
import { settings } from '../config/settings.js';
import { isFusionId, fusionParents } from './fusions.js';

/**
 * A cast's mana price before any demo/echo exemption. Absent `manaCost`
 * (every legacy pre-M6 skill) reads as free via `?? 0` — same "structural
 * until a real value lands" reading `App#_syncBadges`'s mana dot already
 * relied on before this task gave it real data.
 *
 * Fusion cost = max(parent costs), not the sum (dispatch-authorized M6 T3
 * ruling — see task-3-report.md): the same "the slower parent sets the
 * pace" philosophy the fusion's own cooldown already uses in
 * `App#_quickCastToward` (`Math.max(settings[a].cooldown,
 * settings[b].cooldown)`), rather than a fused cast taxing both parents'
 * pools at once.
 */
export function manaCostOf(element) {
  if (isFusionId(element)) {
    const [a, b] = fusionParents(element);
    return Math.max(settings[a]?.manaCost ?? 0, settings[b]?.manaCost ?? 0);
  }
  return settings[element]?.manaCost ?? 0;
}

/**
 * Pure pre-cast affordability gate. Never spends, never mutates
 * `playerState` — only ever reads `.mana`.
 *
 * `demo` (spec §6 instant new-skill demo) and `echo` (施法回响 free re-fire)
 * both always afford, regardless of cost or current mana — matching
 * `_quickCastToward`'s own "costs nothing" contract for cooldown/quench/
 * sequence on those same two paths.
 *
 * @returns {{ok: boolean, cost: number}} `cost` is always the real price
 *   (even when `ok` is true only because of a demo/echo exemption), so a
 *   caller that needs "does this cost anything" (the HUD's static mana dot)
 *   can read it without re-deriving the fusion-max rule itself.
 */
export function canAffordCast(element, playerState, { demo = false, echo = false } = {}) {
  const cost = manaCostOf(element);
  if (cost <= 0 || demo || echo) return { ok: true, cost };
  return { ok: playerState.mana >= cost, cost };
}
