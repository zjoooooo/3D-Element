/**
 * Bilingual string table (spec §9). Default Chinese; English is the fallback
 * language, not the default — `settings.ui.language` starts 'zh'.
 *
 * `t(key)` is the only way any new UI text should reach the screen from here
 * on: it reads `settings.ui.language` live (so a language flip is visible on
 * the very next frame, same as every other settings-driven system in this
 * project) and falls back current → zh → the key itself, loud but never
 * throwing — a missing translation reads as a raw key on screen instead of
 * crashing the run.
 *
 * Keys carry no punctuation or surrounding whitespace of their own where a
 * caller composes them with numbers or other keys (`run.kills` is just
 * '击杀'/'Kills' — the call site adds the space before the count, exactly as
 * the hardcoded string did). A key that terminates a phrase (a colon, a full
 * sentence) keeps that punctuation baked in, again matching what the literal
 * it replaces used to carry.
 */
import { settings } from '../config/settings.js';

export const STRINGS = {
  zh: {
    // RunHud's five live fields (spec §9 HUD).
    'run.hp': 'HP',
    'run.kills': '击杀',
    'run.level': 'Lv',
    'run.tide': '潮',
    'run.nextTide': '下潮',
    // The resonance readout (App#_resonanceText).
    'run.resonance': '共鸣',
    'run.cycleActive': '周天',
    // Run-mode toasts (App#_bindEvents / #_applySequence / onShardHand).
    'run.tideTurn': '潮来临',
    'run.sequenceChain': '相生轮转',
    'run.shardFizzle': '残章逸散',
    // 禁咒 (App#_fireUltimate / RunHud's ult field).
    'ult.label': '禁咒',
    'ult.fired': '禁咒已释放',
    'ult.notReady': '禁咒未充能',
    // VerdictPanel (+ its deathLine, composed in App and passed in already-built).
    'verdict.won': '生存达成',
    'verdict.lost': '倒下了',
    'verdict.survived': '存活',
    'verdict.topSkills': '输出前三：',
    'verdict.restart': '回车重开',
    'verdict.diedTo': '死于：',
    'verdict.behaviors': ['涌兽', '吐息者', '磐兽'],
    'verdict.rangedDeath': '吐息者的弹幕——它们怕近身',
    'verdict.elementSuffix': '系',
    'verdict.matchupHint': '克制'
  },
  en: {
    'run.hp': 'HP',
    'run.kills': 'Kills',
    'run.level': 'Lv',
    'run.tide': 'Tide',
    'run.nextTide': 'Next',
    'run.resonance': 'Resonance',
    'run.cycleActive': 'Full Cycle',
    'run.tideTurn': 'tide rising',
    'run.sequenceChain': 'Chain Bonus',
    'run.shardFizzle': 'Page scattered',
    'ult.label': 'Ult',
    'ult.fired': 'Ultimate unleashed',
    'ult.notReady': 'Ultimate not charged',
    'verdict.won': 'Run Complete',
    'verdict.lost': 'You Fell',
    'verdict.survived': 'Survived',
    'verdict.topSkills': 'Top damage: ',
    'verdict.restart': 'Press Enter to restart',
    'verdict.diedTo': 'Slain by: ',
    'verdict.behaviors': ['Swarmer', 'Spitter', 'Tank'],
    'verdict.rangedDeath': 'a spitter\'s volley — they fear the close fight',
    'verdict.elementSuffix': ' ',
    'verdict.matchupHint': 'overcomes'
  }
};

export function t(key) {
  const lang = settings.ui.language;
  return STRINGS[lang]?.[key] ?? STRINGS.zh[key] ?? key;
}
