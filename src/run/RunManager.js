import { settings } from '../config/settings.js';

/**
 * The 15 minutes themselves (spec §7).
 *
 * Owns the clock-facing state — elapsed time, spawn scheduling, telegraphs,
 * kills — and hands down one verdict per tick: playing, dead or won. Systems
 * stay ignorant of each other; every cross-wire (deaths feed gems, finished
 * casts release their hit memory) is knotted here and nowhere else.
 */
const TELEGRAPH_TIME = 0.5; // seconds a spawn ring shows before the enemy lands
/** takeDamage source for a projectile hit — no element (bolts carry no wuxing), ranged behavior. */
const PROJECTILE_SOURCE = { element: -1, behavior: 1 };
/** Reused {x,z} target for a detonation's splash/slow — _react never allocates. */
const _reactPt = { x: 0, z: 0 };
/** Reused {x,z} target for 石肤's reflect — tick() never allocates. */
const _reflectPt = { x: 0, z: 0 };
/** 石肤反伤: enemies.damage()'s own reach already adds the target's own body
 * radius on top of this, so a small constant here is enough to land squarely
 * on "whoever touched the player" without also catching a neighbour standing
 * shoulder to shoulder (spec: "single-point small radius"). */
const REFLECT_RADIUS = 0.5;

/**
 * The skill ledger books by element id, not by wuxing — a detonation only
 * knows which wuxing triggered it, so credit the first configured skill that
 * casts as that wuxing (settings.combat.wuxingOf's first match). A
 * top-3-readout approximation, same spirit as the rest of the ledger (spec's
 * own concession). Each wuxing now has at least one representative; if future
 * additions ever lack one, this guard (_react's own check below) safely skips booking.
 */
function wuxingRep(wux) {
  return Object.entries(settings.combat.wuxingOf).find(([, v]) => v === wux)?.[0];
}

/**
 * 微顿帧 (M5 Task 9) pure arithmetic. App owns the `_hitstop` seconds field
 * itself — `frame()` reads it every tick to scale the world's dt — these two
 * live here, outside the class, only so `check-game.mjs` can pin the numbers
 * without a renderer (RunManager is already Node-safe and already imported
 * there; App.js is not, it touches the canvas/WebGL stack directly).
 */
export function tickHitstop(current, raw) {
  return Math.max(0, current - raw);
}
export function addHitstop(current) {
  return Math.min(settings.run.hitstopCap, current + settings.run.hitstopDuration);
}

export class RunManager {
  constructor(systems) {
    this.s = systems;
    this.active = false;
    this.elapsed = 0;
    this.kills = 0;
    this.telegraphs = [];
    this._spawnDebt = 0;
    this.pendingLevels = 0;
    // Mid-tide elite scheduler: how many of this tide's eliteAt marks have
    // already queued a spawn, and which tide index that count belongs to.
    this._elitesSpawned = 0;
    this._lastTideIndex = 0;
    /** Fired the tick a new tide opens, with the incoming element. */
    this.onTideTurn = null;
    /** Fired when a shard is picked up (element index) — App opens a directional hand. */
    this.onShardHand = null;
    /** Fired on a "big moment" (currently: every sheng detonation) — App
     * triggers 微顿帧 off it. Elite kills and 禁咒 fire are App-side already
     * (onDeath's elite flag, `_fireUltimate`'s own success branch), so only
     * the reaction case needs a signal out of here. */
    this.onBigMoment = null;

    this.s.enemies.onDeath = (x, z, element, elite) => {
      this.kills++;
      if (elite) {
        this.s.pickups.dropAt(x, z, this.elapsed / 60, 1);
        this.s.pickups.dropShard(x, z, element);
      } else {
        this.s.pickups.dropAt(x, z, this.elapsed / 60);
      }
      // 木共鸣: every kill drips a little life back (spec §4.8), regardless
      // of that kill's own wuxing. `?.` because two pre-M4 headless fakes
      // still construct RunManager without a modifiers collaborator — they
      // never arm a reaction either, so this is the only spot that needs it.
      if (this.s.modifiers?.resonates(1)) this.s.player.heal(settings.resonance.woodKillHeal);
      this.s.player.gainMana(settings.run.manaPerKill);
      this.s.ultimate?.gainKill();
    };
    this.s.enemies.onFire = (x, z, dx, dz, dmg) => this.s.projectiles.spawn(x, z, dx, dz, dmg);
    this.s.enemies.onReaction = (markWux, wux, x, z, amount) => this._react(markWux, wux, x, z, amount);
    this.s.pickups.onShard = (element) => this.onShardHand?.(element);

    // Casts hand back their hit memory the moment the manager retires them —
    // scanning `active` misses them (the manager splices finished casts out
    // of that array inside its own update, before this tick ever runs).
    this.s.abilities.onRetire = (ability) => {
      const id = this.s.combat.release(ability);
      if (id !== -1) this.s.enemies.releaseCast(id);
    };
  }

