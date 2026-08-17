/**
 * settings.js — the single source of truth for every tweakable value in the sandbox.
 *
 * Nothing in the renderer owns state that lives here: shaders, particle systems,
 * lights and post processing all *read* these objects every frame. That is what
 * makes the real-time editor work without rebuilding anything — mutating a field
 * is immediately visible on screen, including on an ice field that is already
 * standing, and including while the clock is paused (`P`), which is when the
 * shapes are actually worth tuning.
 *
 * The one rule that keeps that promise: a system may only ever *sample* these
 * values. It must never copy one into a record at spawn time and read it back
 * later — see `IceAbility`, whose spike records hold nothing but unitless dice
 * rolls, and resolve every metre, radian and second against this file each frame.
 *
 * Conventions
 *  - Colours are stored as `#rrggbb` strings so lil-gui can bind them directly.
 *    Use `utils/color.js#getColor()` to read them as a cached THREE.Color.
 *  - `global` holds multipliers that scale everything at once (1 = neutral).
 *  - The per-ability blocks (`ice`, `thunder`, `meteor`, `beam`) hold absolute values.
 *
 * Every ability block is keyed by its id in `ELEMENTS`, and the shared systems
 * that need to know about "the ability the player is currently holding" — the
 * aim controller, the cooldown, the HUD — look it up as `settings[element]`.
 * The four fields they rely on being present are `range`, `minRange`, `speed`
 * and `cooldown`; everything else in a block is that ability's own business.
 * A **far cast** (`CastShape.ZONE`, declared in `ELEMENT_META`) adds a fifth:
 * `zoneRadius`, the footprint the circle indicator measures out.
 */

/**
 * The cast animations shipped alongside the rig, in `public/models/<id>.fbx`.
 *
 * Every ability block carries a `castAnim` naming one of these, so each spell
 * can throw the body differently; `CharacterController` loads all of them once
 * at boot and keeps only their clips, and the editor turns this array straight
 * into the per-ability dropdown.
 */
export const CAST_ANIMATIONS = ['cast1', 'cast2', 'cast3'];

