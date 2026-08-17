// src/run/fusions.js — the five sheng-pair spells (spec §4.7 表)
import { settings } from '../config/settings.js';

export const FUSIONS = {
  '1+3': { name: '业火燎原' }, // 木+火
  '3+4': { name: '地心火山' }, // 火+土
  '4+0': { name: '锋岩星阵' }, // 土+金
  '0+2': { name: '霜刃洪流' }, // 金+水
  '2+1': { name: '回春雷泽' } // 水+木
};
export const fusionKey = (wuxA, wuxB) => `${wuxA}+${wuxB}`;
export const isFusionId = (id) => typeof id === 'string' && id.startsWith('fusion:');
export const fusionParents = (id) => id.slice('fusion:'.length).split('+'); // [elementA, elementB]
export const fusionId = (a, b) => `fusion:${a}+${b}`;

/** pairKeyOf's own memo — `id` → its computed key. Unbounded by construction
 * but not in practice: a fusion id is `fusion:${a}+${b}` over a fixed, small
 * element roster, so the whole id space (every FEEDS-legal (a, b) pair that
 * could ever exist) is a small constant, not something that grows with
 * playtime — CombatSystem#tick() calls pairKeyOf() once per fused ability
 * per tick (M7 T1 fix round: was re-splitting the id string every time). */
const _pairKeyCache = new Map();

/**
 * A fusion id's pair-key into `settings.fusions`/`settings.combat.fusions`
 * (spec §4.7 table) — '母wux+子wux', e.g. `fusion:thunder+fireball` → '1+3'.
 * Derived off the parents' own `wuxingOf`, not assumed: parent order in the
 * id is already 母(generating)+子(generated) (`Loadout#fuse` only ever mints
 * `fusionId(a, b)` where `a` generates `b` — see `eligibleFusions`'s own
 * FEEDS check), so this never has to sort or guess which half is which.
 */
export function pairKeyOf(id) {
  let key = _pairKeyCache.get(id);
  if (key === undefined) {
    const [a, b] = fusionParents(id);
    key = fusionKey(settings.combat.wuxingOf[a], settings.combat.wuxingOf[b]);
    _pairKeyCache.set(id, key);
  }
  return key;
}
