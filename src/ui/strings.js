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
    'mut.quicken': '冷却 −30%',
  'mut.heavy': '伤害 +30%',
  'mut.encore': '20% 概率立即再放一次',
  'mut.overload': '伤害 +60%，冷却 +50%',
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
    // 装备即常驻 (M6 T4): the badge an aura seat shows instead of a cooldown ring.
    'run.auraBadge': '常驻',
    // 禁咒 (App#_fireUltimate / RunHud's F slot hover title).
    'ult.label': '禁咒',
    'ult.fired': '禁咒已释放',
    'ult.notReady': '禁咒未充能',
    // VerdictPanel (+ its deathLine, composed in App and passed in already-built).
    'verdict.won': '生存达成',
    'verdict.lost': '倒下了',
    'verdict.survived': '存活',
    'verdict.topSkills': '输出前三：',
    'bp.cyclonecut.lv3': '环带扩张',
    'bp.cyclonecut.lv5': '牵引更紧',
    'bp.piercelance.lv3': '枪身加宽',
    'bp.piercelance.lv5': '斩杀线翻倍',
    'bp.stormfield.lv3': '雷域扩张',
    'bp.stormfield.lv5': '落雷更密',
    'bp.thornroad.lv3': '荆棘蔓宽',
    'bp.thornroad.lv5': '缠绕加深',
    'bp.tidalsurge.lv3': '浪墙加宽',
    'bp.tidalsurge.lv5': '推力暴涨',
    'bp.hailstorm.lv3': '雹域扩张',
    'bp.hailstorm.lv5': '冰雹更重',
    'bp.flamebreath.lv3': '扇面张开',
    'bp.flamebreath.lv5': '龙息更炽',
    'bp.mortarrain.lv3': '弹坑扩张',
    'bp.mortarrain.lv5': '炮弹更沉',
    'bp.sandfield.lv3': '沙域扩张',
    'bp.sandfield.lv5': '迷障加深',
    'bp.stonepillar.lv3': '石台加宽',
    'bp.stonepillar.lv5': '震慑更久',
    'verdict.restart': '回车重开',
    'verdict.endless': 'N 键继续 · 无尽',
    'verdict.cleared': '已通关',
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
    'hint.ult': 'F 释放禁咒',

    // M6 T12 (质变节点): one punchy line per skill per tier, appended to the
    // Lv3/Lv5 upgrade card's body (UpgradePool#draw). 20 skills × 2 tiers.
    'bp.ice.lv3': '冰锋加宽',
    'bp.ice.lv5': '双联发射',
    'bp.thunder.lv3': '雷幅加宽',
    'bp.thunder.lv5': '雷极麻痹',
    'bp.meteor.lv3': '灾星扩爆',
    'bp.meteor.lv5': '二次陨落',
    'bp.beam.lv3': '光束加宽',
    'bp.beam.lv5': '新星增辉',
    'bp.snare.lv3': '缚网扩张',
    'bp.snare.lv5': '缚网加固',
    'bp.glacier.lv3': '冰冠扩张',
    'bp.glacier.lv5': '寒意绵长',
    'bp.fireball.lv3': '爆炸扩张',
    'bp.fireball.lv5': '烈焰加威',
    'bp.swordrain.lv3': '剑雨增势',
    'bp.swordrain.lv5': '剑域扩张',
    'bp.bladeorbit.lv3': '剑域增刃',
    'bp.bladeorbit.lv5': '剑环扩张',
    'bp.dashstrike.lv3': '闪袭加程',
    'bp.dashstrike.lv5': '一闪弑神',
    'bp.chainbolt.lv3': '连锁增跳',
    'bp.chainbolt.lv5': '链势不衰',
    'bp.lifebloom.lv3': '绽放增疗',
    'bp.lifebloom.lv5': '花域扩张',
    'bp.frostnova.lv3': '新星扩张',
    'bp.frostnova.lv5': '寒霜绵长',
    'bp.iceshield.lv3': '冰甲增厚',
    'bp.iceshield.lv5': '冰甲持久',
    'bp.firering.lv3': '燃阵增宽',
    'bp.firering.lv5': '烈焰加炽',
    'bp.sunwheel.lv3': '日轮增球',
    'bp.sunwheel.lv5': '日轮疾转',
    'bp.rockspikes.lv3': '岩刺加宽',
    'bp.rockspikes.lv5': '岩刺加锋',
    'bp.boulder.lv3': '落石扩张',
    'bp.boulder.lv5': '眩晕绵长',
    'bp.quake.lv3': '震波扩张',
    'bp.quake.lv5': '震地加势',
    'bp.stoneskin.lv3': '石肤增厚',
    'bp.stoneskin.lv5': '石肤反噬'
  },
  en: {
    'mut.quicken': 'Cooldown −30%',
  'mut.heavy': 'Damage +30%',
  'mut.encore': '20% chance to cast again at once',
  'mut.overload': 'Damage +60%, cooldown +50%',
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
    'run.auraBadge': 'Passive',
    'ult.label': 'Ult',
    'ult.fired': 'Ultimate unleashed',
    'ult.notReady': 'Ultimate not charged',
    'verdict.won': 'Run Complete',
    'verdict.lost': 'You Fell',
    'verdict.survived': 'Survived',
    'verdict.topSkills': 'Top damage: ',
    'bp.cyclonecut.lv3': 'Wider ring',
    'bp.cyclonecut.lv5': 'Tighter pull',
    'bp.piercelance.lv3': 'Broader lance',
    'bp.piercelance.lv5': 'Execute floor doubled',
    'bp.stormfield.lv3': 'Wider storm',
    'bp.stormfield.lv5': 'Bolts fall faster',
    'bp.thornroad.lv3': 'Wider bramble',
    'bp.thornroad.lv5': 'Deeper tangle',
    'bp.tidalsurge.lv3': 'Wider wall',
    'bp.tidalsurge.lv5': 'Far stronger shove',
    'bp.hailstorm.lv3': 'Wider hail',
    'bp.hailstorm.lv5': 'Heavier stones',
    'bp.flamebreath.lv3': 'Wider wedge',
    'bp.flamebreath.lv5': 'Fiercer breath',
    'bp.mortarrain.lv3': 'Wider craters',
    'bp.mortarrain.lv5': 'Heavier shells',
    'bp.sandfield.lv3': 'Wider sandstorm',
    'bp.sandfield.lv5': 'Deeper blindness',
    'bp.stonepillar.lv3': 'Broader slab',
    'bp.stonepillar.lv5': 'Longer stun',
    'verdict.restart': 'Press Enter to restart',
    'verdict.endless': 'Press N to keep going · Endless',
    'verdict.cleared': 'Cleared',
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
    'hint.ult': 'F for your ultimate',

    // M6 T12: en pairs for the zh keys above — same 20×2.
    'bp.ice.lv3': 'Wider blade',
    'bp.ice.lv5': 'Twin bolts',
    'bp.thunder.lv3': 'Wider bolt',
    'bp.thunder.lv5': 'Paralyzing surge',
    'bp.meteor.lv3': 'Wider blast',
    'bp.meteor.lv5': 'Second impact',
    'bp.beam.lv3': 'Wider beam',
    'bp.beam.lv5': 'Brighter nova',
    'bp.snare.lv3': 'Wider snare',
    'bp.snare.lv5': 'Stronger hold',
    'bp.glacier.lv3': 'Wider crown',
    'bp.glacier.lv5': 'Lasting chill',
    'bp.fireball.lv3': 'Wider blast',
    'bp.fireball.lv5': 'Fiercer flame',
    'bp.swordrain.lv3': 'More blades',
    'bp.swordrain.lv5': 'Wider rain',
    'bp.bladeorbit.lv3': 'More blades',
    'bp.bladeorbit.lv5': 'Wider orbit',
    'bp.dashstrike.lv3': 'Longer dash',
    'bp.dashstrike.lv5': 'Deadlier flash',
    'bp.chainbolt.lv3': 'More hops',
    'bp.chainbolt.lv5': 'Less decay',
    'bp.lifebloom.lv3': 'Stronger bloom',
    'bp.lifebloom.lv5': 'Wider bloom',
    'bp.frostnova.lv3': 'Wider nova',
    'bp.frostnova.lv5': 'Lasting frost',
    'bp.iceshield.lv3': 'Thicker ward',
    'bp.iceshield.lv5': 'Lasting ward',
    'bp.firering.lv3': 'Wider ring',
    'bp.firering.lv5': 'Fiercer ring',
    'bp.sunwheel.lv3': 'More orbs',
    'bp.sunwheel.lv5': 'Faster spin',
    'bp.rockspikes.lv3': 'Wider spikes',
    'bp.rockspikes.lv5': 'Sharper spikes',
    'bp.boulder.lv3': 'Wider fall',
    'bp.boulder.lv5': 'Longer stun',
    'bp.quake.lv3': 'Wider quake',
    'bp.quake.lv5': 'Harder shove',
    'bp.stoneskin.lv3': 'Thicker skin',
    'bp.stoneskin.lv5': 'Sharper thorns'
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