export const settings = {
  /* ------------------------------------------------------------------ */
  /* Global multipliers                                                  */
  /* ------------------------------------------------------------------ */
  global: {
    timeScale: 1.0, // slow-mo / fast forward for the whole simulation
    speed: 1.0, // eruption travel speed multiplier
    lifetime: 1.0, // ability lifetime multiplier
    glow: 1.0, // emissive multiplier fed into bloom
    shaderIntensity: 1.0, // master strength of every procedural shader effect
    noiseStrength: 1.0,
    noiseFrequency: 1.0,
    noiseSpeed: 1.0,
    turbulence: 1.0,
    randomness: 1.0, // per-instance / per-particle jitter multiplier
    particleCount: 1.0,
    particleLifetime: 1.0,
    particleSpeed: 1.0,
    particleSize: 1.0,
    emissionRate: 1.0,
    lightIntensity: 1.0,
    lightRadius: 1.0,
    distortion: 1.0,
    fresnel: 1.0,
    opacity: 1.0,
    animationSpeed: 1.0, // character animation playback rate
    cameraShake: 1.0,
    explosionIntensity: 1.0
  },

  /* ------------------------------------------------------------------ */
  /* The aim indicator — the ground arrow drawn while the cast is armed  */
  /* ------------------------------------------------------------------ */
  /**
   * A League-style skillshot indicator: one ground quad with a signed-distance
   * arrow in its fragment shader, so every dimension below is in *metres* and
   * nothing is a texture. The quad is rebuilt from these numbers each frame,
   * which is why dragging `range` while aiming stretches the arrow live.
   */
  aim: {
    /* --- silhouette (metres) --- */
    shaftWidth: 0.42, // half-width of the shaft
    headLength: 2.6, // length of the arrowhead
    headWidth: 1.35, // half-width at the base of the head
    round: 0.12, // corner rounding of the whole silhouette
    startOffset: 0.9, // gap between the caster and the tail of the arrow

    /* --- rendering --- */
    edge: 0.09, // outline thickness, metres
    edgeGlow: 2.6, // how hard the outline blooms
    softness: 0.06, // feather on the outer edge
    fill: 0.3, // opacity of the interior wash
    fillFalloff: 1.1, // how fast the wash fades from the axis to the edge
    opacity: 1.0,

    /* --- energy running up the shaft --- */
    stripes: 0.55, // chevrons per metre
    stripeSharp: 0.62, // 0 = soft gradient, 1 = hard bars
    stripeDepth: 0.55, // how much they modulate the fill
    scrollSpeed: 2.4, // metres/second they travel toward the tip
    pulse: 0.28, // brightness breathing
    pulseSpeed: 2.2,

    /* --- frost break-up --- */
    noise: 0.45, // how much noise eats into the fill
    noiseScale: 1.6, // features per metre
    noiseSpeed: 0.35,
    crystals: 0.55, // voronoi frost plates over the interior
    crystalScale: 2.4,

    /* --- furniture --- */
    baseRing: 0.62, // radius of the ring at the caster's feet, metres
    baseRingWidth: 0.06,
    tipGlyph: 0.9, // strength of the crystal rosette at the impact point
    tipGlyphSize: 1.15, // radius of that rosette, metres
    tipSpin: 0.45, // revolutions/second
    rangeArc: 0.55, // brightness of the max-range cap
    reveal: 0.055, // seconds for the arrow to sweep out when armed

    /* --- colour --- */
    colorCore: '#ecfbff',
    colorEdge: '#3fb4ff',
    colorInvalid: '#ff6a5c', // shown when the target is inside `minRange`

    height: 0.035 // hover distance above the floor, metres
  },

  /* ------------------------------------------------------------------ */
  /* The far-cast indicator — the circle drawn at the target point       */
  /* ------------------------------------------------------------------ */
  /**
   * The other half of the targeting vocabulary. Where `aim` draws an arrow
   * along a line, this draws the **footprint**: a disc dropped at the cursor
   * with a deliberately thick boundary, because the one thing a ground-targeted
   * AoE has to answer before you click is *how much space is this going to
   * take*. The band is the answer, and the ability's own field is built to land
   * exactly on it.
   *
   * Two meshes, both parametric:
   *  - the **footprint**, a quad whose fragment shader is a signed-distance
   *    ring evaluated in metres from the target;
   *  - the **reach ring**, a ribbon strip bent into a circle at the caster's
   *    feet at `range` — a far cast needs to show where its arm ends.
   *
   * Shared by every far cast, so a new one inherits the whole indicator and
   * only brings its own `zoneRadius`.
   */
  zone: {
    /* --- the boundary (metres) --- */
    boundary: 0.34, // thickness of the band that *is* the footprint edge
    // Held under 2: the band is already the widest mark on the circle, and
    // pushing the gain past this clips it to flat white and throws away the
    // hue that says which ability you are holding.
    boundaryGlow: 1.8, // how hard it blooms
    boundaryBias: 0.35, // <0.5 grows the band inward, >0.5 outward
    liner: 0.05, // thin bright liner riding the inside of the band
    softness: 0.05, // feather on both lips

    /* --- the interior --- */
    fill: 0.22, // opacity of the wash inside the circle
    fillFalloff: 1.5, // >1 keeps the middle clear and crowds it to the rim
    rings: 2.0, // concentric contour rings across the radius
    ringWidth: 0.05,
    ringSpeed: 0.35, // how fast they travel outward, radii/second
    crawl: 0.75, // filaments crawling over the interior
    crawlScale: 1.3, // filaments per metre
    crawlSpeed: 0.45,
    noise: 0.4, // break-up eating into the wash
    noiseScale: 1.2,

    /* --- furniture --- */
    ticks: 24, // marks stepping around the boundary
    tickLength: 0.42, // how far they reach in, metres
    tickWidth: 0.2, // duty cycle, 0..1
    tickSpin: 0.06, // revolutions/second
    sweep: 0.55, // radar sweep brightness
    sweepSpeed: 0.4, // revolutions/second
    core: 0.85, // the mark at the exact target point
    coreSize: 0.4, // its radius, metres
    crosshair: 0.5, // four arms pointing out of the core
    crosshairLength: 1.1,
    pulse: 0.22, // brightness breathing
    pulseSpeed: 2.0,

    /* --- the reach ring at the caster --- */
    reach: 0.7, // brightness of the max-range circle, 0 hides it
    reachWidth: 0.05, // its half-width, metres
    reachDashes: 64, // dashes around it (0 = solid)
    reachDashGap: 0.42, // fraction of each dash that is gap
    reachSpin: 0.03, // revolutions/second the dashes creep
    reachLead: 0.9, // how much brighter the arc nearest the cursor is
    reachSegments: 192, // tessellation of that circle

    /* --- rendering --- */
    opacity: 1.0,
    reveal: 0.07, // seconds the circle takes to snap out when armed
    snap: 1.18, // how far past its radius it overshoots on the way out
    height: 0.035, // hover distance above the floor, metres

    /* --- colour --- */
    colorCore: '#eaf7ff',
    colorEdge: '#7c6bff',
    colorInvalid: '#ff6a5c' // shown when the target is inside `minRange`
  },

  /**
   * The 15-minute run. Every number here was calibrated by scripts/sim-run.mjs
   * (Monte-Carlo difficulty bands, spec §8 anchor 6) — retune by editing here
   * and re-running `npm run sim`, not by feel.
   */
  run: {
    duration: 900, // seconds per run
    tickRate: 60, // fixed simulation Hz; rendering interpolates
    enemyCap: 300, // hard on-screen ceiling; spawns beyond it are refused (recycling is a future decision)
    spawnBase: 20, // enemies per minute at minute 0
    spawnQuad: 2.2, // + quad * minute² — gentle start, fierce final tide
    spawnRadius: 26, // metres from the player enemies appear at (outside view)
    arenaRadius: 40, // playable field; matches character.roamRadius in run mode
    xpBase: 22, // xp to reach level 1...
    xpGrowth: 1.13, // ...times this per level
    gemBase: 1, // green gem value at minute 0
    gemPerMinute: 0.12, // green gems appreciate as the run ages
    magnetRadius: 2, // metres gems fly to the player from
    gemBlueMagnet: 999, // elite gems fly from anywhere（spec 全场吸附）
    playerHp: 100,
    iframes: 0.5, // seconds of invulnerability after a hit
    dodgeDistance: 3, // metres the spacebar dash covers
    dodgeIframes: 0.3,
    dodgeCooldown: 2,
    // 翻滚闪避 (M5 Task 9): sorcerer only (CHARACTERS.sorcerer.clips.roll).
    // rollSpeed is castSpeed's own pattern — the clip's playback rate, not a
    // duration. 2.37s clip → ~0.79s roll at this rate.
    rollSpeed: 3,
    // Cap, seconds: how long the dodge's displacement lerps toward its target
    // for. rollDuration/rollSpeed (~0.79s) can run longer than this — the
    // lerp finishes early and the rest of the clip just plays out in place.
    dodgeRollWindow: 0.35,
    autocastDamage: 0.85, // 自动施法: a slot left on auto pays 15% less
    // 微顿帧 (M5 Task 9): 禁咒/融合引爆/精英杀 buy the world a brief slowdown —
    // App's `_hitstop` field counts down in real seconds; while it is
    // positive, `frame()` scales the world's dt (VFX/abilities/gameClock,
    // never aim/camera/movement/cooldowns) by `hitstopFactor`. Run mode only.
    hitstopFactor: 0.85,
    hitstopDuration: 0.1, // seconds one trigger adds
    hitstopCap: 0.15, // ceiling — repeated triggers don't stack past this
    godMode: false, // debug: take no damage, everything else runs
    manaMax: 100, // 法力池容量
    manaRegen: 4, // 法力回复速率（每秒）
    manaPerKill: 1, // 击杀回蓝量
    draftLoadout: true, // run starts with seat 0 only; false = all six (debug)
    // The six abilities on stage in run mode, in slot order:
    // left mouse, right mouse, Q, E, R, T. Every id must be one of ELEMENTS;
    // whatever is missing sits out the run (M1 has no loadout screen yet — the
    // editor's dropdowns are how you change your mind).
    loadout: ['ice', 'fireball', 'thunder', 'meteor', 'beam', 'glacier']
  },

  /** UI-facing switches (spec §9/§9.5). All live; consumers read per frame. */
  ui: {
    language: 'zh', // 'zh' | 'en' — strings.js reads this
    reduceFlashes: false, // photosensitivity: scales every flash by flashDamp below when on
    // spec §9.5: reduce-flashes mode cuts flash intensity by −80% (0.2 = 20%
    // remaining). One shared constant instead of each consumer hand-rolling
    // its own ratio (M5 shipped ×0.5 at each site — M6 facade debt, unified
    // here). Read by ScreenFlash.trigger, OrbBottles' low-hp heartbeat and
    // CharacterController's i-frame flicker.
    flashDamp: 0.2,
    performanceMode: false, // halves particle/glow/shadow budgets via global multipliers
    sfxVolume: 0.8,
    uiVolume: 0.8,
    bgmVolume: 0.8 // reserved; BGM lands post-v1
  },

  /**
   * Eleven ZzFX voices (spec §10 / M5 Task 10): GameAudio.js looks each one
   * up by id, scales `params[0]` (volume) by `ui.sfxVolume` — or `.uiVolume`
   * for a `channel: 'ui'` entry — and spreads `params` straight into
   * `zzfx(...)` (see src/run/audio/zzfx.js for the full 21-slot signature;
   * a row's trailing slots just take zzfx's own defaults). `priority` feeds
   * GameAudio's per-frame throttle (>=2 survives past the base 8 plays/
   * frame, up to a hard cap of 12): the five rare, must-land events (a
   * sheng detonation, a level-up, getting hit, dying, winning) carry it,
   * the six frequent ones (the five elemental casts, a plain enemy hit)
   * don't. First-pass values, tuned by ear later via the editor — the
   * neighbourhood is what matters here: 金 sharp/high/short, 木 crackly/
   * mid, 水 round with a downward slide, 火 a noisy rumble, 土 low and heavy.
   */
  audio: {
    sounds: {
      castMetal: { params: [0.35, 0.02, 1300, 0, 0.02, 0.15, 1, 1.6, -40], channel: 'sfx', priority: 0 },
      castWood: { params: [0.3, 0.15, 480, 0, 0.03, 0.12, 4, 1, 30, 0, 0, 0, 0, 0.15], channel: 'sfx', priority: 0 },
      castWater: { params: [0.3, 0.05, 700, 0, 0.05, 0.28, 0, 1, -320], channel: 'sfx', priority: 0 },
      castFire: { params: [0.35, 0.2, 150, 0, 0.08, 0.32, 4, 1, -20, 0, 0, 0, 0, 0.3], channel: 'sfx', priority: 0 },
      castEarth: { params: [0.4, 0.05, 90, 0, 0.02, 0.22, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6], channel: 'sfx', priority: 0 },
      hit: { params: [0.22, 0.25, 220, 0, 0.015, 0.09, 1, 1.8], channel: 'sfx', priority: 0 },
      reaction: { params: [0.45, 0.1, 180, 0, 0.05, 0.35, 4, 1, -30, 0, 0, 0, 0, 0.25], channel: 'sfx', priority: 2 },
      levelup: { params: [0.35, 0, 500, 0, 0.08, 0.3, 1, 1, 0, 0, 400, 0.05], channel: 'ui', priority: 2 },
      hurt: { params: [0.4, 0.1, 140, 0, 0.02, 0.16, 3, 1.5], channel: 'sfx', priority: 2 },
      death: { params: [0.5, 0, 300, 0, 0.1, 0.6, 1, 1, -220], channel: 'sfx', priority: 2 },
      victory: { params: [0.5, 0, 400, 0, 0.15, 0.5, 1, 1, 0, 0, 320, 0.08], channel: 'sfx', priority: 2 }
    }
  },

  /** The five 3-minute tides (spec §7). Order shuffles per run, seeded. */
  tides: {
    length: 180, // seconds per tide; 5 tides fill the 15-minute run
    bias: 0.7, // share of spawns that carry the tide's element
    goldRain: { count: 30, value: 5, radius: 6 }, // tide-end gem shower
    eliteAt: [0.4, 0.75], // tide progress marks the elites spawn at
    blendSeconds: 20, // TideAtmosphere: seconds a tide turn takes to cross-fade
    // Per-wuxing weather (M5 Task 8), index-aligned with WUXING/ELEMENT_TINTS/
    // BEATS (same 金木水火土 order everywhere else). TideAtmosphere multiplies
    // these onto Environment's already-updated runtime colours each frame, so
    // they are kept close to white with one or two channels held back rather
    // than fully saturated — a saturated tint would crush the other channels
    // instead of just grading the scene.
    atmosphere: [
      { lightTint: '#ffe58c', fogTint: '#e6cc85', dustTint: '#fff2b3', dustDrift: { x: 0, z: 0 } }, // 金银屑
      { lightTint: '#8cffa3', fogTint: '#7fd191', dustTint: '#9dffb0', dustDrift: { x: 0.15, z: 0.1 } }, // 木流萤
      { lightTint: '#8ccdff', fogTint: '#7fb8e6', dustTint: '#dff2ff', dustDrift: { x: 0.3, z: -0.2 } }, // 水落雪
      { lightTint: '#ff8c59', fogTint: '#e67a4d', dustTint: '#ffb066', dustDrift: { x: 0.05, z: 0.05 } }, // 火余烬
      { lightTint: '#e6bf80', fogTint: '#d1a86e', dustTint: '#d8b878', dustDrift: { x: 0.8, z: 0.4 } } // 土沙尘
    ]
  },

  /** Elemental marks and the sheng reactions they detonate into (spec §4.6). */
  marks: {
    duration: 8, // seconds a mark clings
    reactionMult: 1.5, // detonation = triggering hit × this (spec anchor 5)
    assistSplash: { radius: 1.5, share: 0.5 }, // 助燃 木→火: splash around the victim
    sinterGems: 1, // 烧结 火→土: bonus green gems
    dewSlow: { radius: 2, factor: 0.4, duration: 1.5 }, // 凝露 金→水
    nourishHeal: 2 // 滋养 水→木
  },

  /** Build-wide auras from the loadout's wuxing spread (spec §4.8). */
  resonance: {
    threshold: 2, // same-wuxing actives needed
    metalAdvantage: 1.35, // replaces matchup.advantage while metal resonates
    woodKillHeal: 1, // hp per kill
    waterSlowDur: 1.5, // slow duration ×
    fireDot: 1.3, // fire-wuxing dot damage ×
    earthKnockback: 1.5, // shove ×
    cycleReaction: 1.5 // 周天: reaction damage × (live as of M6 T7 — earth skills seat now)
  },

  /** Sheng-pair fusion (spec §4.7). M7 retired the v1 "both parents cast
   * together, damage × budget" placeholder — each pair is now a bespoke
   * skill (`settings.fusions` / `settings.combat.fusions`, keyed by wuxing
   * pair) whose own Lv1 numbers already bake in what `budget` used to scale
   * at cast time, so only the level-up curve and the level cap live here. */
  fusion: {
    minLevel: 4, // both parents at Lv4+ unlock the gold card
    levelMult: 0.25, // + per fusion level past 1
    maxLevel: 3
  },

  /** 相生轮转: chain a generating pair within the window (spec §4.8). */
  sequence: {
    window: 4, // seconds after cast A that cast B still counts
    refund: 0.5 // B's cooldown × this
  },

  /**
   * 禁咒 (spec §4.9): one field-scale ultimate per wuxing, charged by kills
   * and reactions. Every effect rides the existing targets API at a
   * full-arena radius — no dedicated skill class.
   */
  ultimate: {
    chargeMax: 100,
    chargePerKill: 1,
    chargePerReaction: 5,
    // 万剑归宗: full-field hit, then a low-hp execute pass. `executeHp` is an
    // ABSOLUTE hp floor, not spec's 15%-of-max-hp ratio — an enemy's max hp
    // isn't retained past spawn, so a true ratio can't be reconstructed from
    // its live hp alone. 30 is ≈58% of a minute-10 swarm's max hp
    // (hpBase 20 × (1 + hpPerMinute 0.16 × 10) = 52) — deliberately far
    // above spec's 15% line, since the floor also has to matter against the
    // 40×-hp elites the ratio was really written for.
    metal: { damage: 120, executeHp: 30 },
    wood: { slowFactor: 0.85, slowTime: 4, healPerSecond: 5, healTime: 4 }, // 世界树
    water: { freezeTime: 3 }, // 绝对零度: full-field slow, factor 1.0
    fire: { waves: 3, damagePerWave: 60, waveGap: 0.4 }, // 陨星天坠
    // 天崩: 晕 approximated as a full-field slow (no stun state exists). No
    // separate knockback field — damage()'s own knockback impulse already
    // shoves everyone on a full-field hit.
    earth: { damage: 40, stunTime: 1.2 }
  },

  /** 五行法阵竞技场 (M5 Task 7): ground ritual ring + the five wuxing steles. */
  arena: {
    steleHeight: 4, // crystal stele height, metres
    steleGlow: 2.2, // emissiveIntensity of the current tide's stele
    preheatGlow: 0.7, // peak of the next tide's stele's breathing pulse
    ritualStrength: 0.35, // uRitual fed to Ground in run mode (0 in the sandbox)
    arcOpacity: 0.5 // boundary arc opacity
  },

  /**
   * The growth loop's own numbers (spec §4.5 / anchors 4). The modifier layer
   * multiplies these onto the base values above — upgrades never write into
   * any other settings block, so the sandbox and the next run stay clean.
   */
  upgrades: {
    damagePerLevel: 0.25, // each skill level past 1 adds this to the multiplier
    skipHeal: 0.1, // declining all three cards heals this fraction of max hp
    swiftPerLevel: 0.08,
    vitalityPerLevel: 0.1,
    focusPerLevel: 0.94, // multiplicative CD factor per focus level...
    cooldownFloor: 0.6, // ...never past the spec's 40% total reduction cap
    scavengerPerLevel: 0.1,
    echoPerLevel: 0.04, // 12% at max, spec's number
    skillLevelMax: 5,
    passiveWeights: { upgrade: 3, newActive: 2, passive: 1 }, // draw weights
    milestones: [5, 10, 15] // levels that guarantee a new-active card
  },

  /** Per-behaviour enemy stats. HP scales with the minute (spec anchor 3). */
  enemies: {
    hpBase: 20, // swarm HP at minute 0 — one Frost Lance, by design
    hpPerMinute: 0.16, // fractional HP growth per minute
    swarm: { speed: 3.2, radius: 0.45, contactDamage: 8, hpMult: 1, mass: 1 },
    ranged: { speed: 2.4, radius: 0.5, contactDamage: 6, hpMult: 2, mass: 0.8, holdRange: 8, fireEvery: 2.4 },
    tank: { speed: 1.4, radius: 0.7, contactDamage: 20, hpMult: 6, mass: 4 },
    /** Behaviour mix by minute: shares ramp in as the run ages (sim's 70/20/10). */
    mix: { rangedFrom: 1.5, rangedShare: 0.2, tankFrom: 3, tankShare: 0.1 },
    projectile: { speed: 7, radius: 0.3, damage: 12, life: 3 },
    // gemValue: xp a blue gem (kind 1) carries; its magnet is settings.run.gemBlueMagnet.
    elites: { hpMult: 40, scale: 1.6, damageMult: 1.5, gemValue: 15 },
    separation: 1.1, // metres of personal space the grid push maintains
    knockback: 4, // impulse metres/second per hit
    knockbackDecay: 6 // s⁻¹ exponential decay on that impulse
  },

  /**
   * How each ability's VFX maps onto damage (spec §3). Widths and radii are the
   * *visual* footprints — WYSIWYG hitting is the contract, so these reuse the
   * same numbers the shaders draw with wherever one exists.
   */
  combat: {
    ice: { kind: 'sweep', damage: 20, width: 1.4, slowFactor: 0.35, slowTime: 1.2 },
    // M6 T12: slowFactor/slowTime start inert (0 is falsy — CombatSystem's
    // sweep case never calls targets.slow() below Lv5) and breakpoints.lv5
    // REPLACEs slowFactor with 0.3, arming the existing slow channel with no
    // new mechanic — slowTime is already its intended final value (1s) from
    // the start, just unused until slowFactor turns truthy.
    thunder: { kind: 'sweep', damage: 26, width: 1.0, slowFactor: 0, slowTime: 1 },
    meteor: { kind: 'burst', damage: 55, radius: 2.6, burnDps: 12, burnTime: 2.5 },
    beam: { kind: 'lineTick', dps: 60, width: 0.9 },
    // slowTime: seconds each tick's slow lingers on an enemy
    snare: { kind: 'zoneTick', dps: 28, slowFactor: 0.45, slowTime: 0.4 },
    glacier: { kind: 'burst', damage: 70, slowFactor: 0.6, slowTime: 2.5 },
    fireball: { kind: 'self' }, // FireballAbility already resolves its own hits

    // --- M6 T2: the thirteen v1 launch skills (all thirteen classed as of T4-6) ---
    // 锚2, recalibrated (勘误 D-M6-1): damage ≈ BASE_DPS × cooldown × 形状系数
    // (窄线1.3/宽线1.0/小圈1.1/大圈0.8/自身光环0.7/弹道1.2), where BASE_DPS is
    // ice-as-played (settings.combat.ice.damage / settings.ice.cooldown = 50),
    // not spec §8's paper value (20/1.2 ≈ 16.7) — the seven legacy skills'
    // damage matches spec but their cooldowns were feel-tuned down across
    // M1-M3 (ice: spec 1.2s → live 0.4s), so live DPS runs ≈3× the paper
    // anchor. Budgeting new skills on the paper number would land them at
    // ~1/3 of legacy power. Auras have no cooldown, so they budget dps
    // directly: 50 × 0.7自身光环 = 35. Shields and the two self-resolving
    // specials (dashstrike/chainbolt) carry no damage/dps at all — see the
    // anchor-2 check in check-game.mjs for the exempt list (which now also
    // holds the seven legacy skills themselves, per the same ruling).
    swordrain: { kind: 'burst', damage: 104, radius: 4.0 }, // 50×0.8大圈×2.6 = 104
    bladeorbit: { kind: 'aura', dps: 35, radius: 2.2, band: 0.6 }, // 50×0.7自身光环 = 35
    dashstrike: { kind: 'self' }, // DashStrikeSkill (T6) resolves its own hits — mirrors fireball
    chainbolt: { kind: 'self' }, // ChainBoltSkill (T6) resolves its own hits — mirrors fireball
    lifebloom: { kind: 'burst', damage: 176, radius: 2.2, healPlayer: 8 }, // 50×1.1小圈×3.2 = 176
    frostnova: { kind: 'burst', self: true, damage: 440, radius: 3.0, slowFactor: 0.5, slowTime: 2 }, // 50×1.1小圈×8 = 440
    iceshield: { kind: 'shield', amount: 40, duration: 6 }, // exempt — shield, no damage/dps
    firering: { kind: 'aura', dps: 35, radius: 2.6, band: 0.7 }, // 50×0.7自身光环 = 35
    sunwheel: { kind: 'aura', dps: 35, radius: 3.0, band: 0.8 }, // 50×0.7自身光环 = 35
    rockspikes: { kind: 'sweep', damage: 120, width: 1.8 }, // 50×1.0宽线×2.4 = 120
    boulder: { kind: 'burst', damage: 165, radius: 2.4, stunTime: 1.6 }, // 50×1.1小圈×3.0 = 165
    quake: { kind: 'burst', self: true, damage: 320, radius: 5.0, knockback: 9 }, // 50×0.8大圈×8 = 320
    stoneskin: { kind: 'shield', amount: 55, duration: 7, reflectShare: 0.3 }, // exempt — shield, no damage/dps

    /* M8 T1: the ten second-wave rows (数值表, anchor2-checked in
     * check-game's own M8 block). Rows whose kind/fields land in a later
     * task sit inert until then — an unknown kind no-ops in tick()'s
     * switch (M7 T1 precedent), an unknown field is never read. */
    cyclonecut: { kind: 'aura', radius: 3.0, band: 0.8, dps: 80, kbMult: -1.2 }, // 磁暴: 环切 + 拽向圆心 (负拉力, T4 kbScale 语义)
    piercelance: { kind: 'self', executeBelow: 90 }, // 破军贯穿: 类内线伤 320 + 处决线 (T4 task)
    stormfield: { kind: 'self' }, // 雷暴领域: 类内落雷 (T4 task)
    thornroad: { kind: 'lineTick', dps: 55, width: 1.2, slowFactor: 0.3, slowTime: 1 }, // 荆棘之路 (slow 字段 T2 生效)
    tidalsurge: { kind: 'sweep', damage: 190, width: 2.6, knockback: 7 }, // 潮汐涌浪 (sweep kb 字段 T2 生效)
    hailstorm: {
      kind: 'burst', damage: 53.4, radius: 3.8, slowFactor: 0.25, slowTime: 1,
      waves: [
        { delay: 0, damageMult: 1, radiusMult: 0.6 },
        { delay: 0.35, damageMult: 1, radiusMult: 0.7 },
        { delay: 0.7, damageMult: 1, radiusMult: 0.8 },
        { delay: 1.05, damageMult: 1, radiusMult: 0.9 },
        { delay: 1.4, damageMult: 1, radiusMult: 1 },
        { delay: 1.75, damageMult: 1, radiusMult: 1 }
      ]
    }, // 冰雹风暴: 六波弹幕 (M7 T3 waves 机器, 纯数据)
    flamebreath: { kind: 'coneTick', dps: 200, halfAngle: 0.55, range: 5.5 }, // 烈焰喷吐 (coneTick kind T5 落地前 inert)
    mortarrain: {
      kind: 'burst', damage: 80, radius: 1.6,
      waves: [
        { delay: 0.5, damageMult: 1, radiusMult: 1 },
        { delay: 1.0, damageMult: 1, radiusMult: 1 },
        { delay: 1.5, damageMult: 1, radiusMult: 1 },
        { delay: 2.0, damageMult: 1, radiusMult: 1 },
        { delay: 2.5, damageMult: 1, radiusMult: 1 }
      ]
    }, // 流火雨: 五弹散布 (类挪 position, 地心火山机器, T6 task)
    sandfield: { kind: 'aura', radius: 4.2, band: 4.2, dps: 55, kbMult: 0, slowFactor: 0.3, slowTime: 0.8 }, // 沙暴领域: 实心研磨 + 迟钝 (aura slow 字段 T3 生效)
    stonepillar: { kind: 'burst', damage: 300, radius: 2.6, knockback: 12, stunTime: 0.5 }, // 石柱擎天: 抛飞 + 晕

    /**
     * M7 T1 skeleton: the five sheng-pair fusions' combat rows (spec §4.7
     * table), keyed by pair-key (`fusions.js#pairKeyOf`) rather than a skill
     * id — many different specific parent pairs share one wuxing pair, and
     * every one of them casts the exact same bespoke spell. `CombatSystem#
     * rowFor` resolves a fusion element through here instead of the flat
     * per-skill rows above. Numbers copied from the plan's 数值表; fields a
     * later task's own CombatSystem change still has to learn to read
     * (vulnAmt/vulnTime/the 'marsh' kind itself — `waves` learned as of M7
     * T3, see the 'burst' case's own doc) already sit here inert —
     * `tick()`'s switch `default`s to a no-op for a kind it doesn't know
     * yet, so an unimplemented row never throws, just does nothing.
     * The two self-resolved rows carry an explicit `kind: 'self'` sentinel,
     * same as `fireball`/`dashstrike`/`chainbolt` above — documents "this
     * class resolves its own hits" on purpose rather than leaving `tick()`
     * skip it as an accidental side effect of an empty object.
     */
    fusions: {
      '1+3': { kind: 'self' }, // 业火燎原 (T2, self-resolved — mirrors fireball/dashstrike/chainbolt)
      '3+4': {
        // 地心火山 (T3): one bomb's own stats — all three fire through
        // `waves` (陨石 Lv5's old bespoke extraWave branch, generalised into
        // a data table `CombatSystem`'s 'burst' case now reads natively;
        // see that file's own doc), scattered to three different landing
        // points by the class (`ability.position` moves between waves).
        kind: 'burst',
        damage: 95, radius: 2.0,
        waves: [
          { delay: 0.6, damageMult: 1, radiusMult: 1 },
          { delay: 1.5, damageMult: 1, radiusMult: 1 },
          { delay: 2.4, damageMult: 1, radiusMult: 1 }
        ],
        stunTime: 0.8
        // No burnDps/burnTime here — T1's first pass carried them, aimed at
        // the existing burst-kind burn channel below (meteor's own), but
        // that channel ticks a SINGLE point (`ability.position`) at THIS
        // row's own `radius` (2.0m). The lava pools are three separate,
        // wider (1.6m) pools sitting at the three BOMB landing points —
        // well after `ability.position` has moved on to the next wave — and
        // they outlive the wave sequence entirely (last bomb lands at
        // 2.4s, its pool still burns 4s after that). VolcanoSkill
        // self-resolves them instead (VineBlazeSkill's own zoneTick
        // pattern) — see `settings.fusions['3+4'].lavaDps/lavaRadius/
        // lavaLife`, the same 30/1.6/4 numbers moved to where the class
        // that actually owns them can read them.
      },
      // 锋岩星阵 (T4); band===radius degenerates damageRing to a solid disc
      // already. kbMult 0 = 研磨不推: the baseline per-hit shove, streamed at
      // 60 ticks/s by an aura grind, launched a converging enemy ~7m out of
      // the disc and rim-juggled it (19/180 ticks in-disc, ~33 damage where
      // the 数值表 budgets ≈319 — M7 T4 browser catch). A grind holds its
      // prey; aura rows that DON'T set kbMult keep the baseline shove
      // exactly as shipped (bladeorbit's blade-wall feel).
      '4+0': { kind: 'aura', radius: 3.5, band: 3.5, dps: 85, vulnAmt: 0.25, vulnTime: 3, kbMult: 0 },
      '0+2': { kind: 'self' }, // 霜刃洪流 (T5, self-resolved — fireball precedent)
      '2+1': { kind: 'marsh', radius: 3.5, slowFactor: 0.45, slowHold: 0.5, healInside: 6 } // 回春雷泽 (T6): tick() refreshes the slow + banks the stand-inside heal; the bolts are ThunderMarshSkill's own. slowHold (M8 T1): the refresh window, collected from T6's code literal
    },

    // 相克 lookup into TideSchedule's BEATS: which wuxing index each skill casts as.
    wuxingOf: {
      ice: 2, glacier: 2, thunder: 1, snare: 1, meteor: 3, fireball: 3, beam: 0,
      // M6 T2: 金金金木木水水火火土土土土
      swordrain: 0, bladeorbit: 0, dashstrike: 0,
      chainbolt: 1, lifebloom: 1,
      frostnova: 2, iceshield: 2,
      firering: 3, sunwheel: 3,
      rockspikes: 4, boulder: 4, quake: 4, stoneskin: 4,
      // M8 T1: 金金木木水水火火土土
      cyclonecut: 0, piercelance: 0,
      stormfield: 1, thornroad: 1,
      tidalsurge: 2, hailstorm: 2,
      flamebreath: 3, mortarrain: 3,
      sandfield: 4, stonepillar: 4
    },
    matchup: { advantage: 1.25, disadvantage: 0.8 }, // spec §1 克制/被克
    debuffs: {
      vuln: { amount: 0.15, duration: 4 }, // 断枝/破土
      vulnStrong: { amount: 0.25, duration: 4 }, // 熔甲（无暴击系统，降档强易伤）
      weak: { amount: 0.3, duration: 4 }, // 熄灭：接触/弹道 −30%
      slowAmp: { mult: 2, duration: 4, cap: 0.9 } // 淤塞：所受减速翻倍; cap: total slow ceiling
    },
    // Threat readability (spec §5.7 亮度层级): enemy bolts + spawn telegraphs
    // multiply their base colour by this so red threats outshine friendly VFX
    // in a busy fight. Read by EnemyProjectiles.js and EnemyRenderer.js
    // (telegraph rings) at material construction.
    threatEmissive: 1.6
  },

  /* ------------------------------------------------------------------ */
  /* Character                                                           */
  /* ------------------------------------------------------------------ */
  character: {
    // Which rig is on stage — a key of CHARACTERS in CharacterController.
    model: 'sorcerer',

    /* --- blending the cast clip over the idle --- */
    // The idle loops forever; a cast clip is a one-shot laid over the top of it,
    // so these are the two edges of that overlap. In fast, out soft: the throw
    // has to land on the frame you clicked, the recovery does not.
    castBlendIn: 0.12, // seconds to cross-fade from the idle into the cast
    castBlendOut: 0.3, // seconds to fall back to the idle once it finishes
    // Mixamo casts are authored at a performance's pace, not a game's — `cast3`
    // spends 1.8s winding up before the hand goes anywhere. This is the rate the
    // clip is thrown at, so it shortens the wind-up and the recovery together;
    // the spell itself has already left on the click either way.
    castSpeed: 1.5,

    /* --- how the body sells the cast --- */
    turnToAim: true, // face the arrow while aiming
    turnRate: 0.0002, // fraction of the heading gap left after 1s (lower = snappier)
    castLean: 0.34, // radians the torso pitches forward on release
    castRecoil: 0.16, // metres the body is shoved back
    castSettle: 2.6, // seconds⁻¹ the lunge decays at

    /* --- walking it around (WASD) --- */
    // Movement is camera-relative: W always goes away from the camera, so the
    // keys keep meaning the same thing after you orbit.
    //
    // The two eases are "fraction of the speed gap left after 1s", the same
    // convention as `turnRate` above — smaller is snappier. Stopping is quicker
    // than starting so the body plants instead of drifting on past the key.
    walkSpeed: 4.2, // metres/second at full tilt
    walkAccel: 0.0004, // ease onto walkSpeed while a key is held
    walkStop: 0.000002, // ease back to standing once they all let go
    turnToMove: 0.00002, // heading follow while walking; aiming overrides it
    walkLean: 0.12, // radians the body leans into a full-speed run
    // The run clip plays at travel speed / `walkSpeed`, so its stride tracks the
    // ground on its own. This trims that rate when the two disagree: raise it if
    // the feet skate forward, lower it if they scuff backwards.
    runPlayback: 1.0,
    roamRadius: 90 // metres from the origin the character is kept inside
  },

  /* ================================================================== */
  /* ICE — ability one                                                   */
  /* ================================================================== */
  /**
   * A glacial eruption: a fracture front races out along the aimed line and a
   * field of crystal spikes tears up out of the floor behind it, small and dense
   * at the caster, tall and violent at the far end.
   *
   * Everything is generated — the crystals are procedural geometry
   * (`assets/ProceduralGeometry.js`), their shading is a patched standard
   * material (`materials/IceMaterial.js`), the frost is a shader on a quad and
   * the mist, shards and glitter are GPU particles. There are no textures and no
   * meshes on disk.
   */
  ice: {
    // M6 T12 (质变节点): Lv3 widens the sweep, Lv5 is the castTwice code hook
    // (App's cast path fires a second bolt at ±8°) — see src/run/breakpoints.js.
    breakpoints: { lv3: { width: 1.5 }, lv5: { castTwice: true } },

    /* --- the cast itself --- */
    range: 15.0, // maximum cast distance, metres
    minRange: 2.5, // closer than this and the cast is refused
    speed: 26.0, // how fast the fracture front travels, metres/second
    lifetime: 3.6, // seconds the field stands before it withdraws
    cooldown: 0.4, // seconds before the ability can be armed again
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the footprint the spikes fill --- */
    widthNear: 0.55, // half-width of the band at the caster, metres
    width: 2.5, // half-width at the far end, metres
    widthCurve: 0.75, // <1 flares early, >1 stays narrow then opens out
    spikeCount: 190, // instances spent on one cast (capped at 288)
    density: 1.0, // multiplier on that count
    clumping: 1.35, // >1 pulls spikes toward the centre line
    scatter: 0.55, // extra lateral jitter, fraction of the local half-width
    frontBias: 0.85, // <1 crowds spikes toward the impact point

    /* --- silhouette of the field --- */
    heightNear: 0.5, // spike height at the caster, metres
    height: 3.1, // spike height at the far end, metres
    heightCurve: 1.7, // how late the ramp climbs
    heightJitter: 0.55,
    crown: 0.55, // how much shorter the flank blades are than the spine, 0..1
    peak: 1.45, // extra height multiplier at the impact point
    peakWidth: 0.28, // how much of the line that swell covers, 0..1
    rubble: 0.42, // fraction of the spikes demoted to ankle-height shards
    rubbleScale: 0.3,

    /* --- an individual crystal --- */
    radius: 0.41, // base radius, metres
    radiusJitter: 0.93,
    taper: 0.69, // tip radius as a fraction of the base
    facets: 7, // sides of the prism (5–8 read best)
    roughness: 0.09, // how far the facets are pushed off a clean prism
    bend: 0.66, // sideways curve from base to tip
    lean: 0.42, // radians the spikes lean away from the caster
    leanJitter: 1.5,
    twist: 1.0, // random yaw, 0..1 of a full turn

    /* --- the eruption --- */
    riseTime: 0.17, // seconds from buried to full height
    riseOvershoot: 0.26, // how far past full height the punch carries
    riseStagger: 0.09, // seconds of random delay between neighbours
    settle: 0.55, // seconds the overshoot takes to damp out
    shatterDelay: 0.6, // seconds after `lifetime` before they start to go
    sinkTime: 1.0, // seconds to withdraw into the floor

    /* --- the ice material --- */
    colorDeep: '#3e737a', // the colour thick ice accumulates toward
    colorIce: '#8adaff', // body
    colorRim: '#f2feff', // fresnel edge
    colorCore: '#638797', // the light trapped inside a fresh crystal
    opacity: 0.92,
    depthTint: 1.15, // how fast the deep tint builds with thickness
    fresnel: 2.3,
    fresnelPower: 2.4,
    translucency: 1.5, // light bleeding through from behind
    envIntensity: 0.9, // how much of the HDR probe the facets catch
    facetSharp: 0.68, // crispness of the internal facet shading
    fracture: 0.62, // internal crack planes
    fractureScale: 6.5, // cracks per metre
    veins: 0.45, // milky feather-frost inside the crystal
    veinScale: 3.2,
    // Named `glint*` rather than `sparkle*` on purpose: these are the pinpoint
    // highlights on the crystal *surface*, and the `sparkle*` family further
    // down drives the glitter *particles*. Two different effects.
    glint: 1.1,
    glintScale: 34.0,
    glintSpeed: 0.7,
    frostLine: 0.5, // rime banding climbing the crystal
    glow: 0.85, // overall emissive gain
    edgeGlow: 1.1, // brightness of the silhouette rim
    birthGlow: 1.6, // extra glow on a crystal that has just erupted
    birthFade: 0.45, // seconds that birth flash lasts

    /* --- what the ground does --- */
    frostSpread: 1.35, // frost patch radius, × the local half-width
    frostRate: 3.6, // patches laid per metre of front travel
    frostLife: 7.0, // seconds a patch lingers
    frostIntensity: 0.85,
    frostCrystals: 1.5, // grain of the packed snow
    colorFrost: '#f0f9ff', // the lit face of the snow
    colorFrostEdge: '#79b6dd', // what it goes in its own shadow
    shockRadius: 5.5, // impact shockwave ring, metres
    colorShockA: '#5fd0ff', // body of the shockwave ring
    colorShockB: '#f2feff', // its crest

    /* --- mist, shards and glitter --- */
    /**
     * Every particle system is coloured by a four-stop gradient sampled over the
     * particle's own lifetime: `A` the instant it is born, `D` as it dies. They
     * are spelled out rather than derived from the crystal palette so the fog can
     * be warmed, or the glitter recoloured, without touching the ice itself.
     */
    mistRate: 260, // rolling ground fog, particles/second
    mistSize: 1.15,
    mistSpeed: 1.3,
    mistLifetime: 2.8,
    mistOpacity: 0.05,
    mistRise: 0.35, // how fast the fog lifts, metres/second
    colorMistA: '#f2feff',
    colorMistB: '#cdefff',
    colorMistC: '#a9e4ff',
    colorMistD: '#09304c',
    shardRate: 150, // ice chips thrown off the eruption
    shardSize: 0.075,
    shardSpeed: 7.0,
    shardLifetime: 1.7,
    shardGravity: -14.0,
    colorShardA: '#f2feff',
    colorShardB: '#a9e4ff',
    colorShardC: '#a9e4ff',
    colorShardD: '#12496f',
    sparkleRate: 130, // the rising glitter plume
    sparkleSize: 0.055,
    sparkleSpeed: 3.4,
    sparkleLifetime: 2.6,
    sparkleRise: 1.6, // upward drift, metres/second
    sparkleTurbulence: 0.55,
    colorSparkleA: '#f2feff',
    colorSparkleB: '#57c9ff',
    colorSparkleC: '#a9e4ff',
    colorSparkleD: '#041e32',

    /* --- dynamic light --- */
    lightIntensity: 9,
    lightRadius: 13,
    lightColor: '#7fd4ff',

    /* --- the impact at the far end --- */
    burstSize: 3.6,
    burstIntensity: 0.75,
    burstShards: 90, // extra chips thrown at the impact
    impactShake: 0.7,
    impactFlash: 0.12,
    shakeDuration: 0.9,
    rumble: 0.06, // continuous shake while the front travels
    // The frost shell mixes A→B across its billowing noise and lays C over the
    // crystallised plates and the fresnel rim, so C is the one that reads hot.
    colorBurstA: '#a9e4ff',
    colorBurstB: '#cdefff',
    colorBurstC: '#f2feff',
    colorFlash: '#f2feff' // the full-screen flash on impact
  },

  /* ================================================================== */
  /* THUNDER — ability two                                               */
  /* ================================================================== */
  /**
   * A bolt thrown from the caster's hand along the aimed line: a bundle of
   * lightning filaments that snap into existence, hold while they gutter, and
   * blow out. Reference for the look: `thundercast.jpg`.
   *
   * The bolt is **one mesh**. Every filament is an instance of the same ribbon
   * strip, and its entire shape — the sag of the axis, the fan of the bundle,
   * the kinks in an individual strand, the camera-facing width — is evaluated in
   * the vertex shader from the numbers below. Nothing about the path exists on
   * the CPU, which is why `strands`, `jitter` and `spread` reshape a bolt that
   * is already in the air, and do it with the clock paused.
   *
   * The one thing a cast *does* capture is `uSeed`, a single random number
   * rolled at spawn so two casts do not draw the identical bolt. That is an
   * event, not a dimension — the same rule `IceAbility` follows.
   */
  thunder: {
    // M6 T12: Lv5's slowFactor/slowTime REPLACE combat.thunder's own base
    // (0/1, inert until then — see that row's own comment) rather than add,
    // so one verb (bpReplace) covers both this "0 → armed" swap and snare's
    // "0.45 → 0.65" swap below.
    breakpoints: { lv3: { width: 1.4 }, lv5: { damage: 1.3, slowFactor: 0.3 } },

    /* --- the cast --- */
    range: 24.0, // maximum cast distance, metres
    minRange: 2.0, // closer than this and the cast is refused
    speed: 105.0, // how fast the strike front travels, metres/second
    lifetime: 0.45, // seconds the bolt holds after it lands
    fadeTime: 0.5, // seconds it takes to blow out
    cooldown: 0.5,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the bolt leaves the caster --- */
    // The beam starts at the hand, not at the feet, so these are measured from
    // the caster's origin in the cast's own frame.
    handHeight: 1.28, // metres above the floor
    handForward: 0.55, // metres in front of the caster
    handSide: 0.16, // metres to the side (+ follows `Ability#side`)
    endHeight: 0.35, // height of the bolt where it lands, metres
    sag: 0.22, // metres the mid-span bows upward (negative droops)

    /* --- the bundle of filaments --- */
    strands: 9, // separate filaments (capped at 24)
    spread: 0.75, // metres the bundle fans out at the far end
    spreadNear: 0.05, // ... and at the hand
    spreadCurve: 1.6, // >1 keeps the bundle tight then opens it late
    twist: 0.45, // turns the bundle makes around the axis over its length
    twistSpeed: 0.8, // turns/second it rolls on top of that
    branchDim: 0.72, // how much dimmer an outer filament is than the spine

    /* --- the shape of one filament --- */
    jitter: 0.34, // metres of kink at the coarsest octave
    jitterScale: 0.85, // kinks per metre
    octaves: 4, // 1–5; each one halves the amplitude and doubles the rate
    jitterFalloff: 0.55, // amplitude kept per octave
    crawl: 3.2, // how fast the kinks slide along the bolt
    pinch: 0.14, // fraction of the span the ends are pulled straight over
    converge: 0.8, // how hard the far end is pulled onto the target, 0..1

    /* --- the ribbon --- */
    width: 0.025, // half-width of a filament at the hand, metres
    widthTip: 0.43, // that width at the impact point, as a fraction
    widthCurve: 1.09, // how early the taper happens
    coreWidth: 1.31, // multiplier on the central spine
    coreSharp: 4.95, // how hard the hot core falls off across the ribbon
    glowWidth: 5.7, // the halo, × the core width
    glowFalloff: 2.4, // how fast the halo fades across its ribbon
    glowOpacity: 0.49,
    softFade: 0.78, // metres of soft fade where the bolt meets geometry

    /* --- flicker & restrike --- */
    restrike: 24, // times/second the filaments re-roll their shape
    flicker: 0.3, // depth of the whole-bolt brightness stutter
    flickerSpeed: 34, // stutters/second
    strandFlash: 0.5, // how much individual filaments blink out
    tipGlow: 2.0, // extra heat on the leading edge while it travels
    tipLength: 0.08, // length of that leading edge, fraction of the span

    /* --- colour --- */
    colorCore: '#ffffff', // the centre of a filament
    colorInner: '#c9ecff',
    colorOuter: '#3aa0ff', // the outside of a filament
    colorHalo: '#0b3fc8', // the wide glow around the bundle
    glow: 2.3, // overall emissive gain
    opacity: 1.0,

    /* --- what the ground does --- */
    arcRate: 0.9, // electric burns laid per metre of front travel
    arcRadius: 1.5, // radius of one burn, metres
    arcLife: 0.6, // seconds a burn lingers
    arcIntensity: 1.0,
    arcBranches: 0.6, // how finely the burn splits into filaments
    scorchRadius: 0.5, // dark burn mark under the bolt, metres
    scorchLife: 6.5,
    scorchIntensity: 0.45,
    colorArc: '#9fdcff',
    colorScorch: '#080b11',
    colorEmber: '#4aa8ff',
    shockRadius: 6.5, // impact shockwave ring, metres
    colorShockA: '#c9ecff', // body of the shockwave ring
    colorShockB: '#ffffff', // its crest

    /* --- sparks, motes, smoke and debris --- */
    /**
     * As in `ice`: each system is coloured by a four-stop gradient sampled over
     * the particle's own lifetime, `A` at birth through `D` as it dies. Spelled
     * out rather than derived from the bolt palette, so the sparks can be made
     * to cool to orange while the filaments stay blue.
     */
    sparkRate: 240, // sparks thrown off the bolt, particles/second
    sparkSize: 0.16,
    sparkSpeed: 9.0,
    sparkLifetime: 0.5,
    sparkGravity: -12.0,
    sparkStretch: 0.18, // how far a spark smears along its velocity
    colorSparkA: '#ffffff',
    colorSparkB: '#ffffff',
    colorSparkC: '#c9ecff',
    colorSparkD: '#1e5b95',
    moteRate: 90, // the slow ionised motes drifting off the bolt
    moteSize: 0.05,
    moteSpeed: 1.5,
    moteLifetime: 1.6,
    moteRise: 1.0, // upward drift, metres/second
    moteTurbulence: 0.7,
    colorMoteA: '#ffffff',
    colorMoteB: '#c9ecff',
    colorMoteC: '#3aa0ff',
    colorMoteD: '#02195f',
    smokeRate: 50, // thin haze off the scorched floor
    smokeSize: 1.0,
    smokeSpeed: 1.1,
    smokeLifetime: 2.2,
    smokeOpacity: 0.06,
    smokeRise: 0.55,
    colorSmokeA: '#3d546e',
    colorSmokeB: '#33475e',
    colorSmokeC: '#33475e',
    colorSmokeD: '#1c2938',
    debrisRate: 24, // chips kicked off the floor under the bolt
    debrisSize: 0.055,
    debrisSpeed: 5.0,
    debrisLifetime: 1.3,
    debrisGravity: -17.0,
    colorDebrisA: '#252c36',
    colorDebrisB: '#1c222a',
    colorDebrisC: '#1c222a',
    colorDebrisD: '#1c222a',

    /* --- dynamic light --- */
    lightIntensity: 26,
    lightRadius: 17,
    lightColor: '#63b8ff',
    lightFlicker: 0.4, // depth of the light's gutter, 0 = steady
    lightFlickerSpeed: 26,

    /* --- the muzzle and the impact --- */
    // Both shells are the same shader: A→B is mixed across the billowing noise
    // and stays nearly empty, and C is what the racing filaments and the fresnel
    // rim are drawn in — so C is the one carrying the read.
    muzzleSize: 0.55, // the flash at the hand, metres
    muzzleIntensity: 1.9,
    castFlash: 0.1, // screen flash on release
    colorMuzzleA: '#3aa0ff',
    colorMuzzleB: '#c9ecff',
    colorMuzzleC: '#ffffff',
    colorCastFlash: '#c9ecff',
    burstSize: 3.0, // the shell at the impact point, metres
    burstIntensity: 1.4,
    burstSparks: 170, // extra sparks thrown at the impact
    burstDebris: 45,
    impactShake: 0.8,
    shakeDuration: 0.55,
    impactFlash: 0.28,
    rumble: 0.03, // continuous shake while the front travels
    colorBurstA: '#3aa0ff',
    colorBurstB: '#c9ecff',
    colorBurstC: '#ffffff',
    colorFlash: '#c9ecff' // the full-screen flash on impact
  },

  /* ================================================================== */
  /* METEOR — ability three                                              */
  /* ================================================================== */
  /**
   * A burning rock lobbed along the aimed line, which detonates on arrival.
   *
   * The rock is real geometry — a cratered, faceted asteroid generated by
   * `assets/ProceduralGeometry.js` — shaded by a patched standard material so it
   * casts and receives the stage's shadows. Its signature is the **lava seams**:
   * the zero crossing of an fbm field sampled in the rock's own local space, so
   * the cracks are welded to it and tumble with it. `chargeCurve` decides how
   * fast they prise open on the way in.
   *
   * Behind it hangs the **fire trail**: a black-body volume raymarched inside a
   * camera-facing proxy hull laid along the arc. See the `trail*` block.
   *
   * As in `ice` and `thunder`, a cast captures nothing but dice and timestamps:
   * one seed, one tumble axis and a few unitless rolls per debris chunk. The
   * trajectory, the size of the rock, the width of its seams and the whole
   * ballistic flight of every chunk are resolved against this block each frame —
   * which is why dragging `arc` re-lofts a meteor already in the air, and
   * dragging `chunkSpeed` re-throws debris that has already landed.
   */
  meteor: {
    // M6 T12: Lv5 is the extraWave code hook (CombatSystem's burst case
    // re-detonates once more, 0.5s later, at ×0.6) — see breakpoints.js.
    breakpoints: { lv3: { radius: 1.3 }, lv5: { extraWave: true } },

    /* --- the cast --- */
    range: 20.0, // maximum cast distance, metres
    minRange: 3.0, // closer than this and the cast is refused
    speed: 21.0, // how fast the rock travels downrange, metres/second
    lifetime: 2.2, // seconds the crater burns after the impact
    fadeTime: 1.6, // seconds everything takes to clear
    cooldown: 0.9,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight path --- */
    // The rock is thrown from a hand, so these are measured from the caster's
    // origin in the cast's own frame.
    handHeight: 1.35, // metres above the floor
    handForward: 0.6, // metres in front of the caster
    handSide: 0.2, // metres to the side (+ follows `Ability#side`)
    endHeight: 0.75, // height of the rock where it lands, metres
    arc: 2.6, // metres the mid-span lobs upward
    arcCurve: 0.85, // <1 flattens the top of the arc, >1 peaks it

    /* --- the rock --- */
    radius: 0.8, // metres
    facets: 3, // icosphere subdivisions, 0–3 (3 = 1280 triangles)
    lumpiness: 0.26, // low-frequency deformation, × the radius
    lumpScale: 1.5, // lumps per unit radius
    surfaceRoughness: 0.16, // high-frequency chipping
    cuts: 9, // planar fracture faces sliced off it
    cutDepth: 0.28, // how far in those planes bite, × the radius
    craters: 5, // impact bowls punched into it
    craterDepth: 0.18, // how deep those bowls go, × the radius
    craterSize: 0.5, // their angular radius, radians
    spin: 3.4, // tumble rate, radians/second

    /* --- the lava seams --- */
    chargeCurve: 1.6, // how late the rock heats up on its way in
    crackScale: 0.95, // seams per unit radius
    crackWidth: 0.045, // how wide a seam opens (doubled at full charge)
    crackBranches: 0.5, // strength of the finer seams splitting off
    crackGlow: 2.2,
    crackFlow: 0.7, // how much the magma brightness crawls
    crackFlowSpeed: 0.9,
    rockScale: 3.4, // mottling of the rock between the seams
    facetTint: 0.5, // per-facet value break-up — what makes it read as stone
    cavity: 0.25, // darkening down in the craters and the cut faces
    soot: 0.6, // charring either side of a seam
    rimHeat: 0.7, // heat sheath around the silhouette
    leadGlow: 0.9, // compression heat on the leading facets
    leadSharp: 2.6, // how tightly that hugs the nose
    glow: 0.75, // overall emissive gain
    envIntensity: 1.25, // how much of the HDR probe the rock catches
    colorRock: '#6e675f',
    colorChar: '#17130f',
    colorCrack: '#ff6a12',
    colorHot: '#fff3d0',

    /* --- the fire trail --- */
    /**
     * The burning wake, **raymarched as a black-body volume** — the firebending
     * stream from the freehand sandbox, re-aimed at the meteor's arc. The mesh
     * drawn is only a camera-facing proxy hull; the flame itself is integrated
     * inside it by `materials/VolumetricFireMaterial.js`, which is where the four
     * layers these controls drive (silhouette → vortex roll-up → turbulence →
     * shred) are explained.
     *
     * As with everything else here it is not a recorded history: the hull's
     * centre line is sampled straight off the trajectory, so these reshape fire
     * that is already in the air.
     *
     * The volume borrows the rock's palette — `colorHot`, `colorFlameMid`,
     * `colorFlameEdge`, `colorFlameSmoke` — but only reaches for it in
     * proportion to `trailPalette`; at 0 it is a pure Planckian radiator and the
     * colour comes out of `trailTempCore` / `trailTempEdge` instead.
     */
    trailSpan: 7.0, // metres of arc the fire covers behind the rock
    trailWidth: 0.66, // tube radius, metres
    trailHeadSize: 1.8, // fireball radius at the rock, × trailWidth
    trailPlume: 1.1, // upward stretch of the volume (buoyant elongation)
    trailWakeSpread: 0.22, // how far the spent gas behind the head has ballooned
    trailRise: 0.35, // how far the far end of the wake has floated upward, metres
    // Metre-scale lobes in the silhouette. Without these the outline stays a
    // capsule no matter how much fine turbulence is piled on top of it, and the
    // trail reads as a shaded tube.
    trailBulge: 0.18, // how far those lobes swell and pinch the local radius
    trailBulgeScale: 0.34, // lobes per metre — lower = bigger, slower shapes
    // Ring vortices shed off the head and travelling back down the wake. This is
    // what folds the field into curling, mushrooming billows; fbm alone can only
    // make clouds.
    trailVortex: 0.0, // roll-up strength
    trailRingFrequency: 0.0, // vortices per metre of stream
    trailRingSpeed: 4.0, // how fast they travel backwards
    // Kept low on purpose: rolling the noise frame hard around the axis wraps
    // the filaments circumferentially and the flame reads as concentric contour
    // lines rather than as tongues running along the flow.
    trailCurl: 0.0, // swirl of the density field around the axis
    trailTurbulence: 2.94, // noise amplitude eating into the volume
    trailWarp: 0.45, // domain warp — folds the noise into curling sheets
    trailTongue: 0.94, // < 1 stretches structures upward into licking tongues
    trailStreamStretch: 1.13, // < 1 draws them out along the flow
    // Radial shear: how far the fringe is dragged up and back relative to the
    // axis. This is what makes the edge structures read as licking tongues
    // rather than as blobs of the same shape at every radius.
    trailLick: 3.1,
    trailWisps: 0.81, // ridged filaments shredding the fringe into strands
    trailShred: 1.57, // how violently the fringe tears compared to the core
    trailOctaves: 5, // turbulence octaves (quality ↔ cost)
    trailSpeed: 4.62, // how fast the field streams backwards along the path
    trailBuoyancy: 3.5, // how fast it climbs inside the volume
    trailDetachment: 0.9, // how hard the tail tears into separate puffs
    trailNoiseStrength: 0.78,
    trailNoiseFrequency: 3.23,
    trailSoftness: 0.42, // 0 = hard tongues, 1 = a soft glow
    trailFlicker: 0.74,
    trailDensity: 2.09,
    trailSoot: 1.42, // absorption — how much the cool gas occludes
    trailCoreClarity: 0.54, // extinction left in the hottest gas (low = white blob)
    trailSteps: 35, // raymarch samples per pixel (quality ↔ cost)
    trailGlow: 3.06,
    trailOpacity: 0.96,
    trailTailFade: 0.71, // fraction of the trail that has already burnt out
    trailBurnout: 1.2, // seconds the trail takes to die after the impact
    // Temperature & radiance. The flame is shaded as a Planckian radiator: these
    // are the two ends of its temperature range in kelvin, and the exponent the
    // emitted power follows. 4 would be Stefan-Boltzmann; a little gentler keeps
    // the mid-tones off the floor at this exposure.
    trailTempCore: 1920,
    trailTempEdge: 1590,
    trailEmissionCurve: 4.79,
    trailHeatFocus: 1.54, // how fast the gas reaches full heat inside the surface
    trailHeatFalloff: 2.46, // how sharply it cools toward that surface
    // How far the turbulence is allowed to drag the temperature profile around.
    // Radiated power goes as a high power of T, so this number is amplified
    // several-fold on screen — past ~0.5 the noise's own contour lines start
    // showing through as agate banding.
    trailHeatFollow: 0.26,
    trailTailHeat: 0.36, // temperature of the spent gas at the far end of the wake
    trailPalette: 0.62, // 0 = pure black-body physics, 1 = the colour stops below
    trailScatter: 1.99, // firelight bouncing inside the sooty fringe
    trailScatterFalloff: 4.4, // how fast that bath dies away from the core
    colorFlameMid: '#ffb02e',
    colorFlameEdge: '#ff3d10',
    colorFlameSmoke: '#181616',

    /* --- the debris the rock breaks into --- */
    chunkCount: 18, // chunks thrown at the impact (capped at 28)
    chunkScale: 0.28, // their radius, × the meteor's
    chunkSpeed: 7.5, // metres/second they leave the crater at
    chunkForward: 0.55, // how far the spray is biased downrange
    chunkLoft: 1.0, // how steeply they are thrown
    chunkGravity: -17.0,
    chunkSpin: 6.0, // tumble rate, radians/second
    chunkCool: 2.6, // seconds a chunk's seams take to go out
    chunkLinger: 0.5, // seconds they lie there before sinking
    chunkSink: 1.0, // seconds to withdraw into the floor

    /* --- embers, sparks, smoke and grit --- */
    /**
     * As in `ice` and `thunder`: each system is coloured by a four-stop gradient
     * sampled over the particle's own lifetime, `A` at birth through `D` as it
     * dies. Spelled out rather than derived from the flame palette, so the
     * trail can be cooled to red while the rock itself stays white-hot.
     */
    emberRate: 180, // embers streaming off the rock, particles/second
    emberSize: 0.1,
    emberSpeed: 2.4,
    emberLifetime: 1.5,
    emberRise: 1.5, // buoyancy, metres/second
    emberGlow: 1.2,
    emberTurbulence: 0.5,
    colorEmberA: '#fff3d0',
    colorEmberB: '#ff9a2e',
    colorEmberC: '#ff3b0d',
    colorEmberD: '#2b0d05',
    sparkRate: 110, // sparks flung off it
    sparkSize: 0.14,
    sparkSpeed: 6.5,
    sparkLifetime: 0.8,
    sparkGravity: -11.0,
    sparkStretch: 0.16, // how far a spark smears along its velocity
    colorSparkA: '#fffdf2',
    colorSparkB: '#ffd27a',
    colorSparkC: '#ff6a12',
    colorSparkD: '#3d1103',
    smokeRate: 70, // the trail and the column off the crater
    smokeSize: 1.1,
    smokeSpeed: 1.2,
    smokeLifetime: 3.0,
    smokeOpacity: 0.12,
    smokeRise: 0.9,
    colorSmokeA: '#6b503f',
    colorSmokeB: '#3b2c25',
    colorSmokeC: '#241b17',
    colorSmokeD: '#141010',
    debrisSize: 0.06, // grit kicked off the floor
    debrisSpeed: 6.0,
    debrisLifetime: 1.5,
    debrisGravity: -18.0,
    colorDebrisA: '#3a322c',
    colorDebrisB: '#2a231e',
    colorDebrisC: '#1c1714',
    colorDebrisD: '#151110',

    /* --- the molten cracks torn through the floor --- */
    /**
     * Real geometry, not a decal: arms of crack that meander outward from the
     * impact, shed branches, glow from a white-hot core through a wide orange
     * underglow, and heave basalt up along their lips. See
     * `effects/GroundFissures.js` — the network is baked in a unit disc, so
     * `fissureRadius` re-scales cracks that are already on the ground.
     */
    fissureRadius: 5.2, // how far the cracks reach, metres
    fissureLife: 6.5, // seconds before they close up
    fissureArms: 6, // main cracks radiating from the impact
    fissureWander: 1.6, // how hard an arm veers, radians per unit walked
    fissureBranches: 0.75, // fraction of the generated branches kept, 0..1
    fissureBranchLength: 0.85, // how far along a branch runs before its point, 0..1
    fissureWidth: 0.14, // width of the open seam, metres
    fissureHeat: 1.5, // core temperature
    fissurePulse: 1.0, // speed of the heat waves travelling along them
    fissureGrowth: 9.0, // how fast the cracks race outward, metres/second
    fissureRockSize: 0.3, // basalt heaved up along the lips, metres

    /* --- what else the ground does --- */
    scorchRadius: 2.8, // burnt patch under it, metres
    scorchLife: 8.0,
    scorchIntensity: 0.95,
    shockRadius: 6.0, // impact shockwave ring, metres
    colorScorch: '#0d0907',
    colorShockA: '#ff9a2e', // body of the shockwave ring
    colorShockB: '#fff3d0', // its crest

    /* --- dynamic light --- */
    lightIntensity: 16,
    lightRadius: 14,
    lightColor: '#ff8a3c',
    lightFlicker: 0.25, // depth of the light's gutter, 0 = steady
    lightFlickerSpeed: 13,

    /* --- the launch and the detonation --- */
    muzzleSize: 0.0, // the flare at the hand as the rock leaves it — 0 = none
    muzzleIntensity: 1.6,
    castFlash: 0.08, // screen flash on release
    colorCastFlash: '#ff9a2e',
    burstSize: 3.6, // the fireball at the impact point, metres
    burstIntensity: 1.0,
    burstTurbulence: 2.0, // how hard the noise eats into the fireball's shell
    burstEmbers: 260, // extra embers thrown at the impact
    burstSparks: 180,
    burstDebris: 90,
    burstSmoke: 70,
    impactShake: 1.0,
    shakeDuration: 1.1,
    impactFlash: 0.3,
    rumble: 0.04, // continuous shake while the rock is in the air
    colorFlash: '#ff9a2e' // the full-screen flash on impact
  },

  /* ================================================================== */
  /* BEAM — ability four                                                 */
  /* ================================================================== */
  /**
   * A sustained super beam: the caster winds up a ball of light in both hands,
   * then lets a column of it out along the aimed line, where it *stays* —
   * burning into the floor for `lifetime` before it collapses back to a thread
   * and blinks out. Reference for the look: `superbeam.jpg`.
   *
   * This is the ability with a **fourth beat**. Ice, thunder and meteor all run
   * travel → impact → fade; the beam puts a `charge` in front of that, so the
   * shot is something you watch arrive *and* something that lands and holds.
   * Nothing in the base class needed changing for it — `BeamAbility` simply
   * refuses to let the front leave the hand until the orb is up to power.
   *
   * The column is **one tube** — see `assets/ProceduralGeometry.js` — drawn
   * three times at three radii by `materials/BeamMaterial.js`: a wide halo, a
   * hollow rim-weighted sheath and, inside it, a core weighted the *opposite*
   * way, brightest where the view ray runs down the barrel. That inversion is
   * what makes the middle read as a solid rod of light instead of as a lit
   * pipe. The coils spiralling around it and the shock discs racing down it are
   * two more instanced passes placed against the same radius profile, so all
   * five stay welded together when the shape is dragged.
   *
   * Deliberately *not* electric: no kinks anywhere. The bolt's noise is
   * piecewise-linear so it keeps its corners; every noise term here is smooth
   * and stretched hard along the flow, because a beam that kinks is a bolt.
   *
   * As in every other block, a cast captures nothing but one seed and a few
   * timestamps. The barrel, the flare, the coil pitch and the disc train are all
   * resolved against these numbers each frame — which is why dragging `radius`
   * re-bores a beam that is already burning, with the clock stopped.
   */
  beam: {
    // M6 T12: both tiers land on CombatSystem's lineTick case (width is also
    // the per-sample hit radius, dps the sustained tick rate).
    breakpoints: { lv3: { width: 1.5 }, lv5: { dps: 1.35 } },

    /* --- the cast --- */
    range: 26.0, // maximum cast distance, metres
    minRange: 3.0, // closer than this and the cast is refused
    charge: 0.42, // seconds the orb winds up before the beam is let out
    speed: 150.0, // how fast the leading edge races downrange, metres/second
    lifetime: 1.15, // seconds it burns once it lands
    fadeTime: 0.4, // seconds it takes to collapse
    cooldown: 1.6,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where it leaves the caster --- */
    // Both hands, so this one sits on the centre line rather than off a
    // shoulder like the bolt and the rock.
    handHeight: 1.3, // metres above the floor
    handForward: 0.72, // metres in front of the caster
    handSide: 0.0, // metres to the side (+ follows `Ability#side`)
    endHeight: 1.0, // height of the beam where it lands, metres

    /* --- the column --- */
    // A narrow throat that stays tight (`radiusCurve` above 1) and then opens
    // hard over the last tenth of the span: the beam reads as a jet with a bell
    // on the end rather than as a cone, which is what puts the weight at the
    // impact instead of spreading it down the whole line.
    radiusNear: 0.16, // half-width at the muzzle, metres
    radius: 0.77, // half-width at the target
    radiusCurve: 1.27, // <1 opens out early, >1 stays tight then flares late
    flare: 1.74, // extra swell where it lands
    flareWidth: 0.09, // how much of the span that swell covers, 0..1
    // Both wobbles ship at zero. The column reads cleaner with a hard, still
    // silhouette — the coils already give the eye something moving to follow —
    // but the rates below are tuned, so raising either one is a single drag.
    throb: 0.0, // pressure waves travelling out along it
    throbScale: 4.8, // waves over the length
    throbSpeed: 2.6, // waves/second
    wander: 0.0, // metres the axis drifts, pinned at both ends
    wanderScale: 0.9, // drift features per unit length
    wanderSpeed: 0.7,

    /* --- the three tube passes --- */
    // The core is deliberately narrow and not fully opaque. Widen it or push
    // `coreFill` up and the three layers stack into one white rod: the cyan
    // sheath and the gold coils are only readable because the middle leaves
    // them room.
    coreWidth: 0.2, // the hot rod, × the column radius
    coreSharp: 1.55, // how tightly the core hugs the axis
    coreFill: 0.6, // how solid it reads
    shellWidth: 1.0, // the sheath
    shellRim: 1.15, // brightness of its silhouette edges
    shellFill: 0.18, // how much body it has between them
    shellOpacity: 0.95,
    // Wide and faint: the halo is atmosphere, not a second beam. Pushing its
    // opacity up fogs the sheath's silhouette edges, which are the read.
    haloWidth: 2.75, // the outer bloom
    haloRim: 4.3, // how tightly that hugs the silhouette
    haloOpacity: 0.14,
    edgePower: 2.2, // rim exponent shared by the sheath

    /* --- the surface --- */
    ripple: 0.2, // how far the noise pushes the barrel off round
    rippleBands: 2.2, // ripple features around the barrel
    rippleScale: 4.25, // ... and along it
    rippleSpeed: 2.0, // how fast they crawl downrange
    streak: 1.1, // filaments streaming along the flow
    streakSharp: 0.45, // 0 = a wash, 1 = hard threads
    streakScale: 4.2, // threads per unit length
    streakBands: 1.8, // ... and around the barrel
    // Kept low: the threads carry heat into the *sheath*, and pushing this up
    // whitens it out until the beam is one colour from axis to rim.
    streakGlow: 0.55, // how hot a thread burns in the sheath
    flowSpeed: 7.0, // how fast the whole field streams downrange
    mouthGlow: 1.6, // heat where the column leaves the orb
    mouthLength: 0.1, // how far that reaches, fraction of the span
    // Kept below the muzzle's: the flare and the impact shell already carry the
    // far end, and stacking a hot cap on top of them blows it out to a disc.
    tipGlow: 0.6, // heat on the leading edge / the burning end
    tipLength: 0.09, // length of that edge, fraction of the span
    softFade: 0.62, // metres of soft fade where it meets geometry

    /* --- colour --- */
    colorCore: '#ffffff', // the axis
    colorInner: '#d3f4ff',
    colorOuter: '#3ec6ff', // the outside of the sheath
    colorHalo: '#0d3ce0', // the wide bloom around it
    // The column is deliberately held *back*. Three additive tube passes at full
    // strength clip to white and the beam becomes a flat plank; dropping the
    // gain and the opacity keeps it glassy and hands the read to the coils.
    glow: 0.74, // overall emissive gain
    opacity: 0.29,

    /* --- the coils --- */
    /**
     * Ribbons spiralling around the column, on the same strip the bolt is drawn
     * on. Warm on purpose: the reference frames a white-hot beam with gold
     * coils, and the colour split is what stops them dissolving into the sheath.
     */
    coils: 4, // ribbons (capped at 8)
    coilTurns: 1.45, // turns each one makes over the length
    // Negative, so the ribbons roll *against* the direction the charge pulse
    // runs. The two motions reading differently is what keeps a held beam from
    // looking like a single rotating screw.
    coilSpeed: -0.69, // turns/second they roll on top of that
    coilRadius: 1.88, // how far out they ride, × the column radius
    coilFlare: 0.57, // extra opening at the far end
    coilWidth: 0.1, // half-width at the muzzle, metres
    coilWidthTip: 1.9, // that width at the target, as a multiple
    coilSharp: 2.2, // how hard the ribbon falls off across its width
    coilPulse: 0.65, // depth of the charge running along it
    coilPulseFreq: 3.0, // pulses over the length
    coilPulseSpeed: 1.6, // pulses/second
    // Driven hard on purpose. With the column dialled back above, the ribbons
    // are what the eye actually follows down the beam.
    coilGlow: 8.0,
    coilOpacity: 2.0,
    colorCoil: '#ffdc8c',
    colorCoilEdge: '#ff6a12',

    /* --- the shock discs --- */
    rings: 10, // discs in flight (capped at 12)
    ringSpeed: 1.31, // trips down the beam per second
    // Both lips well clear of the sheath, and close together: the discs read as
    // thin hoops orbiting the column rather than as plates growing out of it.
    ringInner: 2.42, // inner lip, × the local column radius
    ringOuter: 2.73, // outer lip
    ringSwell: 0.55, // how much they open out as they travel
    ringFade: 0.18, // how much is left of one by the time it lands
    ringSharp: 1.6, // how thin the band reads
    ringGlow: 2.4,
    ringOpacity: 0.7,
    colorRing: '#9ceeff',

    /* --- the charge orb --- */
    orbSize: 0.39, // radius once it is up to power, metres
    orbThrob: 0.11, // how hard it pulses
    orbThrobSpeed: 6.9,
    orbTurbulence: 0.24, // how far the noise eats into its surface
    orbScale: 2.2, // features over the surface
    orbFlow: 0.9, // how fast they crawl
    orbBands: 5.0, // filament frequency
    orbRim: 1.8, // rim exponent
    orbGlow: 2.8,
    orbOpacity: 1.0,

    /* --- what the ground does --- */
    scorchRate: 1.1, // burns laid per metre of front travel
    scorchRadius: 0.7, // radius of one, metres
    scorchLife: 7.0, // seconds it lingers
    scorchIntensity: 0.55,
    colorScorch: '#0a0d14',
    colorEmber: '#4ad6ff',
    dustRate: 7.0, // dust rings thrown off the burning end, per second
    dustRadius: 2.4, // radius of one, metres
    dustLife: 0.9,
    colorDustA: '#3d5c74',
    colorDustB: '#9ceeff',
    shockRate: 3.5, // pressure rings snapped across the floor, per second
    shockRadius: 7.0, // radius of the one at the impact, metres
    colorShockA: '#3ec6ff', // body of the shockwave ring
    colorShockB: '#ffffff', // its crest

    /* --- sparks, motes, smoke and debris --- */
    /**
     * As in `ice`, `thunder` and `meteor`: each system is coloured by a four-stop
     * gradient sampled over the particle's own lifetime, `A` at birth through
     * `D` as it dies. The motes do double duty — they are the intake spiralling
     * *into* the orb while it charges, and the drift shed off the column once it
     * is firing.
     */
    sparkRate: 300, // sparks shed off the column, particles/second
    sparkSize: 0.15,
    sparkSpeed: 8.0,
    sparkLifetime: 0.55,
    sparkGravity: -9.0,
    sparkStretch: 0.22, // how far a spark smears along its velocity
    sparkForward: 0.9, // how hard the spray is dragged downrange
    colorSparkA: '#ffffff',
    colorSparkB: '#d3f4ff',
    colorSparkC: '#3ec6ff',
    colorSparkD: '#0b2f7a',
    moteRate: 120, // the drift hanging around the column
    moteSize: 0.06,
    moteSpeed: 1.6,
    moteLifetime: 1.5,
    moteRise: 0.9, // upward drift, metres/second
    moteTurbulence: 0.8,
    colorMoteA: '#ffffff',
    colorMoteB: '#9ceeff',
    colorMoteC: '#3ec6ff',
    colorMoteD: '#06205e',
    intakeRate: 260, // motes pulled into the orb while it charges
    intakeRadius: 2.6, // how far out they are drawn from, metres
    intakeSpeed: 7.5, // how fast they fall in
    smokeRate: 90, // steam scoured off the floor under the beam
    smokeSize: 1.1,
    smokeSpeed: 1.4,
    smokeLifetime: 2.4,
    smokeOpacity: 0.07,
    smokeRise: 0.7,
    colorSmokeA: '#41566d',
    colorSmokeB: '#35485e',
    colorSmokeC: '#2a3949',
    colorSmokeD: '#1a2430',
    debrisRate: 34, // chips torn off the floor along the burn line
    debrisSize: 0.06,
    debrisSpeed: 6.0,
    debrisLifetime: 1.4,
    debrisGravity: -18.0,
    colorDebrisA: '#2b323c',
    colorDebrisB: '#1f252d',
    colorDebrisC: '#1a1f26',
    colorDebrisD: '#1a1f26',

    /* --- dynamic light --- */
    // Two lights: one rides the beam, one sits in the caster's hands so the
    // charge actually lights the body that is holding it.
    lightIntensity: 30,
    lightRadius: 20,
    lightColor: '#7fdcff',
    lightPulse: 0.18, // depth of the hum, 0 = steady
    lightPulseSpeed: 5.0, // pulses/second
    muzzleLightIntensity: 16,
    muzzleLightRadius: 9,

    /* --- the wind-up, the release and the burn --- */
    chargeShake: 0.045, // rumble while the orb spools up
    castFlash: 0.22, // screen flash as it is released
    muzzleSize: 1.1, // the pressure shell thrown off the hands, metres
    muzzleIntensity: 2.0,
    colorCastFlash: '#d3f4ff',
    burstSize: 4.2, // the shell at the impact point, metres
    burstIntensity: 1.6,
    burstSparks: 220, // extra sparks thrown when it lands
    burstDebris: 70,
    pulseRate: 2.6, // pressure shells off the burning end, per second
    pulseSize: 2.2, // radius of one, metres
    pulseIntensity: 1.1,
    splashRate: 260, // sparks kicked back up the beam while it burns
    impactShake: 0.9,
    shakeDuration: 0.7,
    burnShake: 0.09, // continuous rumble while the beam is standing
    impactFlash: 0.3,
    rumble: 0.05, // rumble while the leading edge travels
    colorBurstA: '#3ec6ff',
    colorBurstB: '#d3f4ff',
    colorBurstC: '#ffffff',
    colorFlash: '#d3f4ff' // the full-screen flash on impact
  },

  /* ================================================================== */
  /* SNARE — ability five, and the first **far cast**                    */
  /* ================================================================== */
  /**
   * A trap planted at a point rather than a shot fired along a line: the caster
   * whips a leash of current out across the floor, and where it lands the ring
   * snaps open — a column of lightning tears up out of the middle, tendrils
   * crawl outward to the boundary and arcs run around the rim, all of it
   * holding, re-striking and dragging the air upward for `lifetime` before it
   * collapses. Reference for the look: `electricalboost.jpg`.
   *
   * This is the block that defines what a far cast *is* in this project. The
   * targeting is a circle (see the `zone` block) and `zoneRadius` is the promise
   * that circle makes: the boundary the indicator draws is the boundary the
   * field burns, the tendrils reach and the rim arcs run along, so dragging that
   * one number re-scales the indicator and a snare that is already standing
   * together.
   *
   * The whole cage is **one instanced strip** — see `materials/SnareMaterial.js`.
   * Every filament is the same ribbon, and a *role* decided from its instance
   * index (leash → column → tendril → rim) picks which parametric path the
   * vertex shader threads it along. Two draw calls for all four, however many
   * filaments are in the air.
   *
   * As in every other block, a cast captures nothing but a seed and a few
   * timestamps. Every metre, radian and second is resolved against these numbers
   * each frame — including a zero-length one, which is why the trap reshapes
   * under the sliders with the clock stopped.
   */
  snare: {
    // M6 T12: Lv5's slowFactor REPLACES the base 0.45 outright (spec's own
    // "0.45→0.65" phrasing — bpReplace, not a multiply/add).
    breakpoints: { lv3: { radius: 1.3 }, lv5: { slowFactor: 0.65 } },

    /* --- the cast --- */
    range: 20.0, // maximum cast distance, metres
    minRange: 0.0, // a trap can legitimately be dropped on your own feet
    zoneRadius: 4.4, // the footprint — what the circle indicator measures out
    speed: 62.0, // how fast the leash races to the point, metres/second
    snapTime: 0.16, // seconds the ring takes to slam open once it lands
    lifetime: 2.6, // seconds the snare stands
    fadeTime: 0.75, // seconds it takes to collapse
    cooldown: 1.4,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the leash that plants it --- */
    // Thrown from a hand, so these are measured from the caster's origin in the
    // cast's own frame, exactly as the bolt and the rock are.
    handHeight: 1.24, // metres above the floor
    handForward: 0.58, // metres in front of the caster
    handSide: 0.18, // metres to the side (+ follows `Ability#side`)
    leashStrands: 3, // filaments in the whip
    leashSag: -0.35, // metres the mid-span bows (negative drops it to the floor)
    leashSpread: 0.22, // how far the filaments separate, metres
    leashKink: 0.3, // kink amplitude on the whip, metres
    leashWidth: 1.0, // × the shared filament width
    leashCling: 0.12, // how far above the floor the tip runs, metres

    /* --- the column --- */
    strands: 15, // filaments in the pillar
    height: 9.2, // how high it reaches, metres
    heightCurve: 1.45, // <1 gets it up fast, >1 makes it climb late
    throat: 0.16, // radius where it leaves the floor, × zoneRadius
    columnSpread: 0.25, // radius at the top, × zoneRadius
    columnCurve: 2.88, // >1 keeps the throat tight then opens it late
    columnFlare: 0.585, // extra opening over the last quarter, × zoneRadius
    columnTwist: 0.22, // turns a filament makes over the climb
    columnSpin: 1.26, // turns/second the whole pillar rolls
    columnKink: 0.27, // kink amplitude, metres
    columnWidth: 1.86, // × the shared filament width
    columnTaper: 1.09, // how much thinner the top is than the base

    /* --- the tendrils crawling out to the boundary --- */
    tendrils: 20, // separate ground filaments (capped with the rest at 56)
    tendrilInner: 0.0, // where they leave the column, × zoneRadius
    tendrilReach: 1.07, // where they end, × zoneRadius (1 = exactly on the band)
    tendrilCurve: 1.18, // <1 throws them outward early
    tendrilWander: 1.41, // radians a tendril veers over its run
    tendrilArch: 1.16, // metres it hops off the floor mid-span
    tendrilHug: 0.005, // how far above the floor it runs, metres
    tendrilSpin: -0.225, // turns/second the whole fan rotates
    tendrilKink: 0.72, // kink amplitude, metres
    tendrilWidth: 0.75, // × the shared filament width
    tendrilDim: 0.8, // how much dimmer than the column

    /* --- the arcs running around the rim --- */
    rimArcs: 14, // arcs on the boundary at once
    rimSpan: 0.335, // fraction of the circle one arc covers
    rimSpeed: -1.84, // revolutions/second they travel
    // High enough to clear the burnt band underneath them: an arc that hops
    // 0.3 m over a band this bright is simply invisible.
    rimHeight: 0.98, // metres they hop at mid-span
    rimJitter: 0.23, // radial wobble, × zoneRadius
    rimKink: 0.15, // kink amplitude, metres
    rimWidth: 0.85, // × the shared filament width
    rimDim: 1.0,

    /* --- the shape every filament shares --- */
    // The same piecewise-linear value noise the bolt uses — linear on purpose,
    // because smoothstep rounds the corners off and the corners are the entire
    // reason it reads as lightning.
    jitter: 1.0, // master multiplier on the four per-role kink amplitudes
    jitterScale: 1.4, // kinks per metre
    octaves: 4, // 1–5; each halves the amplitude and doubles the rate
    jitterFalloff: 0.55, // amplitude kept per octave
    crawl: 2.4, // how fast the kinks slide along a filament
    pinch: 0.16, // fraction of the span the ends are pulled straight over
    restrike: 21, // times/second every filament re-rolls its shape
    flicker: 0.26, // depth of the whole-cage brightness stutter
    flickerSpeed: 30,
    strandFlash: 0.45, // how much individual filaments blink out

    /* --- the ribbon --- */
    width: 0.032, // half-width of a filament, metres
    coreSharp: 4.4, // how hard the hot core falls off across the ribbon
    glowWidth: 6.2, // the halo, × the core width
    glowFalloff: 2.3, // how fast the halo fades across its ribbon
    glowOpacity: 0.44,
    softFade: 0.7, // metres of soft fade where a filament meets geometry

    /* --- colour --- */
    // Violet rather than the Storm Lance's blue: two electric abilities on the
    // bar need to be told apart at a glance, and the hue split does it before
    // the silhouette does.
    colorCore: '#ffffff', // the centre of a filament
    colorInner: '#dcd0ff',
    colorOuter: '#8f6bff', // the outside of a filament
    colorHalo: '#2a0e8c', // the wide glow around the cage
    glow: 2.2, // overall emissive gain
    opacity: 1.0,

    /* --- the field burnt into the floor --- */
    /**
     * The indicator's promise, made real: the same circle, the same thick
     * boundary, now a live shader instead of a targeting aid. It is an
     * ability-owned mesh rather than a decal precisely because a decal captures
     * its radius when it spawns — this one has to re-scale under `zoneRadius`
     * while it is standing.
     */
    fieldBoundary: 0.02, // thickness of the burnt band, metres
    fieldBoundaryGlow: 2.9,
    fieldFill: 0.65, // the wash inside it
    fieldFalloff: 3.6, // how hard that wash crowds to the rim
    fieldVeins: 2.98, // filaments burnt across the disc
    fieldVeinScale: 2.0, // veins per metre
    fieldVeinSharp: 0.72, // 0 = a wash, 1 = hard threads
    fieldWarp: 0.55, // domain warp — what stops the veins reading as spokes
    fieldCrawl: 0.5, // how fast they writhe
    fieldRings: 2.4, // pressure rings travelling out from the middle
    fieldRingSpeed: 0.8, // rings/second
    fieldSpokes: 20, // ticks stepping around the boundary
    fieldSpokeLength: 0.5, // how far they reach in, metres
    fieldSpin: 0.05, // revolutions/second the ticks step around
    fieldCore: 1.3, // brightness of the pool the column stands in
    fieldCoreSize: 0.22, // its radius, × zoneRadius
    fieldPulse: 0.0, // brightness breathing
    fieldPulseSpeed: 3.95,
    fieldOpacity: 1.0,
    fieldHeight: 0.03, // hover distance above the floor, metres
    colorField: '#8f6bff', // the wash and the veins
    colorFieldEdge: '#ffffff', // the boundary band and the core pool

    /* --- what else the ground does --- */
    arcRate: 5.0, // branching burns laid around the rim, per second
    arcRadius: 1.2, // radius of one, metres
    arcLife: 0.75,
    arcIntensity: 0.9,
    arcBranches: 0.7, // how finely a burn splits into filaments
    trailRate: 1.1, // burns laid per metre while the leash races out
    scorchRadius: 1.6, // dark burn under the column, metres
    scorchLife: 7.5,
    scorchIntensity: 0.5,
    colorArc: '#c3b0ff',
    colorEmber: '#8f6bff',
    colorScorch: '#0b0813',
    shockRadius: 7.0, // the ring that snaps out when the trap opens, metres
    colorShockA: '#8f6bff', // body of the shockwave ring
    colorShockB: '#ffffff', // its crest

    /* --- sparks, updraft, smoke and debris --- */
    /**
     * As in every other block: a four-stop gradient sampled over the particle's
     * own lifetime, `A` at birth through `D` as it dies. The **updraft** is this
     * ability's signature system — motes drawn off the whole disc and hauled
     * inward and up into the column, which is the read that says the trap is
     * pulling on the air rather than just sitting in it.
     */
    sparkRate: 320, // sparks thrown off the cage, particles/second
    sparkSize: 0.15,
    sparkSpeed: 8.5,
    sparkLifetime: 0.55,
    sparkGravity: -13.0,
    sparkStretch: 0.2, // how far a spark smears along its velocity
    colorSparkA: '#ffffff',
    colorSparkB: '#dcd0ff',
    colorSparkC: '#8f6bff',
    colorSparkD: '#2a0e8c',
    updraftRate: 210, // motes hauled up the column, particles/second
    updraftSize: 0.07,
    updraftSpeed: 6.0, // how fast they are pulled in
    updraftLifetime: 1.4,
    updraftRise: 5.5, // upward acceleration once they are inside, m/s²
    updraftInset: 0.15, // how far inside the boundary they are picked up
    updraftTurbulence: 0.9,
    colorUpdraftA: '#8f6bff',
    colorUpdraftB: '#dcd0ff',
    colorUpdraftC: '#ffffff',
    colorUpdraftD: '#1b0a5e',
    smokeRate: 70, // haze scoured off the burnt floor
    smokeSize: 1.05,
    smokeSpeed: 1.2,
    smokeLifetime: 2.4,
    smokeOpacity: 0.06,
    smokeRise: 0.6,
    colorSmokeA: '#4a4368',
    colorSmokeB: '#3a3554',
    colorSmokeC: '#2b2740',
    colorSmokeD: '#191728',
    debrisRate: 30, // chips torn off the floor inside the ring
    debrisSize: 0.055,
    debrisSpeed: 5.5,
    debrisLifetime: 1.3,
    debrisGravity: -17.0,
    colorDebrisA: '#2a2733',
    colorDebrisB: '#201e28',
    colorDebrisC: '#1a1822',
    colorDebrisD: '#1a1822',

    /* --- dynamic light --- */
    lightIntensity: 24,
    lightRadius: 18,
    lightHeight: 0.38, // how far up the column the light sits, 0..1
    lightColor: '#a98bff',
    lightFlicker: 0.38, // depth of the light's gutter, 0 = steady
    lightFlickerSpeed: 24,

    /* --- the throw, the snap and the hold --- */
    muzzleSize: 0.5, // the flash at the hand as the leash leaves it
    muzzleIntensity: 1.7,
    castFlash: 0.09, // screen flash on release
    colorCastFlash: '#c3b0ff',
    burstSize: 2.8, // the shell thrown off when the ring opens, metres
    burstIntensity: 1.5,
    burstSparks: 200, // extra sparks at the snap
    burstDebris: 60,
    pulseRate: 1.5, // pressure shells shed off the column while it holds, /s
    pulseSize: 1.2, // radius of one, metres
    pulseIntensity: 0.5,
    ringRate: 1.4, // dust rings pushed across the floor while it holds, /s
    impactShake: 0.85,
    shakeDuration: 0.6,
    holdShake: 0.07, // continuous rumble while the snare stands
    impactFlash: 0.26,
    rumble: 0.025, // rumble while the leash races out
    colorBurstA: '#8f6bff',
    colorBurstB: '#dcd0ff',
    colorBurstC: '#ffffff',
    colorFlash: '#c3b0ff' // the full-screen flash when it snaps open
  },

  /* ================================================================== */
  /* GLACIER — ability six, and the far cast that comes out of the floor */
  /* ================================================================== */
  /**
   * A cold front races along the floor to the aimed point, the disc freezes out
   * to the boundary the circle drew, and a wall of crystal tears up out of the
   * ground around it: a ring of blades leaning outward with a skirt of wreckage
   * banked against their feet. It stands, glints, breathes cold off its rim —
   * and then breaks into plates and sinks back into the floor. Reference for the
   * look: `Hud7Xfg3LH.jpg`.
   *
   * The **middle stays open**: every shard is seated in a band about
   * `zoneRadius` and nothing is planted in the centre, because the read is a
   * wall you are looking into and filling the disc stops it being a ring. What
   * lives inside it is air and frozen ground.
   *
   * The second **far cast**, and the counterpart to the Voltaic Snare: same
   * circle, same promise, opposite answer. The snare fills the footprint with
   * current standing in the air; this one fills it with geometry standing on the
   * ground, so `zoneRadius` is again the one number that matters — it is where
   * the ring of blades is seated, where the sheet's boundary band burns, where
   * the curtain of cold air stands and where the rime creeps.
   *
   * Three things carry it, and each has its own group below:
   *
   *  - **the sweep.** The ring does not appear; it *closes*. The blade nearest
   *    the caster goes up first and the wave runs around both sides to meet
   *    behind the crown (`sweepTime`), with the skirt banking up behind the wave
   *    (`skirtDelay`, `skirtWave`).
   *  - **the freeze front.** Every shard crystallises upward along its own axis
   *    while it rises (`frontRough`, `frontWidth`, `frontGlow` — see
   *    `materials/GlacierMaterial.js`), so the ice *forms* rather than sliding
   *    out of a hole.
   *  - **the shatter.** It leaves the same way it arrived, in pieces: a
   *    per-shard ramp against a chunk id made of voronoi cells and flat facets,
   *    so plates and wedges come away one at a time (`shatterScale`,
   *    `shatterEdge`, `shatterGlow`).
   *
   * As in every other block, a cast captures nothing but a seed and a handful of
   * timestamps. Every metre, radian and second is resolved against these numbers
   * each frame — including a zero-length one, which is why the crown reshapes
   * under the sliders with the clock stopped.
   */
  glacier: {
    // M6 T12: both tiers land on CombatSystem's burst case (radius via the
    // zoneRadius fallback below, slowTime alongside the existing slowFactor).
    breakpoints: { lv3: { radius: 1.3 }, lv5: { slowTime: 1.6 } },

    /* --- the cast --- */
    range: 18.0, // maximum cast distance, metres
    minRange: 0.0, // a wall of ice around your own feet is a legitimate play
    zoneRadius: 4.6, // the footprint — what the circle indicator measures out
    speed: 44.0, // how fast the front races to the point, metres/second
    snapTime: 0.22, // seconds the sheet takes to freeze out to the boundary
    lifetime: 4.2, // seconds the crown stands
    shatterDelay: 0.5, // seconds after `lifetime` before the ice starts to break
    shatterStagger: 0.45, // seconds of random delay between neighbours
    sinkTime: 1.15, // seconds one shard takes to crumble and withdraw
    cooldown: 1.6,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- where the front leaves the caster --- */
    // Thrown from a hand, so these are measured from the caster's origin in the
    // cast's own frame, exactly as the bolt, the rock and the leash are.
    handHeight: 1.22, // metres above the floor
    handForward: 0.6, // metres in front of the caster
    handSide: 0.18, // metres to the side (+ follows `Ability#side`)

    /* --- how the footprint is filled --- */
    /**
     * Everything is seated in a band about `zoneRadius`; the middle of the
     * circle is left empty on purpose, because the read of the ability is a wall
     * you are looking *into* and filling the disc stops it being a ring. The
     * spire in the middle is kept as a control and ships at zero.
     */
    spikeCount: 220, // instances spent on one cast (capped at 320)
    density: 1.0, // multiplier on that count
    ringShare: 0.6, // fraction of them spent on the wall at the boundary
    coreShare: 0.0, // ... on the spire in the middle (0 = the middle stays open)
    lateShare: 0.12, // ... held back to push up during the hold
    ringSeat: 0.94, // where the wall stands, × zoneRadius
    ringScatter: 0.16, // radial jitter of the wall, × zoneRadius
    skirtSeat: 0.74, // inner lip of the wreckage banked against it, × zoneRadius
    skirtBand: 0.42, // how wide that band is, × zoneRadius
    skirtBias: 0.9, // <1 pushes the skirt outward, >1 crowds it inward
    coreSpread: 0.16, // radius of the cluster in the middle, × zoneRadius

    /* --- the silhouette --- */
    /**
     * The reference is a *starburst*, not a fence: long needles thrown outward
     * from the rim at a steep angle, fanned off the radius so they cross, with
     * wildly uneven lengths. `ringLean` is the single control that decides
     * whether this reads as a crown or a picket line — at 0 it is a fence, and
     * the higher it goes the further the blades are thrown out over the floor.
     */
    ringHeight: 1.4, // length of a blade on the wall, metres
    ringWave: 0.61, // how uneven the crest of that wall is, 0..1
    skirtHeight: 1.7, // length of a shard in the skirt, metres
    coreHeight: 5.2, // length of the spire, metres
    heightJitter: 0.65,
    ringLean: 0.33, // radians the wall is thrown outward (≈19°)
    skirtLean: 0.3, // ... and the skirt
    coreLean: 0.2, // the spire stands nearly upright
    leanJitter: 1.3,
    fan: 1.16, // radians a blade is splayed off its own radius, ± — the crossing
    twist: 1.0, // random yaw, 0..1 of a full turn
    rubble: 0.53, // fraction of the skirt demoted to ankle-height wreckage
    rubbleScale: 0.34,

    /* --- an individual crystal --- */
    // Blunt wedges rather than needles: a thick base that only narrows to about
    // a third at the tip, so each facet stays wide enough to catch a flash.
    radius: 0.375, // base radius, metres
    radiusJitter: 0.94,
    taper: 0.36, // tip radius as a fraction of the base
    facets: 7, // sides of the prism — fewer, so each facet is a broad flash
    roughness: 0.0, // how far the facets are pushed off a clean prism
    bend: 0.0, // sideways curve from base to tip — nearly straight

    /* --- the bloom: when each shard goes up --- */
    riseTime: 0.2, // seconds from buried to full height
    riseOvershoot: 0.3, // how far past full height the punch carries
    settle: 0.5, // seconds the overshoot takes to damp out
    sweepTime: 0.42, // seconds the wave takes to run around the ring
    skirtDelay: 0.1, // seconds before the skirt starts
    skirtWave: 0.26, // ... and how long it takes to cross the band
    coreDelay: 0.2, // seconds before the spire comes up
    stagger: 0.07, // seconds of random delay on top of all of it
    bloomSpread: 0.7, // fraction of the hold the late shards are scattered over

    /* --- the ice: prismatic glass, not the Lance's quarried crystal --- */
    /**
     * Deliberately the *opposite* treatment to `ice`. Two frost abilities on one
     * bar have to be told apart before the silhouette does it, and a recolour is
     * not enough — so where the Frost Lance is milky, diffuse and tinted deeper
     * the thicker it gets, these blades are near-empty glass carried entirely by
     * their edges: a chromatically split fresnel (`dispersion`), light piped up
     * the body to an incandescent point (`pipe`, `tipBias`, `tipGlow`), flow
     * lines instead of feather frost (`stria`) and one real reflection of the
     * stage off every facet (`envIntensity`, `specular`).
     * See `materials/GlacierMaterial.js`.
     */
    colorGlass: '#0e4a66', // the little body it has
    colorEdge: '#ffffff', // the silhouette, the flow lines and the glint
    colorPrismA: '#57f0ff', // one end of the dispersion split
    colorPrismB: '#8f9bff', // ... and the other
    colorCore: '#a8f4ff', // the light piped up the blade
    colorTip: '#ffffff', // the incandescent point
    body: 1.37, // how much of a body it has at all, 0 = pure edges
    edgePower: 1.14, // how tightly the silhouette hugs the rim
    edgeGain: 0.81, // how hard it burns
    dispersion: 0.73, // how far the red, green and blue fresnels come apart
    pipe: 1.09, // light piped along the blade
    tipBias: 1.6, // how hard that light crowds toward the point
    bands: 1.4, // slow waves travelling up it
    pulseSpeed: 0.6,
    tipStart: 0.6, // where the incandescent tip begins, 0..1 up the blade
    tipGlow: 1.5,
    stria: 0.75, // flow lines running the blade's length
    striaScale: 6.0,
    envIntensity: 0.6, // how much of the HDR probe the facets catch
    specular: 2.0, // the tight sun lobe off them
    glow: 1.0, // overall emissive gain
    opacity: 1.0,
    birthGlow: 2.2, // extra glow on a shard that has just erupted
    birthFade: 0.5, // seconds that birth flash lasts

    /* --- the freeze front and the shatter --- */
    /**
     * The two things that make this ability's ice *arrive* and *leave* rather
     * than fade in and out. Both are per-instance ramps the ability drives; what
     * lives here is only their look.
     */
    frontRough: 0.35, // how ragged the crystallising edge is
    frontWidth: 0.12, // how much of the shard is lit behind that edge
    frontGlow: 2.4, // how hard it burns
    shatterScale: 7.0, // break-up cells per unit of the crystal
    shatterEdge: 0.08, // width of the lit rim on a fresh break
    shatterGlow: 3.0,

    /* --- the sheet of ice on the floor --- */
    /**
     * The indicator's promise, made real: the same circle and the same thick
     * boundary, now a frozen sheet instead of a targeting aid. An ability-owned
     * mesh rather than a decal precisely because a decal captures its radius
     * when it spawns — this one has to re-scale under `zoneRadius` while the
     * crown is standing, and to run its own front outward and back.
     */
    fieldBoundary: 0.4, // thickness of the band at the edge, metres
    fieldBoundaryGlow: 2.4,
    fieldFill: 0.26, // the wash inside it
    fieldFalloff: 1.4, // how hard that wash crowds to the rim
    fieldPlates: 1.0, // tonal break-up between plates
    fieldPlateScale: 2.2, // plates per metre
    fieldSeam: 0.8, // rime piled in the seams between them
    fieldFingers: 0.9, // frost fingers crawling over the sheet
    fieldFingerScale: 1.6, // fingers per metre
    fieldWarp: 0.5, // domain warp — what stops them reading as spokes
    fieldCrawl: 0.12, // how fast they writhe
    fieldRings: 2.6, // pressure rings travelling in toward the spire
    fieldRingSpeed: -0.5, // rings/second (negative travels inward)
    fieldSweep: 0.4, // slow cold sweep around the disc
    fieldSweepSpeed: 0.12, // revolutions/second
    fieldCore: 1.0, // brightness of the pool the spire stands in
    fieldCoreSize: 0.2, // its radius, × zoneRadius
    fieldPulse: 0.18, // brightness breathing
    fieldPulseSpeed: 1.6,
    fieldOpacity: 1.0,
    fieldHeight: 0.03, // hover distance above the floor, metres
    colorField: '#a7e6ff', // the wash, the plates and the fingers
    colorFieldEdge: '#ffffff', // the boundary band, the seams and the pool

    /* --- the curtain of cold air standing on the ring --- */
    /**
     * An open cylinder seated on the boundary, eroded by ridged noise stretched
     * hard vertically and scrolled downward. This is the piece that frames the
     * crown from the outside: without it the wall of blades ends at its own
     * silhouette, and a wall of ice that is not shedding cold reads as glass.
     * Set `veil` to 0 to take it off.
     */
    veil: 0.5, // master opacity of the curtain, 0 hides it
    veilHeight: 1.9, // how high it stands, metres
    veilRadius: 1.02, // where it stands, × zoneRadius
    veilFlare: 0.32, // how far it leans outward at the top
    veilBillow: 0.22, // metre-scale lobes pushing its silhouette off round
    veilScale: 1.4, // noise features per metre
    veilStretch: 0.5, // <1 draws the structures out into vertical falls
    veilFlow: 0.4, // how fast they pour downward
    veilErode: 0.55, // how much harder the top is eaten away than the base
    veilFalloff: 1.8, // how fast it thins with height
    veilSpin: 0.02, // revolutions/second the whole curtain turns
    veilSoftFade: 0.8, // metres of soft fade where it meets geometry
    colorVeil: '#8cd2ff',
    colorVeilCrest: '#ffffff',

    /* --- what the ground does --- */
    trailFrostRate: 2.2, // rime patches laid per metre of front travel
    trailFrostRadius: 1.0, // radius of one, metres
    frostSpread: 1.5, // the rime sheet under the crown, × zoneRadius
    frostLife: 7.5, // seconds a rime patch lingers
    frostIntensity: 0.85,
    frostCrystals: 1.5, // grain of the packed snow
    frostCollar: 2.6, // rime around the foot of a blade, × its own radius
    rimeRate: 3.0, // rime patches creeping around the boundary, per second
    rimeRadius: 1.0, // radius of one, metres
    colorFrost: '#f0f9ff', // the lit face of the snow
    colorFrostEdge: '#79b6dd', // what it goes in its own shadow
    shockRadius: 7.5, // the ring that snaps out when the crown blooms, metres
    ringRate: 0.9, // pressure rings pushed out while it stands, per second
    colorShockA: '#8ee8ff', // body of the shockwave ring
    colorShockB: '#ffffff', // its crest

    /* --- mist, chips, glitter and snow --- */
    /**
     * As in every other block: a four-stop gradient sampled over the particle's
     * own lifetime, `A` at birth through `D` as it dies. The **snow** is this
     * ability's signature system — ice dust spawned *above* the crown and left
     * to fall back down through it. Everything else in the project is thrown
     * upward, and a slow fall inside the ring is what says the air over it is
     * freezing rather than burning.
     */
    mistRate: 240, // cold air pouring off the rim, particles/second
    mistSize: 1.1,
    mistSpeed: 1.6,
    mistLifetime: 3.0,
    mistOpacity: 0.055,
    mistRise: -0.12, // negative: cold air is heavy, it falls and spreads
    mistTurbulence: 0.4,
    colorMistA: '#f2feff',
    colorMistB: '#cdefff',
    colorMistC: '#8ec9e8',
    colorMistD: '#0a2c42',
    shardSize: 0.07, // ice chips
    shardSpeed: 6.5,
    shardLifetime: 1.6,
    shardGravity: -15.0,
    breachShards: 3, // chips thrown as one shard breaks the surface
    shatterShards: 5, // ... and as it comes apart
    colorShardA: '#ffffff',
    colorShardB: '#cdefff',
    colorShardC: '#8ee8ff',
    colorShardD: '#0a3c55',
    glitterRate: 150, // the sparkle lifting off the sheet
    glitterSize: 0.05,
    glitterSpeed: 2.6,
    glitterLifetime: 2.4,
    glitterRise: 1.3, // upward drift, metres/second
    glitterTurbulence: 0.6,
    glitterGlow: 1.0,
    colorGlitterA: '#ffffff',
    colorGlitterB: '#6fe0ff',
    colorGlitterC: '#bdeeff',
    colorGlitterD: '#062434',
    snowRate: 110, // ice dust falling back through the crown
    snowSize: 0.045,
    snowSpeed: 0.9, // how hard it is pushed downward to start with
    snowLifetime: 3.2,
    snowFall: -1.1, // gravity on it, metres/second²
    snowTurbulence: 0.85, // what turns the fall into a drift
    snowGlow: 0.9,
    snowInset: 0.85, // how far inside the boundary it falls, × zoneRadius
    snowHeight: 1.35, // where it starts, × the height of the wall
    colorSnowA: '#ffffff',
    colorSnowB: '#e4f9ff',
    colorSnowC: '#a7e6ff',
    colorSnowD: '#0c3348',

    /* --- dynamic light --- */
    lightIntensity: 14,
    lightRadius: 16,
    lightHeight: 0.45, // how far up the crown the light sits, 0..1
    lightColor: '#8ee8ff',

    /* --- the throw, the bloom and the hold --- */
    muzzleSize: 0.55, // the puff at the hand as the front leaves it
    muzzleIntensity: 1.5,
    castFlash: 0.08, // screen flash on release
    colorCastFlash: '#cdefff',
    burstSize: 4.0, // the vapour shell thrown off at the bloom, metres
    burstIntensity: 1.1,
    burstShards: 120, // extra chips at the bloom
    burstMist: 70,
    burstGlitter: 140,
    vapourRate: 1.6, // vapour shells shed off the wall while it stands, /s
    vapourSize: 1.4, // radius of one, metres
    vapourIntensity: 0.7,
    impactShake: 0.85,
    shakeDuration: 0.85,
    holdShake: 0.05, // continuous rumble while the crown stands
    impactFlash: 0.2,
    rumble: 0.045, // rumble while the front races out
    colorBurstA: '#a7e6ff',
    colorBurstB: '#cdefff',
    colorBurstC: '#ffffff',
    colorFlash: '#cdefff' // the full-screen flash when it blooms
  },

  /* ================================================================== */
  /* FIREBALL — the small one                                            */
  /* ================================================================== */
  /**
   * A fist-sized ball of fire, thrown flat and fast, that pops where it lands.
   *
   * The cheap ability of the set, and deliberately so: it has no mesh and no
   * shader of its own. The head is a dense cluster of additive particles fed a
   * hundred-odd times a second along the flight path, the wake is the same
   * emission with a shorter rate and a longer life, and the impact is the burst
   * sphere, the shockwave decal and the scorch every other element already uses.
   * That makes it the file to copy when adding an ability — see the README —
   * because every piece of it is a shared system rather than new machinery.
   *
   * Sizes are in metres and rates in particles/second, both landed on by eye at
   * `size` 0.4: a ball you could hold, not a meteor.
   */
  fireball: {
    // M6 T12: fireball is kind:'self' (resolves its own hits, see combat.fireball's
    // own comment) — both tiers are read straight off this block by
    // FireballAbility.onImpact() itself, never through CombatSystem.
    breakpoints: { lv3: { radius: 1.35 }, lv5: { damage: 1.3 } },

    /* --- the cast --- */
    range: 20.0, // maximum throw, metres
    minRange: 0, // it is a bolt, not an eruption — casting at your feet is fine
    speed: 34.0, // how fast the ball travels, metres/second — light things move fast
    cooldown: 0.25, // the spammable one
    castAnim: 'cast2', // the shortest of the three clips, throw at 0.27s

    /* --- what it does --- */
    // The only ability wired to the training dummies. Damage is deliberately
    // *not* scaled by any of the global VFX multipliers: turning the explosions
    // up is a look, not a buff, and the two have to stay separable or the sandbox
    // stops being able to answer "does this read as hard as it hits".
    //
    // The blast reaches further than the fire is drawn — `burstSize` is 0.9 —
    // because a bolt that visibly washes over a target and does nothing reads as
    // broken, while the reverse is never noticed.
    damage: 140, // at the centre, falling to half at the rim
    damageRadius: 1.4, // metres
    hitStop: true, // whether a mid-flight hit detonates it early

    /* --- where it leaves the hand --- */
    // The ball starts at the hand rather than at the caster's feet, then flies
    // flat and dips into the floor over the last stretch.
    handHeight: 1.32,
    handForward: 0.6,
    handSide: 0.3,
    endHeight: 0.45, // height it is at when it reaches the target
    dip: 0.65, // how late in the flight the drop happens (1 = only at the end)

    /* --- the ball --- */
    // "Small" is read against the caster and nothing else: at 1.78m tall, his
    // head is about 0.22m across, so a ball he could palm is `size` 0.15 — a
    // 0.3m sphere. Everything below is sized off that one number, and the
    // temptation to raise it is the temptation to build a second Cinder Fall.
    size: 0.15, // radius of the head, metres
    coreRate: 190, // particles/second forming the head
    coreLife: 0.18, // seconds each of them lives — short, or the ball smears
    coreGlow: 3.0, // small and bright beats large and dim: it has to still read
    coreTurbulence: 0.6,
    coreRise: 0.4, // buoyancy on the head's own particles

    /* --- what it sheds on the way --- */
    // Deliberately thin. A heavy wake is the single thing that makes a small
    // projectile read as a big one — mass is inferred from what it leaves behind.
    sparkRate: 45,
    sparkSpeed: 1.3,
    sparkSize: 0.06,
    sparkLifetime: 0.32,
    sparkGravity: -6.5,
    sparkStretch: 0.5,
    smokeRate: 14,
    smokeSize: 0.22,
    smokeLifetime: 0.75,
    smokeRise: 1.1,
    smokeOpacity: 0.26,

    /* --- where it lands --- */
    // Chest-high on the caster and no higher. A pop, not a detonation: the
    // shake and the flash are near zero, because a screen that lurches is a
    // screen telling you something heavy just happened. The turbulence stays
    // high — a small sphere with a smooth edge reads as a solid orange ball.
    burstSize: 0.9, // outer radius the fire reaches, metres
    burstIntensity: 2.6,
    burstTurbulence: 1.9,
    burstEmbers: 55,
    burstSparks: 60,
    burstSmoke: 10,
    shockRadius: 1.1,
    scorchRadius: 0.7,
    scorchLife: 3.0,
    scorchIntensity: 0.7,
    impactShake: 0.14,
    shakeDuration: 0.35,
    impactFlash: 0.05,
    castFlash: 0.05, // the muzzle flash as it leaves the hand
    muzzleSparks: 18,

    /* --- light --- */
    // A tight pool that travels with it. Reach is the other half of how big
    // something reads: a 0.3m ball lighting the floor 8m away is a lie the eye
    // catches before it catches the sphere.
    lightColor: '#ff8a2b',
    lightIntensity: 1.7,
    lightRadius: 5.0,

    /* --- colour --- */
    // Hot core to cooling edge, the same black-body walk the meteor takes.
    colorHot: '#fff1c4',
    colorFlameMid: '#ff9a2e',
    colorFlameEdge: '#d63a12',
    colorEmberA: '#fff4cf',
    colorEmberB: '#ffa93a',
    colorEmberC: '#ff5a18',
    colorEmberD: '#6d1405',
    colorSmokeA: '#5a4438',
    colorSmokeB: '#3b2c25',
    colorSmokeC: '#241b17',
    colorSmokeD: '#14100e',
    colorScorch: '#241109',
    colorCrack: '#ff7a25',
    colorShockA: '#ffd9a0',
    colorShockB: '#ff7a2a',
    colorFlash: '#ffb066'
  },

  /* ================================================================== */
  /* M6 T2 — the thirteen v1 launch skills (all thirteen classed, T4-6)   */
  /* ================================================================== */
  /**
   * Every block below carries the same floor every ability block in this file
   * does — `range`, `minRange`, `speed`, `cooldown`, `castAnim` (+ `zoneRadius`
   * on the three `CastShape.ZONE` ones) — plus `manaCost` (spec 锚2.5) and a
   * deliberately small set of VFX knobs (size/count/radius); the rest of each
   * skill's VFX is composed from existing systems, wired in by its own class
   * (M6 T4-6 — LineSweepSkill/ZoneBurstSkill/OrbitAuraSkill/ShieldSkill/
   * DashStrikeSkill/ChainBoltSkill; see AbilityManager's ABILITY_TYPES).
   *
   * Every subclass reads its own block now — `AbilityManager`'s
   * `ABILITY_TYPES` registry, not `ELEMENTS`, is what gates what can
   * actually cast (AbilityManager.js). `range`/`minRange`/`speed` on the
   * seven `CastShape.SELF` blocks still carry no *aiming* meaning (a self
   * cast never uses them to place anything) — they hold real numbers rather
   * than `undefined` because `AimController._resolve()` runs for *any*
   * armed element regardless of its cast shape, and reads `c.minRange`/
   * `c.range` unconditionally; leaving either one out turns every aim
   * update into `NaN` (and, once the geometry update reaches it, a real
   * console error) the moment the element is armed — which the title
   * screen's earth card (rockspikes) does on its very first frame.
   *
   * `damage`/`dps` numbers are spec 锚2 against the live ice-as-played anchor
   * (勘误 D-M6-1, not spec §8's paper value — see the comment in
   * `settings.combat` above), shown per row there; everything else here is
   * flavour, sized by eye against the existing seven.
   */

  // --- 金 swordrain: 万剑诀, a falling rain of blades on a dropped circle ---
  swordrain: {
    // M6 T12: 剑数 (blade count) is additive on `count`, read at spawn by
    // ZoneBurstSkill against swordCount below; 半径 is CombatSystem's own
    // burst radius (WYSIWYG — ZoneBurstSkill._radius() reads the same value).
    breakpoints: { lv3: { count: 4 }, lv5: { radius: 1.4 } },
    range: 14, minRange: 0, speed: 20, cooldown: 2.6, manaCost: 0, castAnim: 'cast1',
    zoneRadius: 4.0, // footprint the circle indicator measures out — matches combat.swordrain.radius
    swordCount: 14, swordSize: 0.5, dropTime: 0.4, // pre-effect: instanced blades falling (T4)
    color: '#e8c766', colorGlow: '#fff2c2',
    // M6 T4 (ZoneBurstSkill): the burst's own radius reads straight off
    // settings.combat.swordrain.radius (WYSIWYG — one number, not two to drift).
    dropHeight: 6.0, burstLife: 0.75,
    lightColor: '#fff2c2', lightIntensity: 10, lightRadius: 9
  },

  // --- 金 bladeorbit: 剑域, five swords orbiting the caster — permanent aura ---
  bladeorbit: {
    // M6 T12: 刃数 (blade count) additive on `count`; 环带半径 multiplies the
    // combat row's radius — both read live by OrbitAuraSkill (WYSIWYG).
    breakpoints: { lv3: { count: 2 }, lv5: { radius: 1.3 } },
    range: 1, minRange: 0, speed: 0, cooldown: 0, manaCost: 0, castAnim: 'cast1',
    bladeCount: 5, bladeSize: 0.4, orbitSpeed: 1.2, // revolutions/second
    color: '#f0d885', colorGlow: '#fff6d9',
    // M6 T4 (OrbitAuraSkill): orbit radius/band read off settings.combat.bladeorbit
    // directly (same WYSIWYG reasoning as swordrain above) — a permanent effect
    // keeps a deliberately modest light so it doesn't wash out the whole run.
    lightColor: '#fff6d9', lightIntensity: 3.5, lightRadius: 5
  },

  // --- 金 dashstrike: 弑神一闪, a short teleport-slash (DashStrikeSkill, T6) ---
  dashstrike: {
    // M6 T12: 冲程 (reach) scales `range` — a single source of truth
    // (DashStrikeSkill.js's exported `scaledDashRange(level)`, fix round)
    // feeds both the ability's own cast distance (damage line/ribbon/flash)
    // and App#_dashDisplace's physical teleport, so the body always lands
    // exactly where the line already reached.
    breakpoints: { lv3: { range: 1.3 }, lv5: { damage: 1.4 } },
    range: 8, minRange: 0, speed: 40, cooldown: 7, manaCost: 30, castAnim: 'cast1',
    // controller-ruled (T6 dispatch): 50×7s×0.8窄线 = 280; 位移+i帧 utility 由
    // 30 蓝定价 (D-M6-1 live anchor) — self-resolved (kind:'self'), exempt
    // from the anchor-2 band check (see check-game.mjs's EXEMPT set).
    damage: 280,
    width: 1.0, // implementer's choice: damageOnce sample radius along the dash line (WYSIWYG-ish with the ribbon's own visual width)
    trailLength: 2.0, flashSize: 1.0, // afterimage ribbon + slash flash
    color: '#d4a940', colorGlow: '#fff0c0',
    // M6 T6: Ability#_updateLight reads these unconditionally every active
    // frame (NaN-poisons LightPool.damp() permanently if absent — same trap
    // M6 T5's report flagged for ShieldSkill).
    lightColor: '#fff0c0', lightIntensity: 10, lightRadius: 8
  },

  // --- 木 chainbolt: 连锁闪电, a bolt hopping between enemies (ChainBoltSkill, T6) ---
  chainbolt: {
    // M6 T12: 跳数 (hops) is additive; 衰减 15%→8% REPLACES hopDecay outright
    // (0.85→0.92 — bpReplace, spec's own "X%→Y%" phrasing, not compounding).
    breakpoints: { lv3: { hops: 2 }, lv5: { hopDecay: 0.92 } },
    range: 14, minRange: 1, speed: 45, cooldown: 1.2, manaCost: 0, castAnim: 'cast1',
    // controller-ruled (T6 dispatch): 首跳 20 平冰枪; 满链
    // 20×(1+.85+.7225+.614+.522) ≈ 74 ≈ 预算60×1.23, 定价链条利用率 80%.
    // Self-resolved (kind:'self'), exempt from the anchor-2 band check.
    damage: 20, hops: 4, hopRadius: 6, hopDecay: 0.85,
    boltWidth: 0.15, arcSize: 0.3, // ribbon width + inter-hop arc glyph
    color: '#7ee08a', colorGlow: '#e3ffe8',
    // M6 T6: same NaN-poison guard as dashstrike above.
    lightColor: '#e3ffe8', lightIntensity: 9, lightRadius: 7
  },

  // --- 木 lifebloom: 生命绽放, a healing burst with a spore DoT ---
  lifebloom: {
    // M6 T12: 治疗 scales combat.lifebloom.healPlayer; 半径 scales its burst radius.
    breakpoints: { lv3: { healPlayer: 1.5 }, lv5: { radius: 1.4 } },
    range: 10, minRange: 0, speed: 18, cooldown: 3.2, manaCost: 0, castAnim: 'cast1',
    zoneRadius: 2.2, // matches combat.lifebloom.radius
    petalCount: 8, bloomSize: 0.6,
    color: '#5fd98f', colorGlow: '#d6ffe6',
    burstLife: 0.8,
    lightColor: '#d6ffe6', lightIntensity: 9, lightRadius: 8
  },

  // --- 水 frostnova: 寒霜新星, a self-centred ring of freeze ---
  frostnova: {
    breakpoints: { lv3: { radius: 1.35 }, lv5: { slowTime: 1.5 } },
    range: 1, minRange: 0, speed: 0, cooldown: 8, manaCost: 30, castAnim: 'cast1',
    ringCount: 3, crystalSize: 0.4,
    color: '#7fd4ff', colorGlow: '#e8f9ff',
    burstLife: 0.9,
    lightColor: '#e8f9ff', lightIntensity: 14, lightRadius: 11
  },

  // --- 水 iceshield: 冰晶甲, a personal shield that sprays shards when it breaks ---
  iceshield: {
    // M6 T12: 盾量/时长 both scale combat.iceshield's own amount/duration.
    // T5 watch item (shield gate): addShield's take-max compares the new cast
    // against the CURRENT REMAINING shield (PlayerState.shield keeps draining
    // in place, never the original cast amount) — so a Lv3 iceshield
    // (40×1.4=56) briefly outweighing stoneskin's base 55 is a no-op window
    // that drains away within seconds, not a stuck state. See task-12-report.md.
    breakpoints: { lv3: { amount: 1.4 }, lv5: { duration: 1.5 } },
    range: 1, minRange: 0, speed: 0, cooldown: 9, manaCost: 30, castAnim: 'cast1',
    shieldSize: 1.1, crystalCount: 6,
    color: '#9fe8ff', colorGlow: '#eefbff',
    // M6 T5: every ability's base class reads lightColor/lightIntensity/
    // lightRadius unconditionally each frame it's active (Ability#_updateLight)
    // — a personal-scale glow, smaller than a thrown AoE's.
    lightColor: '#eefbff', lightIntensity: 8, lightRadius: 7
  },

  // --- 火 firering: 燃阵, a ring of ground fire around the caster — permanent aura ---
  firering: {
    // M6 T12: 环带宽 scales combat.firering.band (the annulus's own thickness,
    // not its outer radius); dps scales the aura's tick rate.
    breakpoints: { lv3: { band: 1.35 }, lv5: { dps: 1.35 } },
    range: 1, minRange: 0, speed: 0, cooldown: 0, manaCost: 0, castAnim: 'cast1',
    flameHeight: 0.8, ringWidth: 0.5,
    color: '#ff8a4c', colorGlow: '#ffe0c2',
    lightColor: '#ffe0c2', lightIntensity: 4, lightRadius: 5.5
  },

  // --- 火 sunwheel: 日轮, three fireballs orbiting the caster — permanent aura ---
  sunwheel: {
    // M6 T12: 球数 additive on `count`; 公转速 scales the new orbitSpeed field
    // below (mirrors bladeorbit's own orbitSpeed — OrbitAuraSkill's
    // _updateSunOrbs() used to hard-code this rotation rate as a bare 0.6).
    breakpoints: { lv3: { count: 1 }, lv5: { orbitSpeed: 1.3 } },
    range: 1, minRange: 0, speed: 0, cooldown: 0, manaCost: 0, castAnim: 'cast1',
    orbCount: 3, orbSize: 0.35, orbitSpeed: 0.6, // revolutions/second
    color: '#ffb347', colorGlow: '#ffe8c2',
    lightColor: '#ffe8c2', lightIntensity: 4, lightRadius: 5.5
  },

  // --- 土 rockspikes: 岩刺突贯, spikes tearing up along a line (ice's skeleton, T4) ---
  rockspikes: {
    breakpoints: { lv3: { width: 1.5 }, lv5: { damage: 1.35 } },
    range: 15, minRange: 2.2, speed: 24, cooldown: 2.4, manaCost: 0, castAnim: 'cast1',
    spikeCount: 16, riseTime: 0.15,
    color: '#b8875a', colorGlow: '#e6d3ba',
    // M6 T4 (LineSweepSkill — ice's skeleton, simplified to one band width read
    // straight off settings.combat.rockspikes.width for WYSIWYG).
    height: 1.5, heightJitter: 0.3, radius: 0.2,
    facets: 5, taper: 0.7, roughness: 0.4, bend: 0.1, lean: 0.3,
    lifetime: 1.6, sinkTime: 0.5,
    lightColor: '#e6d3ba', lightIntensity: 8, lightRadius: 9
  },

  // --- 土 boulder: 落石, a single stunning rock dropped on a circle ---
  boulder: {
    breakpoints: { lv3: { radius: 1.3 }, lv5: { stunTime: 1.6 } },
    range: 16, minRange: 0, speed: 16, cooldown: 3.0, manaCost: 0, castAnim: 'cast1',
    zoneRadius: 2.4, // matches combat.boulder.radius
    rockSize: 1.3, fallTime: 0.5,
    color: '#9c6b42', colorGlow: '#d9bfa0',
    dropHeight: 9.0, burstLife: 0.85,
    lightColor: '#d9bfa0', lightIntensity: 9, lightRadius: 8
  },

  // --- 土 quake: 震地波, a self-centred shockwave with heavy knockback ---
  quake: {
    // M6 T12: 击退 scales combat.quake.knockback (the sweep wired in bd7aa5a).
    breakpoints: { lv3: { radius: 1.35 }, lv5: { knockback: 1.5 } },
    range: 1, minRange: 0, speed: 0, cooldown: 8, manaCost: 30, castAnim: 'cast1',
    waveCount: 2, waveSpeed: 6.0,
    color: '#8a7355', colorGlow: '#d6c9b3',
    burstLife: 1.0,
    lightColor: '#d6c9b3', lightIntensity: 12, lightRadius: 10
  },

  // --- 土 stoneskin: 石肤, rock armour that reflects a share of absorbed damage ---
  stoneskin: {
    // M6 T12: see iceshield's own copy of the shield-gate watch-item note.
    breakpoints: { lv3: { amount: 1.4 }, lv5: { reflectShare: 1.6 } },
    range: 1, minRange: 0, speed: 0, cooldown: 10, manaCost: 30, castAnim: 'cast1',
    shieldSize: 1.2, crackCount: 5,
    color: '#a68968', colorGlow: '#e3d3bd',
    // M6 T5: see iceshield's own copy of this comment.
    lightColor: '#e3d3bd', lightIntensity: 7, lightRadius: 6
  },

  /* ------------------------------------------------------------------ */
  /* M8 second wave — cast-side blocks (数值表). Each block carries the   */
  /* cast fields App/aim read plus the light trio Ability#_updateLight    */
  /* reads unconditionally (NaN-poison guard); the task that lands each   */
  /* class adds that template's own VFX params, the fusion precedent.     */
  /* `life` on the timed rows is both the class's impactDuration and the  */
  /* anchor2 resolver's dps×life fold.                                    */
  /* ------------------------------------------------------------------ */
  cyclonecut: {
    range: 9, minRange: 0, cooldown: 6, manaCost: 30, castAnim: 'cast1',
    life: 2.5, zoneRadius: 3.0,
    color: '#d8b46a', colorGlow: '#f0e2b8',
    lightColor: '#f0e2b8', lightIntensity: 6, lightRadius: 6
  },
  piercelance: {
    range: 14, minRange: 0, cooldown: 8, manaCost: 30, castAnim: 'cast1',
    damage: 320, width: 0.8,
    color: '#e8d089', colorGlow: '#fff4cf',
    lightColor: '#fff4cf', lightIntensity: 7, lightRadius: 7
  },
  stormfield: {
    range: 10, minRange: 0, cooldown: 9, manaCost: 30, castAnim: 'cast1',
    life: 6, zoneRadius: 4.5, boltEvery: 0.75, boltDamage: 52,
    color: '#7ee08a', colorGlow: '#c9f7d0',
    lightColor: '#c9f7d0', lightIntensity: 6, lightRadius: 7
  },
  // Thin, tall, crooked "spikes" read as bramble; `lifetime` (LineSweepSkill's
  // own field name, NOT the fusion family's `life` — one name, no drift) is
  // both how long the road stands and what the anchor2 timed-dps fold reads.
  thornroad: {
    range: 11, minRange: 0, speed: 18, cooldown: 7, manaCost: 0, castAnim: 'cast1',
    spikeCount: 20, riseTime: 0.12,
    height: 1.1, heightJitter: 0.45, radius: 0.14,
    facets: 4, taper: 0.4, roughness: 0.65, bend: 0.45, lean: 0.2,
    lifetime: 4, sinkTime: 0.5,
    color: '#5fd98f', colorGlow: '#9ef0b6',
    lightColor: '#9ef0b6', lightIntensity: 5, lightRadius: 6
  },
  // M8 T2 rides LineSweepSkill (rockspikes' template): the VFX field set
  // below is that class's own contract — every one of them is read
  // unconditionally per frame, so a missing field NaN-poisons a transform.
  // A wave is a wide, low, blunt "spike" that leans hard into the sweep.
  tidalsurge: {
    range: 11, minRange: 0, speed: 16, cooldown: 5, manaCost: 0, castAnim: 'cast1',
    spikeCount: 14, riseTime: 0.1,
    height: 1.3, heightJitter: 0.25, radius: 0.55,
    facets: 6, taper: 0.55, roughness: 0.3, bend: 0.25, lean: 0.55,
    lifetime: 0.5, sinkTime: 0.35,
    color: '#6fb8e8', colorGlow: '#bfe6ff',
    lightColor: '#bfe6ff', lightIntensity: 6, lightRadius: 6
  },
  // M8 T2 rides ZoneBurstSkill (boulder/swordrain's template). No preEffect
  // of its own (neither `_hasBladeRain` nor `_hasFallingRock` matches these
  // ids) — the burst shell + shockwave decal + puff is the whole beat, once
  // per wave; `burstLife` covers the last wave's own delay so the shell is
  // still up when it lands.
  hailstorm: {
    range: 12, minRange: 0, speed: 20, cooldown: 8, manaCost: 30, castAnim: 'cast1',
    zoneRadius: 3.8, burstLife: 2.1,
    color: '#8ee8ff', colorGlow: '#e8fbff',
    lightColor: '#e8fbff', lightIntensity: 7, lightRadius: 8
  },
  flamebreath: {
    range: 5.5, minRange: 0, cooldown: 6, manaCost: 0, castAnim: 'cast1',
    life: 1.2,
    color: '#ff8a3c', colorGlow: '#ffd9a8',
    lightColor: '#ffd9a8', lightIntensity: 7, lightRadius: 6
  },
  mortarrain: {
    range: 12, minRange: 0, cooldown: 7, manaCost: 30, castAnim: 'cast1',
    zoneRadius: 3.5, scatterRadius: 3.5,
    color: '#ffa23c', colorGlow: '#ffe3b8',
    lightColor: '#ffe3b8', lightIntensity: 7, lightRadius: 7
  },
  sandfield: {
    range: 9, minRange: 0, cooldown: 9, manaCost: 0, castAnim: 'cast1',
    life: 4, zoneRadius: 4.2,
    color: '#c9a06a', colorGlow: '#e8d4ad',
    lightColor: '#e8d4ad', lightIntensity: 5, lightRadius: 7
  },
  stonepillar: {
    range: 10, minRange: 0, speed: 20, cooldown: 7, manaCost: 30, castAnim: 'cast1',
    zoneRadius: 2.6, burstLife: 0.8,
    color: '#b8875a', colorGlow: '#e3cfa8',
    lightColor: '#e3cfa8', lightIntensity: 7, lightRadius: 7
  },

  /* ------------------------------------------------------------------ */
  /* Fusion spells — the five sheng-pair bespoke skills (M7, spec §4.7)   */
  /* ------------------------------------------------------------------ */
  /**
   * Five more "ability blocks", one per pair-key (`fusions.js#pairKeyOf`) —
   * cast-side numbers only (cooldown/range/castAnim/colour); the mechanics
   * live in `settings.combat.fusions` above, same split every plain element
   * already keeps between its own top-level block and its `combat` row.
   * `App#_quickCastToward`'s fusion branch reads `cooldown`/`range`/
   * `castAnim` straight off here — no `manaCost` (fusion cost is
   * max(parents), `manaGate.js` never looks here) and no `minRange` (a
   * fusion cast always resolves zone-style, floored at a flat 0.4m — see
   * that branch's own comment).
   */
  fusions: {
    // M7 T2 (VineBlazeSkill): unlike the other four rows (still cast-side
    // only, T3-T6's own problem), '1+3' is `kind:'self'` (see
    // combat.fusions['1+3']) — the class resolves its own hits and never
    // touches CombatSystem, so every mechanism number the plan's 数值表
    // gives it lives here instead of a combat row, same split
    // dashstrike/chainbolt already established for the other two
    // self-resolved specials. radius/dps/life/forkDps/forkCount/maxZones/
    // forkOffset/birthTime are all spec numbers (数值表: 主区180=45×4s,
    // 分叉27×0.6, forkCount 2, cap 5 含主区, radius 2.2 shared by every
    // zone, forkOffset/birthTime are the plan's own "≤0.8m"/"0.3s") — the
    // 数值分层铁律 (settings basis × modifier layer, never hardcoded in
    // code) applies to a self-resolved skill's own top-level block exactly
    // as it does to combat rows. lightColor/lightIntensity/lightRadius are
    // new too: Ability#_updateLight reads them unconditionally every active
    // frame and NaN-poisons LightPool.damp() permanently if absent (M6 T5/T6
    // lesson) — T1's skeleton row left this cast-side-only, so this is the
    // first task to actually spawn the class and hit that trap.
    '1+3': {
      cooldown: 6, range: 10, castAnim: 'cast1', color: '#74d7a8', colorGlow: '#e86f4f', // 业火燎原
      radius: 2.2, dps: 45, life: 4, forkDps: 27, forkCount: 2, maxZones: 5, forkOffset: 0.8, birthTime: 0.3,
      lightColor: '#e86f4f', lightIntensity: 6, lightRadius: 5
    },
    // M7 T3 (VolcanoSkill): '3+4' was cast-side-only through T1 (see the
    // block comment above) — this is the first task to actually spawn the
    // class, so it picks up the same additions '1+3' needed at M7 T2: its
    // own mechanism numbers the plan gives exact values for (数值分层铁律
    // — coneRiseTime/scatterRadius off the brief's own "0.4s"/"≤4m",
    // lavaDps/lavaRadius/lavaLife off the 数值表's own "30×4s, 1.6",
    // relocated here from `combat.fusions['3+4']`, see that row's own
    // comment on why the built-in burst-kind burn channel is the wrong
    // shape for three separate, wider, outlasting-the-cast lava pools),
    // and the three light fields `Ability#_updateLight` reads
    // unconditionally every active frame (NaN-poisons `LightPool.damp()`
    // permanently if absent — M6 T5/T6 lesson, repeated by '1+3' at M7 T2).
    '3+4': {
      cooldown: 8, range: 9, castAnim: 'cast1', color: '#b58f5e', colorGlow: '#e86f4f', // 地心火山
      coneRiseTime: 0.4, scatterRadius: 4, lavaDps: 30, lavaRadius: 1.6, lavaLife: 4,
      lightColor: '#e86f4f', lightIntensity: 7, lightRadius: 6
    },
    // M7 T4 (PrismArraySkill): '4+0' was cast-side-only through T1 — this is
    // the first task to actually spawn the class, so it picks up the same
    // additions '1+3'/'3+4' needed when their classes landed: the mechanism
    // numbers the plan gives exact values for (数值分层铁律 — `life` is the
    // 数值表's own 3s grind window, i.e. the class's impactDuration and
    // therefore exactly how long the aura combat row above gets to tick;
    // `prismCount` off the plan's own "5 根金棱晶"), and the three light
    // fields `Ability#_updateLight` reads unconditionally every active frame
    // (NaN-poisons `LightPool.damp()` permanently if absent — M6 T5/T6
    // lesson, repeated by both earlier fusion classes).
    '4+0': {
      cooldown: 7, range: 9, castAnim: 'cast1', color: '#d8b46a', colorGlow: '#f5e6c8', // 锋岩星阵
      life: 3, prismCount: 5,
      lightColor: '#f5e6c8', lightIntensity: 6, lightRadius: 6
    },
    // M7 T5 (BladeTideSkill): '0+2' picks up its mechanism numbers (数值表:
    // 去程 85 damageOnce / 回程 125 / slowed 回程 ×2 必暴 / width 1.6; the
    // plan body's own 0.5s/0.2s/0.5s out-hover-back timeline) and the three
    // light fields `Ability#_updateLight` reads unconditionally (NaN-poison
    // guard — same addition every fusion class before it needed).
    '0+2': {
      cooldown: 5, range: 11, castAnim: 'cast1', color: '#6fb8e8', colorGlow: '#d8b46a', // 霜刃洪流
      width: 1.6, outDamage: 85, backDamage: 125, backSlowedMult: 2,
      outTime: 0.5, hoverTime: 0.2, backTime: 0.5,
      lightColor: '#6fb8e8', lightIntensity: 6, lightRadius: 6
    },
    // M7 T6 (ThunderMarshSkill): mechanism numbers + the light trio, same
    // additions every fusion class before it needed. `boltHits: 3` is TOTAL
    // strikes per bolt (seed + 2 hops) — the 数值表's own anchor (≈5 道 ×51
    // = 255, i.e. 20+17+14.45 each) resolves the plan body's ambiguous
    // "3 跳" wording; the pool's slow/heal live in combat.fusions['2+1'].
    '2+1': {
      cooldown: 7, range: 10, castAnim: 'cast1', color: '#6fb8e8', colorGlow: '#7ee08a', // 回春雷泽
      life: 4, boltEvery: 0.8, boltDamage: 20, boltDecay: 0.85, boltHits: 3, hopRadius: 6,
      lightColor: '#7ee08a', lightIntensity: 6, lightRadius: 7
    }
  },

  /* ------------------------------------------------------------------ */
  /* Training dummies — the things that can be hit                       */
  /* ------------------------------------------------------------------ */
  /**
   * A ring of straw posts with hit points, and the two readouts that make a
   * number real: a bar that drops and a figure that floats off.
   *
   * They stand at `ringRadius` from the origin, evenly spaced and facing in, so
   * whichever way the camera is locked there is a target in frame. `count` and
   * `ringRadius` are live — the system rebuilds or repositions itself when they
   * change rather than needing a reload.
   */
  dummies: {
    count: 6,
    ringRadius: 9.0, // metres from the origin
    hp: 500,
    respawn: 4.0, // seconds down before it stands back up
    showBars: true
  },

  /* ------------------------------------------------------------------ */
  /* Camera rig                                                          */
  /* ------------------------------------------------------------------ */
  camera: {
    /* --- fixed bearing: an isometric ARPG rig rather than a free orbit --- */
    // Diablo's camera does not orbit: it sits on one bearing, high enough to see
    // the arena and flat enough that the floor reads as a map. With `fixed` on,
    // right-drag is off and the two angles below hold the rig there. Turn it off
    // and the free orbit comes back, clamped by min/max pitch as before.
    fixed: true,
    fixedPolar: 0.72, // radians off vertical: 0 is straight down, π/2 is level
    fixedYaw: 0.79, // the bearing it looks along; π/4 is the isometric diagonal

    // Further out and flatter than a cinematic third-person rig: the long lens
    // is what keeps the floor from fanning out toward the edges of the frame.
    distance: 32,
    minDistance: 3.5,
    maxDistance: 44, // has to clear `distance`, or the first scroll notch yanks it back in
    zoomSpeed: 1.0,
    zoomDamping: 0.002,
    minPolar: 0.35,
    maxPolar: 1.32,
    fov: 34,
    targetHeight: 1.1,
    // Fraction of the follow gap left after 1s. A short leash: an ARPG keeps the
    // character near the middle of the frame, because the frame *is* the play
    // area. Loosen it toward 0.2 and the body pulls a couple of metres ahead
    // while running, which reads more cinematic and less like a game board. It
    // also paces the drift toward an active cast, so this trades off both.
    damping: 0.04,
    autoFrame: 0.35 // how strongly the rig drifts toward an active cast
  },

  /* ------------------------------------------------------------------ */
  /* Environment & lighting                                              */
  /* ------------------------------------------------------------------ */
  environment: {
    // A dark cinematic stage: one cool key, a colder rim from behind, and very
    // little fill, so the ice is the brightest thing on screen and the fog can
    // swallow the floor into the backdrop.
    sunIntensity: 2.6,
    sunColor: '#e8f3ff',
    sunAzimuth: 2.95,
    sunElevation: 0.6,
    ambientIntensity: 0.14,
    ambientColor: '#8ea8d8',
    hemiIntensity: 0.36,
    hemiSkyColor: '#bdd7ff',
    hemiGroundColor: '#3a4552',
    rimIntensity: 1.1,
    rimColor: '#9ec2ff',
    rimAzimuth: 5.45,
    rimElevation: 0.35,
    envIntensity: 0.32,
    backgroundColor: '#121820',
    // Fog is pulled well back so it only dissolves the far edge of the floor into
    // the backdrop rather than sitting on top of the action. Toggle and range are
    // both live in the editor (Environment → Backdrop, fog & dust).
    fogEnabled: true,
    fogColor: '#121820',
    fogNear: 26,
    fogFar: 135,
    shadowBias: -0.0008,
    shadowRadius: 2.2,
    floorColor: '#191f27',
    floorTint: '#232b35',
    floorRoughness: 0.88,
    floorSheen: 0.34,
    floorPool: 0.8,
    // The stone tiling that dresses the floor: ambientCG Rock030 (CC0), a rough
    // natural rock, living in public/textures/cathedral. `floorTextureScale` is metres of floor
    // one tile covers; `floorTexTint` grades the grey stone toward `floorTint` so
    // it sits inside the cool stage palette instead of fighting it.
    floorTexture: false,
    floorTextureScale: 12.0,
    floorNormalScale: 0.85,
    floorTexTint: 0.4,
    dustAmount: 0.85,
    contactShadow: 0.55
  },

  /* ------------------------------------------------------------------ */
  /* Post processing                                                     */
  /* ------------------------------------------------------------------ */
  post: {
    enabled: true,
    exposure: 1.05,
    // Threshold sits above the ice body's lit value on purpose: only the rim,
    // the glints and the impact should bloom, not the whole crystal field.
    // Strength is deliberately near zero — the crystal silhouette carries the
    // read, and bloom was the thing eating it. Push it up if you want the halo.
    bloomStrength: 0.03,
    bloomRadius: 0.6,
    bloomThreshold: 0.88,
    vignette: 0.52,
    chromaticAberration: 0.4,
    contrast: 1.12,
    saturation: 1.08,
    temperature: -0.03, // + warm / - cool
    lift: -0.008,
    gain: 1.0,
    grain: 0.045,
    // Master gain on the screen-space warp written by LAYER.DISTORTION — the
    // last link in the heat-haze chain. Screen widths, so it stays put when the
    // window resizes.
    distortion: 0.045,
    flashStrength: 1.0
  }
};