  start() {
    // Every deal fresh: a restart replays nothing from the last run.
    this.s.tides.reshuffle(this.s.rng);
    this.active = true;
    this.elapsed = 0;
    this.kills = 0;
    this.telegraphs.length = 0;
    this._spawnDebt = 0;
    this.pendingLevels = 0;
    this._elitesSpawned = 0;
    this._lastTideIndex = 0;
    this.s.enemies.clear();
    this.s.pickups.clear();
    this.s.player.reset();
    this.s.projectiles.clear();
    this.s.combat.resetStats?.();
    this.s.ultimate?.reset();
  }

  stop() {
    this.active = false;
  }

  /** Which tide `elapsed` sits in — forwards TideSchedule's reused scratch object. */
  tide() {
    return this.s.tides.tideAt(this.elapsed);
  }

  tick(step, playerPos) {
    if (!this.active) return 'playing';
    if (!this.s.player.alive) return 'dead';
    if (this.elapsed >= settings.run.duration) return 'won';

    this.elapsed += step;
    const minute = this.elapsed / 60;

    // Accrue spawn debt from the budget curve, jittered ±20%.
    const perSecond = (settings.run.spawnBase + settings.run.spawnQuad * minute * minute) / 60;
    this._spawnDebt += perSecond * step * (0.8 + 0.4 * this.s.rng());
    while (this._spawnDebt >= 1) {
      this._spawnDebt -= 1;
      this._queueSpawn(playerPos);
    }

    // Telegraphs count up; expired ones become enemies, carrying whatever
    // element/behaviour/elite flag they were queued with.
    for (let i = this.telegraphs.length - 1; i >= 0; i--) {
      const tg = this.telegraphs[i];
      tg.t += step / TELEGRAPH_TIME;
      if (tg.t >= 1) {
        this.s.enemies.spawnAt(tg.x, tg.z, minute, tg.element, tg.behavior, tg.elite);
        this.telegraphs[i] = this.telegraphs[this.telegraphs.length - 1];
        this.telegraphs.pop();
      }
    }

    // Scratch-object hazard: tides.tideAt() and tides.rollElement() share one
    // reused scratch object (rollElement calls tideAt internally), so a held
    // reference can look mutated by an unrelated later call. Read once here
    // and copy the primitives out immediately — nothing below may hold this
    // object across the _queueSpawn(playerPos) call above (already ran) or
    // the elite _queueSpawn below (which skips rollElement by passing an
    // explicit element/behavior), so these locals stay valid all tick.
    const tideNow = this.s.tides.tideAt(this.elapsed);
    const tideIndex = tideNow.index;
    const tideElement = tideNow.element;
    const tideProgress = tideNow.progress;

    // Tide turn: the tick that crosses into a new tide rains gold on the
    // player and resets the mid-tide elite scheduler.
    if (tideIndex !== this._lastTideIndex) {
      this._lastTideIndex = tideIndex;
      this._elitesSpawned = 0;
      this.s.pickups.rainAt(playerPos.x, playerPos.z, this.s.rng);
      this.onTideTurn?.(tideElement);
    }

    // Mid-tide elites: one per eliteAt mark this tide's progress has crossed.
    const marks = settings.tides.eliteAt;
    if (this._elitesSpawned < marks.length && tideProgress >= marks[this._elitesSpawned]) {
      this._elitesSpawned++;
      this._queueSpawn(playerPos, tideElement, 0, 1);
    }

    // Projectiles bite through the same mercy window as contact.
    const shot = this.s.projectiles.tick(step, playerPos);
    if (shot > 0) this.s.player.takeDamage(shot, PROJECTILE_SOURCE);

    // March, bite, collect.
    const contact = this.s.enemies.tick(step, playerPos, minute);
    // Passes enemies.lastContact by reference (no copy — it's the zero-alloc
    // scratch object), so player.lastHitBy aliases it. Safe only because a
    // lethal hit here flips player.alive false, and tick()'s own top-of-call
    // guard then refuses to run enemies.tick() again and mutate it further.
    if (contact > 0) {
      // 石肤 (M6 T5): a before/after diff on the pool — not takeDamage's own
      // return — is what says "how much did the shield actually eat", since
      // a hit can pierce partway through. Read reflectShare before the call:
      // takeDamage zeroes it right alongside the pool if this hit empties it.
      const shieldBefore = this.s.player.shield;
      const reflectShare = this.s.player.reflectShare;
      this.s.player.takeDamage(contact, this.s.enemies.lastContact);
      const absorbed = shieldBefore - this.s.player.shield;
      // Contact only — a projectile's shooter carries no position to reflect
      // at (the `shot > 0` branch above hits with the anonymous
      // PROJECTILE_SOURCE, not an enemy index/position), so reflect never
      // runs off that path.
      if (absorbed > 0 && reflectShare > 0) {
        _reflectPt.x = this.s.enemies.lastContact.x;
        _reflectPt.z = this.s.enemies.lastContact.z;
        this.s.enemies.damage(_reflectPt, REFLECT_RADIUS, absorbed * reflectShare, -1);
      }
    }
    this.s.player.tick(step);
    // M6 T4: lifebloom's healPlayer — CombatSystem stays player-agnostic and
    // just reports what's due; this is the one place that actually spends it.
    const healDue = this.s.combat.tick(step, this.s.abilities.active);
    if (healDue > 0) this.s.player.heal(healDue);
    // M6 T5: iceshield/stoneskin's addShield — same routing shape as healDue
    // just above, read off a field instead of tick()'s own return (see
    // CombatSystem.shieldDue's own doc). `?.` guards the handful of headless
    // tests/pre-M6 fakes that construct RunManager with a bare `{ tick, ... }`
    // combat stub carrying no shieldDue at all.
    const shieldDue = this.s.combat.shieldDue;
    if (shieldDue?.amount > 0) {
      this.s.player.addShield(shieldDue.amount, shieldDue.duration, shieldDue.reflectShare);
    }
    this.s.ultimate?.tick(step, playerPos);
    this.pendingLevels += this.s.pickups.tick(step, playerPos);

    return 'playing';
  }

