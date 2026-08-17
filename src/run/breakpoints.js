// src/run/breakpoints.js — M6 T12: Lv3/Lv5 质变节点, as pure data lookups.
//
// Each skill's own settings block (`settings[element]`, NOT settings.combat)
// carries an optional `breakpoints: { lv3: {...}, lv5: {...} }` map. A tier's
// map is keyed by a semantic param name (`width`, `radius`, `damage`, `hops`,
// ...) whose value means one of three things, resolved purely by which of the
// three lookups below the *caller* uses for that param — this module never
// has to know which underlying settings field a param name actually scales:
//
//   - bpScale : the value is a MULTIPLIER (`width: 1.5` = ×1.5). Default verb.
//   - bpAdd   : the value is an INCREMENT (`hops: 2` = +2). Only for the small
//               ADDITIVE_KEYS whitelist below (spec: 加法键以 + 语义列名单) —
//               a param outside that whitelist is never additive, so bpAdd
//               reports 0 for it (identity) rather than silently adding the
//               raw table number.
//   - bpReplace: the value REPLACES the base outright (chainbolt's hopDecay
//               0.85→0.92, snare's slowFactor 0.45→0.65 — spec's own "X%→Y%"
//               phrasing, not a multiply/add). Third verb, dispatch-
//               authorized by the brief's assertions section ("if the parser
//               needs a third verb for replacement, add `=` semantics").
//               Returns `undefined` (not a number) when no tier applies —
//               callers do `bpReplace(...) ?? base`.
//   - bpFlag  : a boolean hook (ice's castTwice, meteor's extraWave) — the
//               two Lv5 mechanics no numeric table can express.
//
// Cumulative by construction: level≥3 folds in lv3's entries, level≥5 ALSO
// folds in lv5's (multipliers multiply together, adders sum, a replace picks
// the highest applicable tier) — never a replacement of one tier by the
// other. No table entry (missing skill, missing param, or level<3) reads as
// pure identity: 1 for scale, 0 for add, undefined for replace, false for flag.
//
// `level` is a plain number, supplied by the caller (typically `ability.bpLevel`
// off the shared Ability base, or `loadout.levelOf(element)` directly) — this
// module never imports Loadout and never reaches into a run; a null/absent
// level context upstream naturally resolves to a constant Lv1 by the time it
// gets here, which is identity everywhere, which is the whole sandbox contract.
//
// Zero-alloc: every lookup below is a handful of property reads and a Set
// membership test on module-level constants — no object/array/string ever
// gets built, so this is safe to call from CombatSystem's per-tick hot path.
import { settings } from '../config/settings.js';

/** Params whose breakpoint value is an increment, not a multiplier — 剑数/
 * 刃数/球数 (swordrain/bladeorbit/sunwheel's instance counts, one shared
 * `count` key) and chainbolt's `hops`. */
const ADDITIVE_KEYS = new Set(['count', 'hops']);

/** Params whose breakpoint value REPLACES the base outright — chainbolt's
 * `hopDecay` and thunder/snare's `slowFactor` (thunder gains the debuff from
 * a base of 0, snare's swaps 0.45→0.65; both are literal "X%→Y%" swaps in
 * the brief's table, not compounding math). */
const REPLACE_KEYS = new Set(['hopDecay', 'slowFactor']);

function tiers(element) {
  return settings[element]?.breakpoints;
}

/** Cumulative multiplier for `param` at `level`. 1 (identity) below Lv3, with
 * no table, or for a param that belongs to the additive/replace whitelists
 * instead (guards against a scale call landing on the wrong verb's number). */
export function bpScale(element, param, level) {
  if (ADDITIVE_KEYS.has(param) || REPLACE_KEYS.has(param)) return 1;
  const bp = tiers(element);
  if (!bp) return 1;
  let mult = 1;
  if (level >= 3 && typeof bp.lv3?.[param] === 'number') mult *= bp.lv3[param];
  if (level >= 5 && typeof bp.lv5?.[param] === 'number') mult *= bp.lv5[param];
  return mult;
}

/** Cumulative increment for `param` at `level`. 0 (identity) below Lv3, with
 * no table, or for a param outside ADDITIVE_KEYS. */
export function bpAdd(element, param, level) {
  if (!ADDITIVE_KEYS.has(param)) return 0;
  const bp = tiers(element);
  if (!bp) return 0;
  let sum = 0;
  if (level >= 3 && typeof bp.lv3?.[param] === 'number') sum += bp.lv3[param];
  if (level >= 5 && typeof bp.lv5?.[param] === 'number') sum += bp.lv5[param];
  return sum;
}

/** The replacement value for `param` at `level`, or `undefined` if no
 * applicable tier overrides it (caller falls back to its own base value).
 * Highest applicable tier wins — lv5 over lv3 — rather than compounding,
 * since "replace" has no compounding meaning. Only for REPLACE_KEYS. */
export function bpReplace(element, param, level) {
  if (!REPLACE_KEYS.has(param)) return undefined;
  const bp = tiers(element);
  if (!bp) return undefined;
  if (level >= 5 && typeof bp.lv5?.[param] === 'number') return bp.lv5[param];
  if (level >= 3 && typeof bp.lv3?.[param] === 'number') return bp.lv3[param];
  return undefined;
}

/** Is boolean hook `key` (castTwice/extraWave) armed at `level`? Checks the
 * highest applicable tier down to lv3 — today both hooks only ever live at
 * lv5, but this reads either tier so a future lv3 hook needs no new verb. */
export function bpFlag(element, key, level) {
  const bp = tiers(element);
  if (!bp) return false;
  if (level >= 5 && bp.lv5?.[key]) return true;
  if (level >= 3 && bp.lv3?.[key]) return true;
  return false;
}