/**
 * How an ability is aimed.
 *
 * `LINE` is the skillshot the sandbox started with: an arrow swung about the
 * caster, cast along its length. `ZONE` is the **far cast** — a circle with a
 * thick boundary dropped at the cursor, which answers the only question a
 * ground-targeted AoE has to answer before you commit: how much space is this
 * going to take. Both resolve to the same `cast(origin, direction, distance)`
 * event, so an ability never has to care which one aimed it; a zone ability
 * simply reads its target as `pointAt(1)` and works outward from there.
 *
 * `SELF` (M6 T2) is a caster-centred cast with no aiming at all — bladeorbit,
 * frostnova, firering, sunwheel, quake, iceshield and stoneskin. Declared as
 * data only here: AimController's short-circuit (arm-and-fire from the
 * caster, any direction) is future work, so a SELF ability still resolves
 * through the shared line-arrow path today, which is why every SELF block in
 * `settings` still carries real `range`/`minRange` numbers rather than
 * omitting them.
 */
export const CastShape = Object.freeze({
  LINE: 'line',
  ZONE: 'zone',
  SELF: 'self'
});

/**
 * Ability ids, in slot order.
 *
 * `AbilityManager`, the HUD, the aim controller and the editor all key off this
 * array, and the index is the slot the keyboard binds to — adding a third
 * ability is a new file, an entry here and a settings block above.
 */
