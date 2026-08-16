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
import { WUXING, WUXING_LABEL } from '../run/TideSchedule.js';

export const STRINGS = {
  zh: {
    // RunHud's live fields (spec §9 HUD). HP has no text field any more —
    // Task 5's glass bottle is its only readout (数字不常驻).
    'run.kills': '击杀',
    'run.level': 'Lv',
    'run.tide': '潮',
    'run.nextTide': '下潮',
    // The resonance readout (App#_resonanceText).
    'run.resonance': '共鸣',
    'run.cycleActive': '周天',
    // The dodge dot's hover title (RunHud, bottom bar's left end).
    'run.dodge': '闪避',
    // Run-mode toasts (App#_bindEvents / #_applySequence / onShardHand).
    'run.tideTurn': '潮来临',
    'run.sequenceChain': '相生轮转',
    'run.shardFizzle': '残章逸散',
    'run.noMana': '蓝量不足',
    // 禁咒 (App#_fireUltimate / RunHud's F slot hover title).
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
    'verdict.matchupHint': '克制',
    // Character-switch toasts (App#_switchCharacter — shared by the sandbox
    // editor's dropdown and the run-mode title screen's own; M6 facade debt,
    // these used to be hardcoded English regardless of language).
    'char.loading': '加载角色中…',
    'char.switched': '角色：',
    'char.loadFailed': '角色加载失败',
    // TitleScreen (spec §9/§9.5).
    'title.name': '五行降世',
    'title.lore': '「五行失序，潮汐吞界；执灯者立于法阵中央，以术法还天地清明。」',
    'title.character': '角色',
    'title.sandbox': '沙盒模式',
    'title.earthSoon': '暂缺 M6',
    'title.photosensitivity':
      '光敏提示：游戏含闪光与快速明暗变化效果；如对此敏感，请在暂停菜单开启"减闪模式"。',
    // PauseMenu (spec §9).
    'pause.title': '暂停',
    'pause.sfx': '音效',
    'pause.ui': '界面音',
    'pause.bgm': '音乐',
    'pause.reduceFlashes': '减闪模式',
    'pause.performanceMode': '性能模式',
    'pause.build': '本局构筑',
    'pause.resume': '继续',
    'pause.restart': '重开',
    'pause.toTitle': '回标题',
    // 首局按键浮层 (spec §9): each line fades once its own action fires once.
    'hint.move': 'WASD 移动',
    'hint.aim': '鼠标瞄准 · 点击施法',
    'hint.dodge': '空格闪避',
    'hint.ult': 'F 释放禁咒'
  },
  en: {
    'run.kills': 'Kills',
    'run.level': 'Lv',
    'run.tide': 'Tide',
    'run.nextTide': 'Next',
    'run.resonance': 'Resonance',
    'run.cycleActive': 'Full Cycle',
    'run.dodge': 'Dodge',
    'run.tideTurn': 'tide rising',
    'run.sequenceChain': 'Chain Bonus',
    'run.shardFizzle': 'Page scattered',
    'run.noMana': 'Not enough mana',
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
    'verdict.matchupHint': 'overcomes',
    'char.loading': 'Loading character…',
    'char.switched': 'Character: ',
    'char.loadFailed': 'Character failed to load',
    'title.name': 'Wuxing: Descent',
    'title.lore':
      'The Five Phases have fallen from balance, and the tide devours the world — the ' +
      'Lightbearer stands at the heart of the ritual circle, wielding the elements to ' +
      'restore heaven and earth.',
    'title.character': 'Character',
    'title.sandbox': 'Sandbox Mode',
    'title.earthSoon': 'Coming in M6',
    'title.photosensitivity':
      'Photosensitivity notice: this game includes flashing and rapid brightness changes. ' +
      'If sensitive, enable Reduce Flashes in the pause menu.',
    'pause.title': 'Paused',
    'pause.sfx': 'SFX',
    'pause.ui': 'UI',
    'pause.bgm': 'Music',
    'pause.reduceFlashes': 'Reduce Flashes',
    'pause.performanceMode': 'Performance Mode',
    'pause.build': 'This Run',
    'pause.resume': 'Resume',
    'pause.restart': 'Restart',
    'pause.toTitle': 'Title Screen',
    'hint.move': 'WASD to move',
    'hint.aim': 'Aim with mouse · click to cast',
    'hint.dodge': 'Space to dodge',
    'hint.ult': 'F for your ultimate'
  }
};

export function t(key) {
  const lang = settings.ui.language;
  return STRINGS[lang]?.[key] ?? STRINGS.zh[key] ?? key;
}

/** WUXING, capitalized for display ('metal' -> 'Metal'), computed once. */
const WUXING_WORD = WUXING.map((word) => word[0].toUpperCase() + word.slice(1));

/**
 * A wuxing element's display name for the current language: the glyph in zh
 * (金木水火土, `WUXING_LABEL`) or the capitalized WUXING word in en (Metal/
 * Wood/Water/Fire/Earth) — bare substitution for a context that already
 * supplies its own spacing around the result.
 */
export function wuxingWord(el) {
  return settings.ui.language === 'zh' ? WUXING_LABEL[el] : WUXING_WORD[el];
}

/**
 * An element glued onto the following `t(key)` phrase: no separator in zh
 * (金潮, matching how Chinese runs characters together with no spaces), one
 * space in en (Metal Tide) so the capitalized word doesn't jam against the
 * next one (M6 facade debt: en used to read "金Tide", a hanzi glyph
 * immediately touching latin text — see settings.ui.flashDamp's sibling fix
 * for the other M5-deferred facade debt this same task pays off).
 */
export function wuxingPhrase(el, key) {
  const sep = settings.ui.language === 'zh' ? '' : ' ';
  return `${wuxingWord(el)}${sep}${t(key)}`;
}