  /**
   * A detonation's own hp damage is already settled inside EnemySystem; this
   * only routes its five neighbour-system side effects (spec §4.6) and books
   * the nominal damage. The five sheng pairs are disjoint, so `markWux` alone
   * picks the branch — `wux` (the triggering hit's own wuxing) is only
   * needed for the ledger credit below.
   */
  _react(markWux, wux, x, z, amount) {
    const { enemies, pickups, player, modifiers, combat } = this.s;
    const m = settings.marks;
    _reactPt.x = x;
    _reactPt.z = z;
    this.s.ultimate?.gainReaction();
    // Any of the five sheng detonations counts as a big moment for hitstop
    // purposes (spec's own "禁咒/融合引爆/精英杀" list — a fusion cast
    // self-detonates per M4's retained semantics, so this single hook covers
    // that case too without a separate signal).
    this.onBigMoment?.('reaction');
    switch (markWux) {
      case 1: // 木→火 助燃: a splash of untyped damage around the victim
        enemies.damage(_reactPt, m.assistSplash.radius, amount * m.assistSplash.share, -1);
        break;
      case 3: // 火→土 烧结: bonus green gems
        for (let n = 0; n < m.sinterGems; n++) pickups.dropAt(x, z, this.elapsed / 60);
        break;
      case 4: // 土→金 淬炼: arm the next metal cast
        modifiers.armQuench();
        break;
      case 0: // 金→水 凝露: a slow field around the victim
        enemies.slow(_reactPt, m.dewSlow.radius, m.dewSlow.factor, m.dewSlow.duration);
        break;
      case 2: // 水→木 滋养: heal the player
        player.heal(m.nourishHeal);
        break;
      default:
        break; // not one of the five wuxing indices — nothing to route
    }
    // Guard against wuxing indices with no registered skill (defensive; all five
    // now have representatives as of M6 T2, but the guard remains for future additions).
    const rep = wuxingRep(wux);
    if (rep !== undefined) combat.book(rep, amount * m.reactionMult * enemies.tuning.reactionMult);
  }

  /**
   * Queue a telegraphed spawn. `element`/`behavior` default to the tide's
   * own composition roll and the minute's behaviour mix; elites (and any
   * other caller with an opinion) pass both explicitly to skip the roll.
   */
  _queueSpawn(playerPos, element = null, behavior = null, elite = 0) {
    const angle = this.s.rng() * Math.PI * 2;
    const r = settings.run.spawnRadius;
    const x = playerPos.x + Math.cos(angle) * r;
    const z = playerPos.z + Math.sin(angle) * r;
    const a = settings.run.arenaRadius - 1;
    const d = Math.hypot(x, z);
    // Clamp the ring onto the arena so edge-hugging never starves spawns.
    const cx = d > a ? (x / d) * a : x;
    const cz = d > a ? (z / d) * a : z;

    const spawnElement = element ?? this.s.tides.rollElement(this.s.rng, this.elapsed);
    let spawnBehavior = behavior;
    if (spawnBehavior === null) {
      const minute = this.elapsed / 60;
      const mix = settings.enemies.mix;
      const roll = this.s.rng();
      spawnBehavior = 0;
      if (minute >= mix.tankFrom && roll < mix.tankShare) spawnBehavior = 2;
      else if (minute >= mix.rangedFrom && roll < mix.tankShare + mix.rangedShare) spawnBehavior = 1;
    }

    this.telegraphs.push({ x: cx, z: cz, t: 0, element: spawnElement, behavior: spawnBehavior, elite });
  }
}