export const ELEMENTS = [
  'ice', 'thunder', 'meteor', 'beam', 'snare', 'glacier', 'fireball',
  // M6 T2: the thirteen v1 launch skills, 金金金木木水水火火土土土土 (see
  // settings.combat.wuxingOf). Data only — AbilityManager's ABILITY_TYPES
  // registry, not this array, gates what can actually cast (AbilityManager.js),
  // so every id below stays inert until its class lands in T4-6.
  'swordrain', 'bladeorbit', 'dashstrike', 'chainbolt', 'lifebloom',
  'frostnova', 'iceshield', 'firering', 'sunwheel',
  'rockspikes', 'boulder', 'quake', 'stoneskin',
  // M8 T1: the ten second-wave skills (spec §12 v2 batch one, §4.3 matrix),
  // 金金木木水水火火土土. Same rule as the M6 batch: data only — a skill
  // stays inert until its class registers in AbilityManager (T2-T6).
  'cyclonecut', 'piercelance', 'stormfield', 'thornroad', 'tidalsurge',
  'hailstorm', 'flamebreath', 'mortarrain', 'sandfield', 'stonepillar'
];

/**
 * Registry metadata: how an ability is presented, and how it is aimed.
 *
 * `key` must match `InputManager`. `cast` is read by `AimController` to pick
 * between the arrow and the circle; omit it and the ability is a line cast.
 * The thirteen M6 T2 rows below omit `key` on purpose — they aren't on the
 * sandbox's fixed keyboard layout, and run mode binds by loadout seat, not
 * by this field.
 */
export const ELEMENT_META = {
  ice: { label: 'Frost Lance', accent: '#5fd0ff', key: 'Q', hint: 'Frost Lance' },
  thunder: { label: 'Storm Lance', accent: '#7fb4ff', key: 'E', hint: 'Storm Lance' },
  meteor: { label: 'Cinder Fall', accent: '#ff8a3c', key: 'R', hint: 'Cinder Fall' },
  beam: { label: 'Nova Beam', accent: '#7ff0ff', key: 'F', hint: 'Nova Beam' },
  snare: {
    label: 'Voltaic Snare',
    accent: '#a98bff',
    key: 'V',
    hint: 'Voltaic Snare',
    cast: CastShape.ZONE
  },
  glacier: {
    label: 'Glacial Crown',
    accent: '#8ee8ff',
    key: 'X',
    hint: 'Glacial Crown',
    cast: CastShape.ZONE
  },
  fireball: { label: 'Ember Bolt', accent: '#ffa23c', key: 'T', hint: 'Ember Bolt' },

  // --- M6 T2: 金 ---
  swordrain: { label: 'Sword Rain', accent: '#e8c766', hint: 'Sword Rain', cast: CastShape.ZONE },
  bladeorbit: { label: 'Blade Orbit', accent: '#f0d885', hint: 'Blade Orbit', cast: CastShape.SELF },
  dashstrike: { label: 'God-Killing Flash', accent: '#d4a940', hint: 'God-Killing Flash' },
  // --- 木 ---
  chainbolt: { label: 'Chain Bolt', accent: '#7ee08a', hint: 'Chain Bolt' },
  lifebloom: { label: 'Life Bloom', accent: '#5fd98f', hint: 'Life Bloom', cast: CastShape.ZONE },
  // --- 水 ---
  frostnova: { label: 'Frost Nova', accent: '#7fd4ff', hint: 'Frost Nova', cast: CastShape.SELF },
  iceshield: { label: 'Crystal Ward', accent: '#9fe8ff', hint: 'Crystal Ward', cast: CastShape.SELF },
  // --- 火 ---
  firering: { label: 'Cinder Ring', accent: '#ff8a4c', hint: 'Cinder Ring', cast: CastShape.SELF },
  sunwheel: { label: 'Sun Wheel', accent: '#ffb347', hint: 'Sun Wheel', cast: CastShape.SELF },
  // --- 土 ---
  rockspikes: { label: 'Stone Spikes', accent: '#b8875a', hint: 'Stone Spikes' },
  boulder: { label: 'Boulder Fall', accent: '#9c6b42', hint: 'Boulder Fall', cast: CastShape.ZONE },
  quake: { label: 'Quake', accent: '#8a7355', hint: 'Quake', cast: CastShape.SELF },
  stoneskin: { label: 'Stone Skin', accent: '#a68968', hint: 'Stone Skin', cast: CastShape.SELF },

  // --- M8 T1: the second wave (labels are the roster's EN convention) ---
  cyclonecut: { label: 'Magnet Storm', accent: '#d8b46a', hint: 'Magnet Storm', cast: CastShape.ZONE },
  piercelance: { label: 'Army-Breaker Lance', accent: '#e8d089', hint: 'Army-Breaker Lance' },
  stormfield: { label: 'Storm Field', accent: '#7ee08a', hint: 'Storm Field', cast: CastShape.ZONE },
  thornroad: { label: 'Thorn Road', accent: '#5fd98f', hint: 'Thorn Road' },
  tidalsurge: { label: 'Tidal Surge', accent: '#6fb8e8', hint: 'Tidal Surge' },
  hailstorm: { label: 'Hailstorm', accent: '#8ee8ff', hint: 'Hailstorm', cast: CastShape.ZONE },
  flamebreath: { label: 'Flame Breath', accent: '#ff8a3c', hint: 'Flame Breath' },
  mortarrain: { label: 'Falling Fire', accent: '#ffa23c', hint: 'Falling Fire', cast: CastShape.ZONE },
  sandfield: { label: 'Sandstorm Field', accent: '#c9a06a', hint: 'Sandstorm Field', cast: CastShape.ZONE },
  stonepillar: { label: 'Pillar of Heaven', accent: '#b8875a', hint: 'Pillar of Heaven', cast: CastShape.ZONE }
};

/**
 * The skills that stand on their own once seated (装备即常驻, M6 T4) — every
 * aura-kind row EXCEPT the timed fields, which are ordinary casts that
 * happen to use the aura hit test (M8: 磁暴/沙暴领域, and the fusion 锋岩星阵
 * before them). A timed one is exactly the one carrying its own `life`.
 *
 * Derived, not hand-kept, so a new aura row can't be forgotten — but the
 * discriminator has to be this pair of facts, not the kind alone: App hands
 * every member a free standing cast with no cooldown and no mana, which for
 * a timed field would be flatly wrong.
 */
export function permanentAuraElements() {
  return ELEMENTS.filter(
    (element) => settings.combat[element]?.kind === 'aura' && settings[element]?.life === undefined
  );
}

/** How the given ability is aimed. Line unless its metadata says otherwise. */
export function castShapeOf(element) {
  return ELEMENT_META[element]?.cast ?? CastShape.LINE;
}

/** The footprint a far cast will cover, metres. 0 for a line cast. */
export function zoneRadiusOf(element) {
  return castShapeOf(element) === CastShape.ZONE ? (settings[element]?.zoneRadius ?? 0) : 0;
}

/** Immutable snapshot used by "Reset to defaults" and the preset system. */
export const DEFAULT_SETTINGS = structuredClone(settings);

/**
 * Deep-merge a plain object into `settings` in place.
 * Existing object identity is preserved so every live binding keeps working.
 */
export function applySettings(patch, target = settings) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (target[key] && typeof target[key] === 'object') applySettings(value, target[key]);
    } else if (key in target) {
      target[key] = value;
    }
  }
  return target;
}

/** Restore every value to the shipped defaults (in place). */
export function resetSettings() {
  applySettings(structuredClone(DEFAULT_SETTINGS));
}

/** Serialisable clone of the current state. */
export function snapshotSettings() {
  return structuredClone(settings);
}
