import { Vector2, Vector3, MathUtils, Mesh, RingGeometry, MeshBasicMaterial, AdditiveBlending } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { frame } from './FrameUniforms.js';
import { LAYER } from './Layers.js';

import { Environment } from '../world/Environment.js';
import { Ground } from '../world/Ground.js';
import { DustMotes } from '../world/DustMotes.js';
import { ContactShadows } from '../world/ContactShadows.js';
import { TrainingDummies } from '../world/TrainingDummies.js';
import { Targets } from '../run/Targets.js';

import { GameClock } from '../run/GameClock.js';
import { createRng } from '../run/rng.js';
import { EnemySystem } from '../run/EnemySystem.js';
import { EnemyRenderer } from '../run/EnemyRenderer.js';
import { EnemyProjectiles } from '../run/EnemyProjectiles.js';
import { Arena } from '../run/Arena.js';
import { TideAtmosphere } from '../run/TideAtmosphere.js';
import { TideSchedule, WUXING_LABEL, BEATS } from '../run/TideSchedule.js';
import { sequenceRefund } from '../run/sequence.js';
import { FUSIONS, isFusionId, fusionParents, pairKeyOf } from '../run/fusions.js';
import { canAffordCast, manaCostOf } from '../run/manaGate.js';
import { CombatSystem } from '../run/CombatSystem.js';
import { bpFlag } from '../run/breakpoints.js';
import { PickupSystem } from '../run/PickupSystem.js';
import { PlayerState } from '../run/PlayerState.js';
import { Modifiers } from '../run/Modifiers.js';
import { Loadout } from '../run/Loadout.js';
import { UpgradePool } from '../run/UpgradePool.js';
import { UpgradeUi } from '../run/UpgradeUi.js';
import { VerdictPanel } from '../run/VerdictPanel.js';
import { Ultimate } from '../run/Ultimate.js';
import { RunManager, tickHitstop, addHitstop } from '../run/RunManager.js';
import { RunHud } from '../run/RunHud.js';
import { DamageNumbers } from '../run/DamageNumbers.js';
import { ThreatArrows } from '../run/ThreatArrows.js';
import { OrbBottles } from '../run/OrbBottles.js';
import { DeathShards } from '../run/DeathShards.js';
import { GameAudio } from '../run/GameAudio.js';
import { resumeAudio } from '../run/audio/zzfx.js';
import { TitleScreen } from '../run/TitleScreen.js';
import { PauseMenu } from '../run/PauseMenu.js';
import { applyPerfPreset } from '../run/perfPreset.js';
import { getColor } from '../utils/color.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { CharacterController } from '../animation/CharacterController.js';

import { InputManager } from '../input/InputManager.js';
import { AimController } from '../input/AimController.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { FissureSystem } from '../effects/GroundFissures.js';
import { BurstSystem, BurstMode } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { AbilityManager } from '../abilities/AbilityManager.js';
import { dashTarget, scaledDashRange } from '../abilities/templates/DashStrikeSkill.js';
import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';
import { t, wuxingWord, wuxingPhrase } from '../ui/strings.js';

import { settings, ELEMENTS, ELEMENT_META, CastShape, castShapeOf } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

const UP = new Vector3(0, 1, 0);
const _deathPos = new Vector3();
/** _maybeCastTwice's own rotated-copy scratch (M6 T12 冰枪 Lv5 castTwice) —
 * never carries state between calls, re-aimed in place each time. */
const _twiceDir = new Vector3();
/** ±8° in radians — the second bolt's angle offset off the first (spec). */
const CAST_TWICE_ANGLE = (8 * Math.PI) / 180;
/** _syncAuras()'s throwaway direction — a permanent aura's cast never travels
 * anywhere (OrbitAuraSkill pins its own position every frame instead), so any
 * unit vector satisfies Ability.spawn()'s contract. */
const _auraCastDir = new Vector3(0, 0, 1);

/** Run-mode key badge per loadout slot, in `settings.run.loadout` order. */
const RUN_SLOT_KEYS = ['LMB', 'RMB', 'Q', 'E', 'R', 'T'];

/** The three permanent auras (M6 T4, spec §4.5 装备即常驻) — element-generic,
 * derived from `settings.combat` rather than a hand-kept list, the same way
 * `_quickCastDistance` already reads a kind off `settings.combat` instead of
 * naming skills. */
const AURA_ELEMENTS = ELEMENTS.filter((element) => settings.combat[element]?.kind === 'aura');

/**
 * Run mode's keyboard half of the loadout. The six on-stage abilities sit in
 * `settings.run.loadout`, ordered [LMB, RMB, Q, E, R, T] — so the sandbox's
 * seven ability slots collapse onto loadout slots 2–5, and the keys with no
 * seat (F, V, X) sit the run out.
 */
const RUN_KEY_SLOTS = { 0: 2, 1: 3, 2: 4, 6: 5 };

/** A fusion id's display name (spec §4.7 table), resolved off its parents' wuxing. */
function fusionName(id) {
  return FUSIONS[pairKeyOf(id)]?.name ?? id;
}

/**
 * A cast's wuxing for sequence-chain and mark purposes (spec §4.7 挂印取子系):
 * a fusion counts as its generated half, not its generating one —
 * `eligibleFusions()` only ever fuses `(a, b)` with `a` generating `b`, so
 * `fusionParents(id)[1]` always is it. A plain element just reads its own.
 */
function fusionWux(element) {
  return isFusionId(element)
    ? settings.combat.wuxingOf[fusionParents(element)[1]]
    : settings.combat.wuxingOf[element] ?? -1;
}

/** A cast's sound, by wuxing index (WUXING_LABEL order: 金木水火土) — reused
 * by both cast sites via `fusionWux(element)`, so a fused cast's sound
 * follows its generated half exactly the way its mark/sequence identity
 * already does (spec §4.7 挂印取子系). */
const CAST_SOUND = ['castMetal', 'castWood', 'castWater', 'castFire', 'castEarth'];

/** 首局按键浮层 (spec §9): one hint per action group, each dismissed the
 * first time its own action fires — see App#_markHintDone. */
const HINT_IDS = ['move', 'aim', 'dodge', 'ult'];
const HINTS_KEY = 'wuxing.hints.v1';

/** Which hints a past session already dismissed. Swallows a disabled/full
 * localStorage (Safari private mode, sandboxed embeds) the same way a
 * missing record does: start with every hint still owed. */
function loadHintsDone() {
  try {
    return JSON.parse(localStorage.getItem(HINTS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Application root: owns every subsystem and the frame loop.
 *
 * The wiring is deliberately one-directional — App builds the systems, hands the
 * ability manager a context object of the shared services, and then does nothing
 * but order the per-frame updates. No subsystem reaches back into App.
 *
 * The interaction is a single loop: select and arm an ability (Q / E), swing the
 * ground arrow with the mouse, click to fire. `AimController` owns the targeting
 * and emits one `cast` event; App turns that into an ability, a heading for the
 * character and a cooldown.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = new Time();
    this.elapsed = 0;
    this.paused = false;
    this._raf = 0;

    /**
     * Seconds left before each ability can be armed again. Per element, so
     * spending one slot never locks the other out.
     */
    this.cooldowns = new Map(ELEMENTS.map((element) => [element, 0]));

    /* ---- core ---- */
    this.assets = new AssetLoader();
    this.renderer = new Renderer(canvas);
    this.rig = new CameraRig(canvas);
    this.camera = this.rig.camera;

    this.environment = new Environment(this.renderer, this.camera);
    this.scene = this.environment.scene;

    /* ---- world ---- */
    this.ground = new Ground(this.environment);
    this.dust = new DustMotes();
    this.contactShadows = new ContactShadows(this.renderer, { size: 2.6, height: 2.4, blur: 2.0 });

    this.dummies = new TrainingDummies(this.environment, canvas);

    this.scene.add(
      this.ground.mesh,
      this.dust.points,
      this.contactShadows.group,
      this.dummies.group
    );
    this.dust.setPixelRatio(this.renderer.gl.getPixelRatio());

    /* ---- shared VFX services ---- */
    this.particles = new ParticleEngine(this.scene);
    this.lights = new LightPool(this.scene);
    this.decals = new DecalSystem(this.scene);
    this.fissures = new FissureSystem(this.scene);
    this.bursts = new BurstSystem(this.scene);
    this.shake = new CameraShake(this.rig);
    this.flash = new ScreenFlash();

    // Read once, so flipping the hash mid-session changes nothing until a
    // reload — off this gate, every frame is byte-identical to the sandbox.
    // #run shows the title screen; #run=quick skips straight to a run with
    // the configured loadout (every prior browser-verification script uses
    // this to bypass the title) — both are runMode, decided again (title vs
    // immediate start) at the end of this constructor.
    this.runMode = location.hash === '#run' || location.hash === '#run=quick';

    this.targets = new Targets();
    // Dummies are sandbox furniture; in a run the horde is the only target
    // population. They stay visible in the arena either way.
    if (!this.runMode) this.targets.register(this.dummies);

    this.abilities = new AbilityManager({
      scene: this.scene,
      camera: this.camera,
      environment: this.environment,
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      fissures: this.fissures,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash,
      dummies: this.dummies,
      targets: this.targets
    });

    /* ---- run mode (only lives while the page opened on #run) ---- */
    if (this.runMode) {
      // The sandbox panels (editor, help card) tuck themselves against the
      // screen edge in a run — styles.css keys off this class; hovering the
      // exposed sliver (or G / H as ever) brings a panel back.
      document.body.classList.add('run-mode');
      // The run's field is the arena, not the sandbox's 90m roam: spawns clamp
      // onto the arena ring, so a runner who can leave it outruns the entire
      // horde into unlit void. (settings.run.arenaRadius documents this pairing.)
      settings.character.roamRadius = settings.run.arenaRadius;
      const rng = createRng((Date.now() % 0xffffffff) >>> 0);
      this.runRng = rng; // _cast's echo roll reads this (Modifiers.echoChance)
      this.gameClock = new GameClock(settings.run.tickRate);
      this.enemySystem = new EnemySystem(rng);
      this.enemyRenderer = new EnemyRenderer(this.scene);
      // Death shatter (M5 Task 9): five-wuxing tetrahedra off `onDeath`'s own
      // element index, doubled for an elite — see the onDeath wrapper below.
      this.deathShards = new DeathShards(this.scene);
      // 五行法阵 (M5 Task 7): five steles + the boundary arc, replacing
      // EnemyRenderer's old M1 rim. Ritual strength never changes mid-run
      // (no editor slider), so this is a one-time set, not a per-frame sync.
      this.arena = new Arena(this.scene);
      this.ground.setRitual(settings.arena.ritualStrength);
      // Light/fog/dust grade toward the current tide's weather (M5 Task 8).
      // Constructed only here — the sandbox never builds one, so it never
      // touches environment/dust at all outside a run.
      this.tideAtmosphere = new TideAtmosphere(this.environment, this.dust);
      this.pickups = new PickupSystem();
      this.scene.add(this.pickups.points);
      this.playerState = new PlayerState();
      // The growth loop's own state (spec §6): seats, upgrade multipliers, the
      // draw pool and the level-up hand itself.
      this.modifiers = new Modifiers();
      this.loadout = new Loadout();
      /** Seats currently left to fight on their own (自动施法), run state — cleared on restart. */
      this._autocast = new Set();
      /** This frame's per-seat cooldown state for RunHud's slot bar (see
       * `_seatCooldowns()`) — six preallocated objects, mutated in place
       * every frame rather than reallocated (matches this file's other
       * per-frame scratch: `_moveDir`, `_deathPos`, `_verdict`...). */
      this._slotCd = Array.from({ length: 6 }, () => ({ active: false, remaining: 0, total: 0, lowMana: false }));
      this._lastCastWux = -1;
      this._lastCastAt = -Infinity;
      /** M6 T3: `this.run.elapsed`-keyed, matching `_lastCastAt`'s own
       * clock — 0.5s repeat suppression on the `run.noMana` toast so
       * mashing a cast against an empty pool doesn't flood it. */
      this._lastNoManaToastAt = -Infinity;
      /** 微顿帧 (M5 Task 9): seconds left of the world's brief post-big-moment
       * slow. See `frame()`'s dt computation and `_triggerHitstop`. */
      this._hitstop = 0;
      this.upgradePool = new UpgradePool(rng, this.loadout, this.modifiers);
      this.upgradeUi = new UpgradeUi();
      this.upgradeUi.onChoice = (result) => this._onUpgradeChoice(result);
      // Esc's destination in a run (spec §9) — see the `_frozen` getter for
      // how this shares UpgradeUi's freeze semantics.
      this.pauseMenu = new PauseMenu({
        onRestart: () => this._restart(),
        onReturnToTitle: () => this._returnToTitle(),
        // Belt-and-suspenders: RunHud's own per-frame update() already
        // re-renders every t()-derived field next frame regardless, but
        // this keeps the six-slot bar's hover titles in step too.
        onLanguageChange: () => this._syncBadges(),
        onPerfModeChange: (on) => applyPerfPreset(settings.global, on),
        getBuildSummary: () => ({ lines: this._buildSummaryLines(), resonance: this._resonanceText() })
      });
      this.verdictPanel = new VerdictPanel();
      this.pickups.mods = this.modifiers;
      // FireballAbility reads ctx.mods?.damageMult() straight from the ability
      // context; every other element's damage rides CombatSystem below instead.
      this.abilities.ctx.mods = this.modifiers;
      // M6 T12: breakpoints.js's bpScale/bpAdd/bpReplace/bpFlag calls all
      // need a level per element — CombatSystem gets it through the
      // constructor (same shape `modifiers` already rides), every other
      // ability class through `ctx.levelOf` (Ability#bpLevel's own doc).
      // Both read `this.loadout` fresh on every call rather than snapshotting
      // it, so an upgrade picked mid-run is live on the very next tick.
      const levelOf = (element) => this.loadout.levelOf(element);
      this.combat = new CombatSystem(this.targets, this.modifiers, levelOf);
      this.abilities.ctx.levelOf = levelOf;
      // FireballAbility books its self-resolved hits straight into the run's
      // damage ledger (D-M3-8) — same wiring shape as ctx.mods above.
      this.abilities.ctx.stats = this.combat;
      // M6 T5: ShieldSkill reads ctx.playerState.shieldT to know how long its
      // ring should keep holding (see that class's own doc) — sandbox-absent,
      // same as playerState itself; the class falls back to a fixed preview
      // duration there instead of reading this.
      this.abilities.ctx.playerState = this.playerState;
      // M6 T6: ChainBoltSkill needs raw per-entity enumeration (x/z/count) to
      // find its first target and walk hops — the population-agnostic
      // `Targets` facade deliberately doesn't expose that (apply-damage-to-
      // a-point only), so this is a direct reference, same absent-in-sandbox
      // shape as the three wirings above. DashStrikeSkill also reads it, but
      // only to release its own damageOnce hit-memory Set on destroy (see
      // that class's own doc) — sandbox-absent there is likewise correct
      // (nothing was ever opened to release).
      this.abilities.ctx.enemies = this.enemySystem;
      this.targets.register(this.enemySystem);
      // One schedule per page load, seeded off the same run rng — but
      // RunManager.start() reshuffles it every call, so a restart still deals
      // a fresh tide order each run, drawn from the same continuing stream.
      this.tideSchedule = new TideSchedule(rng);
      this.enemyProjectiles = new EnemyProjectiles();
      this.scene.add(this.enemyProjectiles.points);
      // 禁咒 (spec §4.9): one full-field ultimate per wuxing, charged by kills
      // and reactions (RunManager below already wires gainKill/gainReaction/
      // tick/reset onto whatever sits at `ultimate`) and fired by F/Digit4
      // through _fireUltimate. `wuxing` is set in startRun(), once the title
      // screen (or #run=quick) has actually picked a seat-0 element.
      this.ultimate = new Ultimate({ enemies: this.enemySystem, player: this.playerState, combat: this.combat, rng });
      this.run = new RunManager({
        enemies: this.enemySystem,
        pickups: this.pickups,
        combat: this.combat,
        player: this.playerState,
        modifiers: this.modifiers,
        targets: this.targets,
        abilities: this.abilities,
        tides: this.tideSchedule,
        projectiles: this.enemyProjectiles,
        ultimate: this.ultimate,
        rng
      });
      this.runHud = new RunHud();
      // The run's sound layer (spec §10 / M5 Task 10). Constructed only here,
      // like every other run-only collaborator above — every `audio.play()`
      // call site below is either inside this same runMode block or (the two
      // cast sites) explicitly gated on `this.runMode`, so the sandbox never
      // makes a sound.
      this.audio = new GameAudio();
      // Hits throw a pooled damage figure — without a number, a two-hit kill
      // reads as "no damage" against enemies that carry no health bar.
      this.damageNumbers = new DamageNumbers(canvas, this.camera);
      this.enemySystem.onHit = (x, z, amount) => {
        this.damageNumbers.spawn(x, z, amount);
        this.audio.play('hit', { pitchJitter: true });
      };
      // Enemies spawn outside the frame by design; the edge arrows say from
      // where, so a pack never simply materialises at the screen edge.
      this.threatArrows = new ThreatArrows(canvas, this.camera);
      // 血蓝玻璃瓶 (spec §9): screen-space HP/mana readout, parented straight to
      // the camera rather than positioned in world space — see OrbBottles for
      // why that trick needs the camera itself sitting in the scene graph.
      this.orbBottles = new OrbBottles(canvas);
      this.camera.add(this.orbBottles.object3D);
      // A THREE object, not DOM — the .pre-run CSS class that hides RunHud
      // can't reach it. startRun() flips this back on; pre-run it would
      // otherwise show a full/idle readout under the title screen's dim.
      this.orbBottles.object3D.visible = false;
      this.scene.add(this.camera);
      // A death gets a small grey pop on top of RunManager's gem/kill wiring —
      // pure look, layered over the callback it already installed. The real
      // per-element shatter is M3's job.
      const runDeath = this.enemySystem.onDeath;
      this.enemySystem.onDeath = (x, z, element, elite) => {
        runDeath(x, z, element, elite);
        _deathPos.set(x, 0.7, z);
        this.bursts.spawn(BurstMode.AIR, _deathPos, {
          radius: 0.3, endRadius: 1.2, life: 0.35, intensity: 0.55, opacity: 0.65
        });
        this.deathShards.burst(x, z, element, elite);
        // 微顿帧 (M5 Task 9): an elite kill is one of the run's big moments.
        if (elite) {
          this.shake.add(0.4, 0.48, 20);
          this.flash.trigger(getColor('#ff3226'), 0.25);
          this._triggerHitstop();
        }
      };
      // Frame-loop scratch: the verdict box and the tick closure are minted
      // once here so advance() never allocates per frame.
      this._verdict = { value: 'playing' };
      this._runTick = (step) => {
        // A hand (level-up or shard) can open mid-tick, inside this very
        // call (onShardHand fires synchronously from pickups.tick()). Bail
        // on every further sub-tick this same advance() call — queued time
        // for the rest of this frame's dt evaporates, exactly as it does
        // whenever a frame starts already frozen (advance() never runs then).
        if (this.upgradeUi.isOpen) return;
        this._verdict.value = this.run.tick(step, this.character.position);
      };
      this._lastHp = settings.run.playerHp;
      /** The 本命 the title screen picked (or #run=quick's default loadout[0])
       * — remembered so 重开 reseats the same starting skill even after seat
       * 0 has since fused into something else (see startRun()/_restart()). */
      this._chosenElement = null;
      this._hintsDone = loadHintsDone();
      this._hintsBuilt = false;
    }

    /* ---- character ---- */
    this.character = new CharacterController(this.environment);
    this.scene.add(this.character.root);
    // M6 T4: the one caster-position source every ability context can read
    // regardless of mode (unlike `playerState`, sandbox-absent) — OrbitAuraSkill
    // pins a permanent aura's position to it every frame.
    this.abilities.ctx.character = this.character;

    /* ---- input & targeting ---- */
    this.input = new InputManager(canvas);
    this.aim = new AimController(this.camera);
    this.scene.add(this.aim.object3D);

    /* ---- post ---- */
    this.post = new PostProcessing(this.renderer, this.scene, this.camera);

    /* ---- UI ---- */
    this.loading = new LoadingScreen();
    this.hud = new HUD(document.getElementById('hud'));
    this.editor = new Editor({
      runMode: this.runMode,
      onClear: () => this.clearEffects(),
      onToast: (message) => this.hud.showToast(message),
      onResetDummies: () => this.dummies.reset(),
      onCharacter: (id) => this._switchCharacter(id)
    });

    if (this.runMode) {
      // 脚下淡光圈 (spec §5.7 敌我可读性): same thin-RingGeometry +
      // additive-MeshBasicMaterial shape EnemyRenderer's spawn telegraphs and
      // Arena's boundary arc already use, parented straight onto
      // `character.root` — position + yaw only (the cast lunge/lean live on
      // the child `tilt` group instead), so the ring tracks the player for
      // free every frame, through dodges included, without ever tilting off
      // the floor mid-cast. Built once; `character.dispose()` already walks
      // and disposes every descendant of `root`, so no separate teardown.
      const footRing = new Mesh(
        new RingGeometry(0.6, 0.75, 32).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({
          color: 0xfff2c8,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          blending: AdditiveBlending
        })
      );
      footRing.position.y = 0.02;
      footRing.layers.set(LAYER.VFX);
      this.character.root.add(footRing);

      // No _syncBadges() here any more: the loadout is still empty at this
      // point (startRun() hasn't drafted a seat yet, whether that's about to
      // happen immediately below for #run=quick or only later, on the title
      // screen's pick) — startRun() itself syncs once real seats exist.
      this.run.onTideTurn = (element) => this.hud.showToast(wuxingPhrase(element, 'run.tideTurn'));
      // 微顿帧 (M5 Task 9): a sheng detonation is a big moment. Elite kills and
      // 禁咒 fire trigger it from their own App-side call sites instead.
      this.run.onBigMoment = () => {
        this.shake.add(0.25, 0.3, 20);
        this.flash.trigger(getColor('#ff3226'), 0.15);
        this._triggerHitstop();
        this.audio.play('reaction');
      };
      // A shard only ever offers its own wuxing (spec 残章定向手). Reuses the
      // same upgradeUi instance — and so the same freeze gate — as a level-up
      // hand; an empty offer (no ability of that wuxing exists yet) falls back
      // to the level-up hand's own skip-heal. Structurally can't fire once the
      // run has stopped: RunManager.tick() bails at the top on `!this.active`
      // before it ever reaches the pickup loop that calls this.
      this.run.onShardHand = (element) => {
        // Death wins the tick (M2 5bbdda5): contact/projectile damage lands
        // before pickups.tick() runs within the same RunManager.tick() call,
        // so a shard collected in the tick that kills the player must not
        // open a hand over a dead run.
        if (!this.playerState.alive) return;
        const hand = this.upgradePool.draw(this.pickups.level, this.pickups.level, element);
        if (!hand.length) {
          this._skipHeal();
          this.hud.showToast(t('run.shardFizzle'));
        } else {
          this.upgradeUi.open(hand, { rerolls: 0, summary: this._buildSummaryLines().join('　') });
        }
      };

      // The side panels fold away entirely during a run; these two arrow tabs
      // (and G / H as ever) bring them back.
      this._panelTabs = [];
      for (const [side, cls, openLabel, closedLabel] of [
        ['left', 'help-open', '‹', '›'],
        ['right', 'editor-open', '›', '‹']
      ]) {
        const tab = document.createElement('button');
        tab.className = `run-tab run-tab--${side}`;
        tab.textContent = closedLabel;
        tab.addEventListener('click', () => {
          const open = document.body.classList.toggle(cls);
          tab.textContent = open ? openLabel : closedLabel;
        });
        document.body.appendChild(tab);
        this._panelTabs.push(tab);
      }
    }

    this._bindEvents();
    this.selectAbility(ELEMENTS[0], { silent: true });

    this._focusPoint = new Vector3();

    /* ---- movement scratch, reused every frame ---- */
    this._moveAxis = new Vector2();
    this._moveDir = new Vector3();
    this._camForward = new Vector3();
    this._camRight = new Vector3();

    /** 翻滚闪避 (M5 Task 9): a sorcerer dodge lerps `_dodgeStart → _dodgeTarget`
     * over `_dodgeDuration` seconds instead of teleporting — see `frame()`'s
     * steer-gate. `_dodgeT >= _dodgeDuration` (true at construction, 0 >= 0)
     * means "no roll in flight", so `_steer` runs normally by default. */
    this._dodgeStart = new Vector3();
    this._dodgeTarget = new Vector3();
    this._dodgeT = 0;
    this._dodgeDuration = 0;

    // 标题屏 (spec §9/§9.5): #run shows it and waits for a card; #run=quick
    // skips straight to a run with the configured loadout — every prior
    // browser-verification script uses that hash, so this keeps them working
    // byte-for-byte with no title screen in the way. Built either way (even
    // for a quick start) so 回标题 always has an instance to show later.
    if (this.runMode) {
      document.body.classList.add('pre-run');
      this.titleScreen = new TitleScreen({
        onStart: (element) => this.startRun(element),
        onCharacter: (id) => this._switchCharacter(id)
      });
      if (location.hash === '#run=quick') this.startRun(settings.run.loadout[0]);
    }
  }

  /** The ability currently in the slot. */
  get element() {
    return this.abilities.selected;
  }

  /**
   * Run mode's freeze gate: a level-up/shard hand or the pause menu is a
   * full stop (spec: "run 模式暂停...=全停，含走位与施法"). Used to be spelled
   * out three separate times as `this.runMode && this.upgradeUi.isOpen`
   * (M2 review flagged the triplication) plus a fourth copy inside the
   * runMode-gated block further down; unified here rather than re-copied a
   * second cause into all four. Not cached into a local — every read is
   * fresh, which is what lets the two spots that specifically care about a
   * hand opening mid-tick (the echo/pendingLevels checks) just read this
   * again instead of tracking their own "frozen at frame-start" snapshot.
   */
  get _frozen() {
    return this.runMode && (this.upgradeUi.isOpen || this.pauseMenu.isOpen);
  }

  /* ------------------------------------------------------------------ */

  _bindEvents() {
    // Browsers refuse to run audio before a user gesture — one pointerdown,
    // anywhere on the page, is enough. Harmless in the sandbox too (it just
    // builds the AudioContext; nothing there ever calls GameAudio.play()).
    window.addEventListener('pointerdown', () => resumeAudio(), { once: true });

    this.renderer.onResize((width, height, pixelRatio) => {
      this.rig.resize(width, height);
      this.post.setSize(width, height, pixelRatio);
      this.dust.setPixelRatio(pixelRatio);
    });

    this.input.on('pointer:move', (pointer) => this.aim.point(pointer));
    this.input.on('pointer:confirm', (pointer) => {
      this.aim.point(pointer);
      if (this.runMode) {
        this._quickCast(this.loadout.elementAt(0));
        this._markHintDone('aim');
      } else {
        this.aim.confirm();
      }
    });
    this.input.on('action', (action, slot) => this._handleAction(action, slot));

    this.aim.on('cast', (origin, direction, distance) => this._cast(origin, direction, distance));
    this.aim.on('reject', () => this.hud.showToast('Too close — aim further out'));

    // Sandbox-only: run mode hides .hud__abilities outright (RunHud has its
    // own six-slot bar), so this callback can never fire during a run.
    this.hud.onAbility = (element) => this.armAbility(element);

    // RunHud's own slots: Shift+click toggles that seat's autocast, mirroring
    // Shift+digit (_handleAction's 'autocast' case). Seat-indexed already —
    // no element→seat lookup needed, unlike the sandbox card scheme this
    // replaces.
    if (this.runMode) {
      this.runHud.onSlotShiftClick = (seat) => this._toggleAutocast(seat);
    }
  }

  /**
   * Start (or restart) the run with `chosenElement` seated at slot 0 — the
   * title screen's pick (spec §9.5), or `#run=quick`/`_restart()`'s replay
   * of whatever was picked last. Never writes settings: `Loadout.draftFirst`
   * keeps the choice as run state only (spec's "数值分层" rule — the
   * sandbox's shipped `settings.run.loadout` is untouched either way).
   */
  startRun(chosenElement) {
    this._chosenElement = chosenElement;
    this.loadout.draftFirst(chosenElement);
    // 本命系 (spec §4.9): the ultimate's home element is whatever just got
    // seated at slot 0.
    this.ultimate.wuxing = fusionWux(this.loadout.elementAt(0));
    this.modifiers.reset();
    this.run.start();
    this._refreshResonance();
    this._syncBadges();
    this._syncAuras(); // M6 T4: covers both a fresh start and _restart()'s replay
    document.body.classList.remove('pre-run');
    this.orbBottles.object3D.visible = true;
    this.titleScreen.hide();
    // Hints are a once-ever-per-browser affair (localStorage), not a
    // per-run one — build them the first time a run actually begins, never
    // again on a later restart/return-to-title/restart cycle.
    if (!this._hintsBuilt) {
      this._hintsBuilt = true;
      this._buildHints();
    }
  }

  /** Transient run-session state a restart or a return to the title both
   * throw away — shared by `_restart()` and `_returnToTitle()`, which only
   * differ in what happens after (a fresh `startRun()` vs showing the title
   * screen again). Lifted straight from the pre-Task-11 restart handler. */
  _resetRunState() {
    this.clearEffects();
    this.verdictPanel.hide();
    for (const element of this.cooldowns.keys()) this.cooldowns.set(element, 0);
    this._autocast.clear();
    this._echoAt = null;
    this._lastCastWux = -1;
    this._lastCastAt = -Infinity;
    this._lastNoManaToastAt = -Infinity;
  }

  /**
   * 重开: reseat `_chosenElement` (the title's pick, not whatever seat 0
   * evolved into via fusion) and start fresh. Shared by the verdict
   * screen's Enter key and the pause menu's 重开 button, which differ only
   * in when each is allowed to fire — see their own call sites.
   */
  _restart() {
    this._resetRunState();
    this.startRun(this._chosenElement);
  }

  /** 回标题: stop the run, wipe the same transient state a restart does,
   * and show the title screen again so a different 本命 can be picked. */
  _returnToTitle() {
    this.run.stop();
    this._resetRunState();
    document.body.classList.add('pre-run');
    this.orbBottles.object3D.visible = false;
    this.titleScreen.show();
  }

  /** Build whichever hint lines a past session (localStorage) hasn't
   * already dismissed — nothing at all when every hint is already done. */
  _buildHints() {
    const remaining = HINT_IDS.filter((id) => !this._hintsDone[id]);
    if (!remaining.length) return;
    this._hintsRoot = document.createElement('div');
    this._hintsRoot.className = 'run-hints';
    this._hintsRoot.innerHTML = remaining
      .map((id) => `<div class="run-hints__line" data-hint="${id}">${t(`hint.${id}`)}</div>`)
      .join('');
    document.body.appendChild(this._hintsRoot);
  }

  /** Fade and forget one hint line — called from wherever its own action
   * first fires (movement, aim/click, dodge, 禁咒). Persists immediately, so
   * a hint dismissed this session never comes back on a later page load. */
  _markHintDone(id) {
    if (this._hintsDone[id]) return;
    this._hintsDone[id] = true;
    try {
      localStorage.setItem(HINTS_KEY, JSON.stringify(this._hintsDone));
    } catch {
      /* storage disabled/full — the fade below still happens this session */
    }
    this._hintsRoot?.querySelector(`[data-hint="${id}"]`)?.classList.add('is-done');
  }

  _handleAction(action, slot) {
    // A level-up hand or the pause menu is a full stop. Each owns its own
    // keydown listener already, swallowing the keyboard in the capture
    // phase before InputManager ever sees it; this is the double-check for
    // whatever reaches here another way (the HUD's click path).
    if (this._frozen) return;
    switch (action) {
      case 'ability': {
        if (this.runMode) {
          // Slot 3 (KeyF and Digit4 both emit it — InputManager doesn't know
          // about runMode, so it always emits ability/3 for either key) has
          // no loadout seat of its own (RUN_KEY_SLOTS has no 3 entry, so this
          // used to be a dead key in a run): that's exactly the seat 禁咒
          // borrows instead of adding a new key.
          if (slot === 3) { this._fireUltimate(); break; }
          // Keys cast their loadout seat straight away; unseated keys do nothing.
          const seat = RUN_KEY_SLOTS[slot];
          if (seat !== undefined) this._quickCast(this.loadout.elementAt(seat));
          break;
        }
        const element = ELEMENTS[slot] ?? this.element;
        // Pressing the *same* key again puts an armed cast away, as it does in a
        // MOBA; pressing a different one swaps the slot without disarming.
        if (this.aim.isArmed && element === this.element) this.aim.cancel();
        else this.armAbility(element);
        break;
      }
      case 'autocast':
        // slot here is the loadout seat directly (Shift+digit maps 1:1 to
        // seats — unlike 'ability' above, there is no RUN_KEY_SLOTS detour).
        if (this.runMode) this._toggleAutocast(slot);
        break;
      case 'rightclick':
        // A right click that never became a camera drag: the sandbox reads it
        // as "put the cast away", the run mode as the second loadout seat.
        if (this.runMode) this._quickCast(this.loadout.elementAt(1));
        else this.aim.cancel();
        break;
      case 'cancel':
        // Sandbox semantics untouched: Esc puts an armed cast away. In a
        // run it opens the pause menu instead — only while the run is
        // actually live, not over the verdict screen (run.stop() has
        // already run by then; a second Esc there would have nothing
        // sensible to pause). A pause menu already open can't reach this
        // case at all (its own capture-phase listener eats Escape first),
        // so this never needs to double as a close.
        if (this.runMode) {
          if (this.run.active) this.pauseMenu.open();
        } else {
          this.aim.cancel();
        }
        break;
      case 'dodge': {
        if (this.runMode) this._markHintDone('dodge');
        // M6 T6 fix round: the lerp channel has one target at a time (see
        // `_dashing`'s own doc) — a dodge pressed while it's already in
        // flight (a dash, or an earlier dodge's own roll window) must not
        // spend a second cooldown+i-frames for a displacement the
        // still-running lerp would silently overwrite next frame. Checked
        // before `tryDodge()`, not after, so neither the cooldown nor the
        // i-frames are ever spent on a dodge that can't actually move you.
        if (this.runMode && this._dashing) break;
        if (!this.runMode || !this.playerState.tryDodge()) break;
        // Dash along the current move axis, or facing when standing still.
        const axis = this.input.moveAxis(this._moveAxis);
        this._camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this._camForward.y = 0;
        this._camForward.normalize();
        this._camRight.crossVectors(this._camForward, UP);
        this._moveDir.copy(this._camRight).multiplyScalar(axis.x)
          .addScaledVector(this._camForward, axis.y);
        if (this._moveDir.lengthSq() < 0.01) {
          this._moveDir.set(Math.sin(this.character.facing), 0, Math.cos(this.character.facing));
        }
        this._moveDir.normalize();
        if (this.character.hasRoll) {
          // Sorcerer (spec 裁定5): play the roll and spread the displacement
          // over its window instead of teleporting — frame()'s steer-gate
          // lerps `_dodgeStart → _dodgeTarget` while `_dodgeT < _dodgeDuration`.
          // dodgeIframes covers essentially all of that window (see
          // settings.run.dodgeRollWindow's own comment on the small gap).
          this.character.setFacing(Math.atan2(this._moveDir.x, this._moveDir.z));
          this.character.playRoll(settings.run.rollSpeed);
          this._dodgeStart.copy(this.character.root.position);
          this._dodgeTarget
            .copy(this.character.root.position)
            .addScaledVector(this._moveDir, settings.run.dodgeDistance);
          this._dodgeDuration = Math.min(
            this.character.rollDuration / settings.run.rollSpeed,
            settings.run.dodgeRollWindow
          );
          this._dodgeT = 0;
        } else {
          // classic: no roll clip — the original instant teleport (spec 裁定5 fallback).
          this.character.root.position.addScaledVector(this._moveDir, settings.run.dodgeDistance);
        }
        break;
      }
      case 'restart':
        // Enter only restarts at the verdict screen — deliberately narrower
        // than the pause menu's 重开 button (see _restart()'s own callers),
        // so a stray Enter mid-fight can't blow away a live run.
        if (this.runMode && !this.run.active) this._restart();
        break;
      case 'toggleHelp':
        this.hud.toggleHelp();
        break;
      case 'toggleEditor':
        this.editor.toggle();
        break;
      case 'clear':
        this.clearEffects();
        this.hud.showToast('Effects cleared');
        break;
      case 'togglePause':
        this.paused = !this.paused;
        this.hud.setPaused(this.paused);
        this.hud.showToast(this.paused ? 'Paused — the editor still applies' : 'Resumed');
        break;
      default:
        break;
    }
  }

  /**
   * Put an ability in the slot. The aim indicator and the HUD both follow,
   * because `range` and `minRange` are the ability's, not the app's.
   */
  selectAbility(element, options = {}) {
    if (!ELEMENTS.includes(element)) return;
    this.abilities.select(element);
    this.aim.setElement(element);
    this.hud.setElement(element, options);
  }

  /** Select an ability and arm it, unless it is still cooling down. */
  armAbility(element = this.element) {
    if ((this.cooldowns.get(element) ?? 0) > 0) {
      this.hud.showToast('Not ready');
      return;
    }
    // Selecting before arming means the arrow is already drawn to the new
    // ability's range on the frame it appears.
    if (element !== this.element) this.selectAbility(element);
    this.aim.arm();
  }

  /**
   * The one real character-switch path (spec: 角色系统已实装), shared by the
   * sandbox editor's dropdown and the title screen's own — so there is
   * exactly one place that knows how to load a character and report it.
   */
  _switchCharacter(id) {
    this.hud.showToast(t('char.loading'));
    this.character
      .setCharacter(id, this.assets)
      .then(() => this.hud.showToast(`${t('char.switched')}${id}`))
      .catch((error) => {
        console.error('[App] character switch failed', error);
        this.hud.showToast(t('char.loadFailed'));
      });
  }

  /**
   * Flip a loadout seat's autocast flag — shared by the Shift+digit key and
   * the badge's Shift+click. An empty seat has nothing to toggle (账本 guard:
   * never let a null element reach the loadout/cooldown maps downstream).
   */
  _toggleAutocast(seat) {
    if (this.loadout.elementAt(seat) === null) return;
    if (this._autocast.has(seat)) this._autocast.delete(seat);
    else this._autocast.add(seat);
    this._syncBadges();
  }

  /**
   * Run mode's casting verb: no arm/confirm dance, straight from the pointer.
   * A fusion seat (spec §4.7) resolves one shared ground point off whichever
   * parent reaches further — `_quickCastToward` already knows how to fire a
   * fused pair from a target point, so this just hands off to it, tagged as
   * a manual (non-autocast) cast.
   */
  _quickCast(element) {
    if (!element) return;
    // 光环装备即常驻 (M6 T4): no cast, no cooldown, no cast key — a seat's key
    // press must be a no-op for an aura element, or pressing it would fire a
    // second, ordinary-lifecycle instance through this pipeline on top of the
    // permanent one _syncAuras() already keeps running (see its own doc).
    if (settings.combat[element]?.kind === 'aura') return;
    if (isFusionId(element)) {
      if ((this.cooldowns.get(element) ?? 0) > 0) return;
      // M7 T1: no more parent aim.setElement borrow. The old borrow existed
      // to resolve a range/direction through *some* element's config — but
      // AimController#_resolve derives `direction` purely from the pointer
      // raycast against `origin` (see its own source): it never reads
      // `this.element` at all, only `.valid`/`.distance` do, and this needs
      // neither. So resolving on whatever element `aim` currently happens to
      // be armed with is already correct — nothing to swap out and restore.
      // The fusion's own range now lives in settings.fusions, not a parent.
      //
      // M7 T1 fix round (reviewer-caught): the target point must land where
      // the cursor actually is, clamped to the fusion's own range — same
      // "zone" contract every other point/zone cast follows (spec, and
      // _quickCastToward's own doc a few lines down) — not always thrown to
      // max range. `aim.distance` is already clamped to *whatever element
      // is currently armed*, which is the wrong range for a fusion, so this
      // reads the pre-clamp `aim.rawDistance` (AimController's own fix
      // round addition) and clamps it against the fusion's row instead.
      const row = settings.fusions[pairKeyOf(element)];
      this.aim._resolve();
      const dist = Math.min(this.aim.rawDistance, row.range);
      const tx = this.aim.origin.x + this.aim.direction.x * dist;
      const tz = this.aim.origin.z + this.aim.direction.z * dist;
      this._quickCastToward(element, tx, tz, false);
      return;
    }
    if (!ELEMENTS.includes(element)) return;
    if ((this.cooldowns.get(element) ?? 0) > 0) return;
    if (element !== this.element) this.selectAbility(element, { silent: true });
    this.aim.quickCast();
  }

  /**
   * 禁咒 (spec §4.9): F/Digit4's run-mode verb, routed here from
   * `_handleAction`'s `case 'ability'` when slot === 3. A ready cast clears
   * on its own (`Ultimate#fire`) and gets the big feedback — full-field
   * effects don't otherwise show up on screen the way a thrown spell does;
   * a refused one just toasts, spending nothing. Doesn't freeze the world
   * either way (禁咒 is a burst inside combat, not a menu).
   *
   * Guard shape matches autocast's own loop in frame() — this._frozen is
   * already caught by _handleAction's early return above this switch, so
   * only the run-over half needs repeating here.
   */
  _fireUltimate() {
    this._markHintDone('ult'); // awareness of the key, not a successful cast — charge starts at 0
    if (!this.run.active || this._verdict.value !== 'playing') return;
    if (this.ultimate.fire(this.character.position)) {
      this.flash.trigger(getColor('#fff2c8'), 0.45);
      this.shake.add(1, 1.2, 20);
      this._triggerHitstop();
      this.hud.showToast(t('ult.fired'));
    } else {
      this.hud.showToast(t('ult.notReady'));
    }
  }

  /**
   * 微顿帧 (M5 Task 9): called from the run's few "big moments" (禁咒 fire
   * above, an elite death, a sheng detonation via `run.onBigMoment`). The
   * actual slow lives in `frame()`'s dt computation; this just arms the
   * timer `addHitstop` caps at `settings.run.hitstopCap`, so repeated
   * triggers inside one window extend it rather than stacking past the cap.
   */
  _triggerHitstop() {
    this._hitstop = addHitstop(this._hitstop);
  }

  /**
   * 相生轮转 (spec §4.8): track the cast chain and refund the cooldown when
   * this cast follows its generating parent inside the window. Every cast
   * path — manual, echo, autocast — must pass through here after writing
   * its cooldown, or chains silently break (M4 Task 7 review).
   */
  _applySequence(element) {
    const wux = fusionWux(element);
    if (sequenceRefund(this._lastCastWux, this._lastCastAt, wux, this.run.elapsed)) {
      this.cooldowns.set(element, this.cooldowns.get(element) * settings.sequence.refund);
      this.hud.showToast(t('run.sequenceChain'));
    }
    this._lastCastWux = wux;
    this._lastCastAt = this.run.elapsed;
  }

  /** Throttled `run.noMana` toast (M6 T3) — checked `armAbility`'s 'Not
   * ready' toast for a throttle to reuse and found none (that one is
   * click-gated, not held, so it never needed one); a mana-gated cast can
   * be mashed the same way while the pool sits empty, so this gets its own
   * simple 0.5s repeat-suppression field instead. */
  _toastNoMana() {
    if (this.run.elapsed - this._lastNoManaToastAt < 0.5) return;
    this._lastNoManaToastAt = this.run.elapsed;
    this.hud.showToast(t('run.noMana'));
  }

  /**
   * M6 T6 fix round (reviewer-caught): true while the physical dash/dodge
   * lerp (`_dodgeStart → _dodgeTarget`, driven by `frame()`'s steer-gate) is
   * still in flight. The channel has exactly one target at a time — a
   * second write into `_dodgeStart`/`_dodgeTarget`/`_dodgeT`/`_dodgeDuration`
   * while one is already running doesn't queue, it *overwrites*, so the
   * still-running lerp simply teleports to wherever the OLD target was one
   * more frame and then snaps onto the new one — the first displacement
   * never actually happens, but its cooldown/resource already got spent.
   * This is the exclusivity gate both a second dodge (`case 'dodge'`) and a
   * dashstrike cast (`_cast`/`_quickCastToward`, below) check before
   * spending anything. `0 < 0` is false, so a fresh app (or one that has
   * never dashed) reads `false` by construction — no separate "never
   * dashed yet" case needed.
   */
  get _dashing() {
    return this._dodgeT < this._dodgeDuration;
  }

  /** True when casting `element` would run DashStrikeSkill's own
   * displacement hook — i.e. the set `_dashing` needs to gate against.
   * M7 T1: narrowed back to the literal id. A fused pair used to inherit
   * this from a dashstrike parent (the old per-parent cast loop actually
   * called `_dashDisplace` for that part); fusing now casts one bespoke
   * ability instead, and none of the five gives the caster a teleport, even
   * when dashstrike is one of its two parents (锋岩星阵/霜刃洪流) — the fused
   * spell is a wholly different skill, not "dashstrike plus something". */
  _castsDash(element) {
    return element === 'dashstrike';
  }

  /**
   * M6 T6 (弑神一闪): the physical half of a dashstrike cast. The ability
   * class itself is pure VFX+damage, like every other ability (see
   * DashStrikeSkill's own doc) — the caster's own teleport rides the exact
   * displacement channel a dodge-roll already uses (`_dodgeStart`/
   * `_dodgeTarget` lerped by `frame()`'s steer-gate) plus the same i-frames
   * `PlayerState#tryDodge` grants, so this is the one place that has to
   * know dashstrike is special. Deliberately *not* `playerState.tryDodge()`
   * itself — that also gates and spends the separate dodge-roll cooldown,
   * which has nothing to do with dashstrike's own (already-gated, five/six-
   * field) cast pipeline.
   *
   * Called from every real-cast site that can construct a dashstrike
   * ability (`_cast`, `_quickCastToward`'s plain branch and its fusion-part
   * loop) — never from a demo cast (see `_quickCastToward`'s own `!demo`
   * guard at its call site): the level-up hand is still open and the world
   * still frozen the instant a demo fires, so queuing a teleport there would
   * either be silently dropped or fire stale once the hand closes, neither
   * of which reads as the "free instant preview" the demo is supposed to be.
   * By the time this runs, `_castsDash`+`_dashing` has already refused the
   * cast outright if the channel was busy (see both call sites) — this
   * never has to defend against overwriting a lerp itself.
   *
   * Run-mode only — the sandbox has no playerState/character-lerp channel
   * to move (contract: sandbox casts are VFX-only, the character stays put).
   *
   * @param {number} range M6 T12 fix round: the caller's own already-scaled
   *   `scaledDashRange(level)` (DashStrikeSkill.js) — the SAME number it
   *   passed to `abilities.cast()` as this cast's `distance`, so the body
   *   lands exactly where the damage line/ribbon/flash already reached
   *   (reviewer-caught: this used to recompute its own scaling here while
   *   the cast distance stayed unscaled elsewhere, and the two could drift).
   */
  _dashDisplace(direction, range) {
    if (!this.runMode) return;
    const start = this.character.root.position;
    const target = dashTarget(start.x, start.z, direction.x, direction.z, range, settings.character.roamRadius);
    this._dodgeStart.copy(start);
    this._dodgeTarget.set(target.x, 0, target.z);
    // The ability's own travel timing (range/speed) already lands its VFX
    // impact at ~0.2s — inside the brief's own 0.15-0.25s dash-duration
    // ballpark — so the physical body rides the identical window and
    // arrives with it, rather than a second, independently-tuned duration.
    this._dodgeDuration = Math.max(0.05, range / Math.max(1, settings.dashstrike.speed));
    this._dodgeT = 0;
    this.playerState.iframes = Math.max(this.playerState.iframes, settings.run.dodgeIframes);
  }

  /**
   * M6 T12 (冰枪 Lv5 castTwice): fires a second bolt at a small angle offset
   * the instant the first one's own `abilities.cast()` already succeeded —
   * straight through AbilityManager, bypassing every gate the triggering
   * cast already cleared (mana/cooldown/sequence/echo), the same way a
   * fusion's second parent does. One trigger, one stamp: this never touches
   * `this.cooldowns`/`_applySequence`/`_echoAt` itself, so both bolts share
   * the single write the caller already made for the first. Still a full,
   * independent Ability spawn (pooled like any other cast, its own
   * `autocast`/`fusionMult`/`quenched` written so a reused instance never
   * carries a stale flag forward — same five-field rule every other spawn
   * site in this file follows), just copying the triggering bolt's own
   * flags rather than re-deriving them.
   *
   * No-op with nothing to fire twice yet (only ice carries `castTwice`
   * today) or when the triggering cast itself never went off (a refused
   * cast, or an aura this never applies to in the first place).
   */
  _maybeCastTwice(element, ability, origin, direction, distance) {
    if (!ability) return;
    const level = this.loadout ? this.loadout.levelOf(element) : 1;
    if (!bpFlag(element, 'castTwice', level)) return;
    const cos = Math.cos(CAST_TWICE_ANGLE);
    const sin = Math.sin(CAST_TWICE_ANGLE);
    _twiceDir.set(direction.x * cos - direction.z * sin, 0, direction.x * sin + direction.z * cos);
    const second = this.abilities.cast(origin, _twiceDir, distance, element);
    if (second) {
      second.autocast = ability.autocast;
      second.fusionMult = ability.fusionMult;
      second.quenched = ability.quenched;
    }
  }

  _cast(origin, direction, distance) {
    const element = this.element;
    // M6 T6 fix round: the dash/dodge lerp channel is exclusive (see
    // `_dashing`'s own doc) — refused upfront, before the mana gate and
    // every other five-field write, same "a refused cast writes nothing"
    // shape the mana gate itself already follows. `element` here is never a
    // fusion id (`_cast` is only ever reached via `aim.quickCast()`'s 'cast'
    // event, which `_quickCast` never routes a fusion id through — see its
    // own branch), so `_castsDash` degrades to the plain `=== 'dashstrike'`
    // check, but stays the one shared predicate with `_quickCastToward`.
    if (this.runMode && this._dashing && this._castsDash(element)) return;
    // 法力消费门 (M6 T3, spec 锚2.5): run-mode only — sandbox never
    // constructs `playerState`, same reason every `this.runMode ?` guard
    // below this one exists. Sits before every side effect a real cast has
    // (ability spawn, quench, cooldown write, sequence stamp, echo arm), so
    // a failed gate leaves all of them untouched. `_cast` never carries a
    // `demo` of its own (only `_quickCastToward` does), but a non-fusion
    // echo re-fire reaches here too, through `_quickCast` → `aim.quickCast()`'s
    // 'cast' event, while `this._echoing` is still true around that whole
    // call (armed in `frame()`'s echo block) — exempt it the same way
    // `_quickCastToward`'s own copy of this gate does.
    if (this.runMode) {
      const echo = this._echoing;
      const { ok, cost } = canAffordCast(element, this.playerState, { echo });
      if (!ok) {
        this._toastNoMana();
        return;
      }
      if (cost > 0 && !echo) this.playerState.spendMana(cost);
    }
    // M6 T12 fix round: dashstrike's cast distance and its physical
    // teleport must share the exact same scaled range (scaledDashRange's
    // own doc) — resolved once, before the spawn, so `abilities.cast()`
    // and `_dashDisplace()` below can never disagree the way they used to
    // (reviewer-caught: the teleport scaled, the cast distance didn't).
    const castDistance =
      element === 'dashstrike'
        ? scaledDashRange(this.loadout ? this.loadout.levelOf('dashstrike') : 1)
        : distance;
    const ability = this.abilities.cast(origin, direction, castDistance, element);
    // Written on every cast through here (sandbox, manual run cast, echo) so
    // a pooled instance never carries an autocast tax over from a previous
    // life (M1 勘误 same shape) — only `_quickCastToward` ever writes true.
    // fusionMult/quenched ride the same rule (M4 final review I2/I3): a
    // pooled instance keeps its expandos across lives, so every cast writes
    // every field rather than trusting a stale one to be falsy/1 already.
    // `this.runMode ?` guards sandbox, where `this.modifiers` never exists.
    if (ability) {
      ability.autocast = false;
      ability.fusionMult = 1;
      ability.quenched = this.runMode ? this.modifiers.consumeQuench(element) : false;
    }
    // M6 T6: see _dashDisplace's own doc — sandbox-safe via its own runMode
    // guard, so this only needs the element check.
    if (element === 'dashstrike') this._dashDisplace(direction, castDistance);
    // M6 T12: see _maybeCastTwice's own doc — sandbox-safe (this.loadout is
    // undefined there, reading as a constant Lv1/never armed).
    this._maybeCastTwice(element, ability, origin, direction, castDistance);
    const cdMult = this.runMode ? this.modifiers.cooldownMult() : 1;
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown * cdMult));

    if (this.runMode) {
      this._applySequence(element);
      this.audio.play(CAST_SOUND[fusionWux(element)]);
    }

    // 施法回响: a run-mode cast has a chance to fire itself once more.
    if (this.runMode && !this._echoing && this.runRng() < this.modifiers.echoChance()) {
      if (this._echoAt) {
        /* an echo is already queued — a second proc inside the snapback
           window would overwrite and eat the first; drop this one instead */
      } else {
        this._echoAt = { element, t: 0.15 };
      }
    }

    // Snap onto the shot and throw the body into it. Which clip that is belongs
    // to the ability, so each spell can be cast with its own gesture.
    this.character.setFacing(this.aim.facing);
    this.character.playCast(settings[element].castAnim);
    this.character.castLunge();
  }

  /**
   * Autocast's casting verb — like `_quickCast`, but aimed at a world point
   * instead of the cursor, so it resolves direction/distance itself rather
   * than going through `aim.quickCast()`'s pointer raycast. Deliberately
   * never touches `this.aim` or `this.abilities.selected`: those drive the
   * player's own aim arrow and the HUD's active-slot highlight, and a
   * background slot firing must not hijack either out from under a manual
   * aim in progress.
   *
   * Direction points straight at the target. Line abilities throw at full
   * range, same as a manual quick-cast; zone casts and burst-kind line casts
   * (meteor: the rock detonates wherever `length` ends) land at the
   * target's own distance instead, clamped to `[minRange, range]` — the
   * same reason `AimController#quickCast` keeps meteor's cursor-resolved
   * distance rather than always throwing it to max range (or the rock
   * sails past whatever it was actually aimed at), and the same floor
   * `_resolve()` applies to every aimed distance so a cast can never be
   * asked to land closer than the ability's own minimum.
   *
   * A fusion seat (spec §4.7, M7 T1) casts ONE bespoke ability at this
   * point — `element` is the fusion id itself, not a parent, and it spawns
   * exactly once, not per-parent back-to-back the way the pre-M7 skeleton
   * did. Its row (`settings.fusions[pairKeyOf(element)]`) supplies the
   * cooldown/range/castAnim a plain element would otherwise read off its
   * own `settings[element]`; `fusionMult` scales off the fusion's OWN level
   * (`1 + settings.fusion.levelMult × (lv-1)`, the retired per-cast ×budget
   * folded into each row's Lv1 numbers instead); `quenched` spends once
   * against the generated half (子系, spec §4.7 挂印取子系), never per
   * parent. A plain element's per-parent aura skip is gone along with the
   * loop it guarded — an aura half used to be excluded here only because
   * the old loop would otherwise recast it, and there's no loop left to
   * recast anything. `autocast` tells apart a background seat's own cast
   * (the only caller until this task) from `_quickCast`'s manual fusion
   * hand-off, which resolves a pointer-aimed target point (clamped to the
   * fusion's own range, same zone contract as the paragraph above) and
   * forwards here as `false`.
   *
   * `demo` (spec §6 新技能即时演示): `_onUpgradeChoice`'s free show-off shot
   * for a freshly acquired active. Every per-ability field below is still
   * written on every cast (pooled instances would otherwise carry a stale
   * expando into their next life — same M1/M4 rule the comments above and
   * in `_cast` already document), just with the inert values a cast that
   * costs nothing should carry: no cooldown, no quench spend, and no stamp
   * on the 相生 chain (a demo firing itself would both wrongly refund off
   * whatever the player last cast for real, and let a later real cast wrongly
   * chain off *it*).
   */
  _quickCastToward(element, tx, tz, autocast = true, demo = false) {
    if (!element || (this.cooldowns.get(element) ?? 0) > 0) return;
    // M6 T4: see _quickCast's own copy of this guard — this is the funnel for
    // autocast, the acquire-a-new-active demo shot, and a fusion hand-off's
    // shared target point, so an aura seat has to be refused here too.
    if (settings.combat[element]?.kind === 'aura') return;
    // M6 T6 fix round: same exclusive-channel refusal `_cast` applies, ahead
    // of the mana gate/any five-field write (see `_dashing`'s own doc).
    // Skipped for a demo cast — `_dashDisplace`'s own `!demo` guard means a
    // demo never touches the lerp channel at all, so there is no collision
    // here for this to prevent.
    if (this.runMode && !demo && this._dashing && this._castsDash(element)) return;

    const origin = this.character.position;
    const dx = tx - origin.x;
    const dz = tz - origin.z;
    const rawDist = Math.hypot(dx, dz);
    if (rawDist < 1e-6) return; // degenerate: target sits exactly on the caster
    const direction = { x: dx / rawDist, y: 0, z: dz / rawDist };

    // 法力消费门 (M6 T3, spec 锚2.5): run-mode only, mirrors `_cast`'s own
    // copy above. A fused cast is charged exactly once here — at the max of
    // its two parents' manaCost (manaGate.js's `manaCostOf`, dispatch-
    // authorized: "the slower parent sets the pace", rather than summing
    // both parents' pools — untouched by M7's bespoke-cooldown rewrite
    // below, which only changed how the *cooldown* itself is priced).
    // Sits before consumeQuench/the ability spawn/cooldown write/sequence
    // stamp/echo arm below, so a failed gate leaves every one of them untouched.
    // Demo and echo (`this._echoing`, armed around the echo's own
    // `_quickCast` call in frame()) always afford; a failed autocast
    // (background seat) skips the toast — only a manual miss earns the
    // throttled one.
    if (this.runMode) {
      const echo = this._echoing;
      const { ok, cost } = canAffordCast(element, this.playerState, { demo, echo });
      if (!ok) {
        if (!autocast) this._toastNoMana();
        return;
      }
      if (cost > 0 && !demo && !echo) this.playerState.spendMana(cost);
    }

    let castAnim;
    if (isFusionId(element)) {
      // M7 T1: one bespoke ability now, not a per-parent loop — two spells
      // became one (spec §4.7), so this spawns exactly the fusion id itself.
      // No aura-parent skip and no dash-displace hook needed any more
      // either: an aura half was only ever skipped here because the loop
      // would otherwise recast it — there is no loop now. A bespoke fusion
      // has no teleport of its own even when dashstrike is one of its two
      // parents (`_castsDash` narrows to the literal 'dashstrike' id — see
      // its own doc).
      const row = settings.fusions[pairKeyOf(element)];
      const b = fusionParents(element)[1]; // 子系 (generated half) — spec §4.7 挂印取子系
      const fusionMult = 1 + settings.fusion.levelMult * (this.loadout.levelOf(element) - 1);
      // 淬炼 spends once per fused cast action, keyed off the child (b) —
      // same "one spend, not one per parent" rule the old per-parent loop
      // already followed (I3). A demo never spends it: consumeQuench(b) is
      // skipped outright rather than called and discarded.
      const quenched = !demo && this.runMode ? this.modifiers.consumeQuench(b) : false;
      // Mirrors _quickCastDistance's own ZONE-shaped clamp (follow the
      // target point up to the ability's own range) — a fused seat has no
      // ELEMENT_META cast shape of its own for castShapeOf() to read, so
      // that helper can't resolve it directly; every fusion mechanic (burst/
      // aura/self-resolved alike) is cast toward a point the same way a zone
      // ability is, so this is the one shape that fits all five.
      const dist = Math.max(0.4, Math.min(rawDist, row.range));
      const ability = this.abilities.cast(origin, direction, dist, element);
      if (ability) {
        ability.autocast = autocast;
        ability.fusionMult = fusionMult;
        ability.quenched = quenched;
      }
      if (!demo) {
        this.cooldowns.set(element, Math.max(0, row.cooldown * this.modifiers.cooldownMult()));
      }
      castAnim = row.castAnim;
    } else {
      const c = settings[element];
      // M6 T12 fix round: same shared-scale rule as _cast above — dashstrike's
      // cast distance and its physical teleport share the exact same
      // scaledDashRange(level), resolved once, before the spawn.
      const dist =
        element === 'dashstrike'
          ? scaledDashRange(this.loadout ? this.loadout.levelOf('dashstrike') : 1)
          : this._quickCastDistance(element, rawDist);
      const ability = this.abilities.cast(origin, direction, dist, element);
      if (ability) {
        ability.autocast = autocast;
        ability.fusionMult = 1;
        ability.quenched = !demo && this.runMode ? this.modifiers.consumeQuench(element) : false;
      }
      // M6 T6: see _dashDisplace's own doc for why !demo — autocast dashing
      // into a crowd is a real, intentional consequence of the toggle.
      if (element === 'dashstrike' && !demo) this._dashDisplace(direction, dist);
      // M6 T12: see _maybeCastTwice's own doc — reachable here via autocast
      // (a Lv5 ice seat with autocast toggled on) or a demo (moot in
      // practice: a demo only ever fires right after acquiring a skill,
      // always Lv1, so bpFlag never arms — left unconditional for the same
      // reason autocast/fusionMult/quenched above are always written).
      this._maybeCastTwice(element, ability, origin, direction, dist);
      if (!demo) this.cooldowns.set(element, Math.max(0, c.cooldown * this.modifiers.cooldownMult()));
      castAnim = c.castAnim;
    }

    // Autocast is only ever invoked from the runMode-gated loop in frame(),
    // so this.run/this.audio always exist here — no `if (this.runMode)` gate
    // needed (same assumption _cast's cdMult/echo lines below already make).
    // A fusion cast plays one sound for the pair, keyed the same 子系 way
    // its mark identity already is (fusionWux handles both cases).
    if (!demo) this._applySequence(element);
    this.audio.play(CAST_SOUND[fusionWux(element)]);

    // 施法回响 applies here exactly as it does to a manual cast (spec: any
    // cast can proc it); see `_cast`'s own copy of this same roll. A demo
    // cast must never arm a real echo — its echo proc roll is gated by !demo.
    if (!demo && !this._echoing && this.runRng() < this.modifiers.echoChance() && !this._echoAt) {
      this._echoAt = { element, t: 0.15 };
    }

    this.character.setFacing(Math.atan2(direction.x, direction.z));
    this.character.playCast(castAnim);
    this.character.castLunge();
  }

  /** Shared by both branches above: one element's distance for a
   * target-point cast — full range for a line shape that isn't burst-kind,
   * the target's own distance (clamped to `[minRange, range]`) for a zone
   * shape or a burst-kind line (meteor). */
  _quickCastDistance(element, rawDist) {
    const c = settings[element];
    const zoned = castShapeOf(element) === CastShape.ZONE;
    return zoned || settings.combat[element]?.kind === 'burst'
      ? MathUtils.clamp(rawDist, Math.max(0.2, c.minRange), Math.max(0.4, c.range))
      : Math.max(0.4, c.range);
  }

  /**
   * Push the loadout's current shape into RunHud's own six-slot bar (spec
   * §9: the run HUD is a fully independent component, sharing no code with
   * the sandbox's per-element `.ability-card`s it used to borrow). Seat-
   * indexed already, so this is a direct map over `loadout.seats` — no
   * element→seat lookup needed the way the borrowed cards required.
   *
   * Call after anything that changes seats or autocast: construction,
   * restart, acquire, fuse, and the autocast toggle itself.
   *
   * A fused seat (spec §4.7) has no slot of its own — it keeps its
   * generating parent's (that's whose icon still reads, and whose seat
   * never moved), labelled with the fusion's name and gold-bordered
   * instead of the parent's own name. The other parent's seat is simply
   * empty (`fuse()` clears it), which the slot bar shows as dimmed like
   * any other unseated key — no separate "off-stage" bookkeeping needed
   * now that seats map 1:1 onto slots.
   * ponytail: doesn't chase editor mid-run edits to settings.run.loadout —
   * wire the editor's onChange if that stings.
   */
  _syncBadges() {
    const view = this.loadout.seats.map((seatElement, seat) => {
      if (!seatElement) return { key: RUN_SLOT_KEYS[seat], element: null };
      const fused = isFusionId(seatElement);
      const element = fused ? fusionParents(seatElement)[0] : seatElement;
      return {
        key: RUN_SLOT_KEYS[seat],
        element,
        label: fused ? fusionName(seatElement) : (ELEMENT_META[element]?.label ?? element),
        fusion: fused,
        autocast: this._autocast.has(seat),
        // M6 T3: real data, off the same `manaCostOf` the spend gate itself
        // uses — `seatElement` (not the narrowed `element` above), so a
        // fused seat reads its true fusion-max cost rather than only
        // whichever parent happens to keep the seat's icon.
        manaCost: manaCostOf(seatElement) > 0,
        // M6 T4: 装备即常驻 — a fused-away aura parent isn't directly seated
        // any more (see _syncAuras()'s own reasoning), so this follows the
        // same `!fused` narrowing the rest of the row already uses.
        aura: !fused && settings.combat[element]?.kind === 'aura'
      };
    });
    this.runHud.syncSlots(view);
  }

  /**
   * Reconcile the permanent-aura instances (bladeorbit/firering/sunwheel)
   * against the loadout's current seats (spec §4.5 装备即常驻: equip one and
   * it runs, no cast, no cooldown — see OrbitAuraSkill's own doc for how
   * "permanent" is actually implemented). Derives everything from live state
   * — `loadout.equippedList()` for what *should* be running, `abilities.active`
   * for what *is* — rather than a second bookkeeping map, so a `clearEffects()`
   * wipe (restart/return-to-title, which already destroys every active cast
   * including these) can never leave this method out of sync with what it's
   * tracking: the next call after a wipe simply finds nothing running and
   * spawns fresh.
   *
   * A seat that fuses away stops being "seated" under its own id the instant
   * `fuse()` runs (the seat now holds the fusion id instead) — `seated`
   * above is built off `equippedList()`'s raw seat values, which never
   * expands a fusion id back into its parents, so a fused-away aura parent
   * simply isn't in that Set any more and its permanent instance retires
   * right here on the very next call (M7 T1: verified this needs no fusion-
   * aware code of its own — a bespoke fused cast only ever spawns the
   * fusion id itself, never a parent element, so there is no longer a
   * companion loop anywhere that could re-seat one).
   *
   * Call after anything that changes seats: `startRun()` (covers both a
   * fresh start and `_restart()`'s replay) and `_onUpgradeChoice()`'s
   * acquire/fuse branches.
   */
  _syncAuras() {
    const seated = new Set(this.loadout.equippedList());
    for (const element of AURA_ELEMENTS) {
      const running = this.abilities.active.find((a) => a.element === element);
      if (seated.has(element) && !running) {
        // Straight through AbilityManager, never through _cast/_quickCastToward
        // (spec: an aura lives outside the cast pipeline entirely) — no mana
        // gate, no cooldown write, no _applySequence stamp, no consumeQuench.
        const ability = this.abilities.cast(this.character.position, _auraCastDir, 1, element);
        // The five-field cast invariant's other three still get an explicit
        // value each (never left undefined for CombatSystem._amp() to read
        // as a stale leftover from whatever this pooled instance was cast as
        // last time) — cooldown/_applySequence are the two this cast
        // deliberately skips, not all five.
        if (ability) {
          ability.autocast = false;
          ability.fusionMult = 1;
          ability.quenched = false;
        }
      } else if (!seated.has(element) && running) {
        this.abilities.retire(running);
      }
    }
  }

  /**
   * This frame's per-seat cooldown state for RunHud's slot bar — mutates
   * the preallocated `_slotCd` array in place rather than building six
   * fresh objects every frame. A fused seat's cooldown lives under the
   * fusion id itself in `this.cooldowns` (the same key `_quickCastToward`
   * writes), with `total` read off its own bespoke row (M7:
   * `settings.fusions[pairKey].cooldown` — no longer derived from either
   * parent, so the wheel's fill fraction matches what actually got spent).
   *
   * `lowMana` (M6 T3) reads off the exact same `canAffordCast` gate a real
   * cast would hit right now (no demo/echo — this is a readout, not a cast
   * attempt) — one source of truth shared with `_cast`/`_quickCastToward`,
   * so the HUD mask can never disagree with what actually gets spent.
   */
  _seatCooldowns() {
    this.loadout.seats.forEach((element, seat) => {
      const slot = this._slotCd[seat];
      if (!element) {
        slot.active = false;
        return;
      }
      // M6 T4: an aura has no cooldown and no mana cost to show — its badge
      // carries its own "常驻" state instead (see _syncBadges/RunHud).
      if (settings.combat[element]?.kind === 'aura') {
        slot.active = false;
        return;
      }
      slot.active = true;
      slot.total = isFusionId(element) ? settings.fusions[pairKeyOf(element)].cooldown : settings[element].cooldown;
      slot.remaining = this.cooldowns.get(element) ?? 0;
      slot.lowMana = !canAffordCast(element, this.playerState).ok;
    });
    return this._slotCd;
  }

  /**
   * Recompute the loadout's wuxing spread and push the resulting auras onto
   * the horde's tuning knobs (spec §4.8). Call after anything that changes
   * the loadout: every run start, and every acquire or fuse that changes a
   * seat. A fused seat contributes both parents' wuxing (spec §4.7) — the
   * merge is a seating convenience, not a loss of either half's presence.
   */
  _refreshResonance() {
    const wuxingList = this.loadout.equippedList().flatMap((element) =>
      isFusionId(element)
        ? fusionParents(element).map((parent) => settings.combat.wuxingOf[parent])
        : [settings.combat.wuxingOf[element]]
    );
    this.modifiers.computeResonance(wuxingList);
    const tuning = this.enemySystem.tuning;
    tuning.kbMult = this.modifiers.resonates(4) ? settings.resonance.earthKnockback : 1;
    tuning.slowDurMult = this.modifiers.resonates(2) ? settings.resonance.waterSlowDur : 1;
    tuning.advantage = this.modifiers.resonates(0) ? settings.resonance.metalAdvantage : 0;
    tuning.reactionMult = this.modifiers.cycleActive() ? settings.resonance.cycleReaction : 1;
  }

  /** HUD resonance readout (spec §4.8): '共鸣 水 金' for whichever wuxing
   * currently resonate ('Resonance Water Metal' in en — M6 facade debt:
   * wuxingWord swaps in the WUXING word instead of the zh glyph), '· 周天'
   * appended once every wuxing does; counts aren't public so this only
   * lists labels, never tallies. Empty when nothing resonates and the cycle
   * isn't closed either — M6 T7 fix: 周天 only needs one of each wuxing
   * seated (`cycleActive()`), which a 5-seat one-per-wuxing loadout reaches
   * with every individual wuxing still below its own resonates() threshold
   * of 2 — `labels` empty, `cycleActive()` true. Gating the whole readout on
   * `labels.length` (as this used to) swallowed '· 周天' in exactly that
   * state, unreachable before M6 T2-7 gave earth its own skills and this
   * branch its first live path. */
  _resonanceText() {
    const labels = [];
    for (let w = 0; w < 5; w++) {
      if (this.modifiers.resonates(w)) labels.push(wuxingWord(w));
    }
    const cycle = this.modifiers.cycleActive();
    if (!labels.length && !cycle) return '';
    const parts = [t('run.resonance')];
    if (labels.length) parts.push(labels.join(' '));
    if (cycle) parts.push(`· ${t('run.cycleActive')}`);
    return parts.join(' ');
  }

  /** One line per seated skill, for the level-up hand's footer and the
   * verdict's build recap. A fused seat names the fusion and both parents:
   * `R 回春雷泽 Lv2（Frost Lance+Storm Lance）`. */
  _buildSummaryLines() {
    return this.loadout.seats
      .map((element, seat) => {
        if (!element) return null;
        const key = RUN_SLOT_KEYS[seat];
        const level = this.loadout.levelOf(element);
        if (isFusionId(element)) {
          const [a, b] = fusionParents(element);
          const parents = `${ELEMENT_META[a]?.label ?? a}+${ELEMENT_META[b]?.label ?? b}`;
          return `${key} ${fusionName(element)} Lv${level}（${parents}）`;
        }
        return `${key} ${ELEMENT_META[element]?.label ?? element} Lv${level}`;
      })
      .filter(Boolean);
  }

  /** Decline-all-three's reward: heal a fraction of max hp (shared by the level-up hand's skip and an empty shard hand). */
  _skipHeal() {
    this.playerState.hp = Math.min(
      this.playerState.maxHp,
      this.playerState.hp + this.playerState.maxHp * settings.upgrades.skipHeal
    );
  }

  /** Wire a level-up hand's answer back into the loadout/modifier layer. */
  _onUpgradeChoice(result) {
    if (result.action === 'reroll') {
      this._rerollsLeft = (this._rerollsLeft ?? this.modifiers.passiveLevel('reroll')) - 1;
      const hand = this.upgradePool.draw(this.pickups.level);
      this.upgradeUi.open(hand, {
        rerolls: hand.length ? Math.max(0, this._rerollsLeft) : 0,
        summary: this._buildSummaryLines().join('　')
      });
      return;
    }
    this._rerollsLeft = null;
    if (result.action === 'skip') {
      this._skipHeal();
      return;
    }
    const card = result.card;
    if (card.kind === 'upgrade') {
      this.loadout.upgrade(card.element);
      this.modifiers.bumpDamage(card.element);
    } else if (card.kind === 'new') {
      this.loadout.acquire(card.element);
      this._syncBadges();
      this._refreshResonance();
      // M6 T4: 装备即常驻 — spawn the permanent cast the instant an aura is
      // seated. Before the demo shot below: for an aura pick, the orbiters
      // appearing around the caster right now *is* the "immediate demo" —
      // _quickCastToward's own aura guard makes the demo call itself a no-op.
      this._syncAuras();
      // 新技能即时演示 (spec §6): free auto-fire at the nearest enemy so the
      // pick is felt immediately — same nearestTo() lookup the autocast loop
      // in frame() uses, `demo: true` so it costs no cooldown/quench and
      // doesn't stamp the 相生 chain, `autocast: false` so the floater reads
      // as a normal hit rather than the autocast-taxed one. Silently does
      // nothing if the arena is empty (no enemy to aim at yet).
      const i = this.enemySystem.nearestTo(this.character.position.x, this.character.position.z);
      if (i !== -1) {
        this._quickCastToward(card.element, this.enemySystem.x[i], this.enemySystem.z[i], false, true);
      }
    } else if (card.kind === 'fusion') {
      // The freed parent's seat index, captured before fuse() clears it —
      // an autocast flag left on it would otherwise sit there inert until
      // some future acquire happened to land in that exact seat and
      // silently inherit it (M1 勘误-shape staleness this project already
      // guards against elsewhere).
      const freedSeat = this.loadout.seats.indexOf(card.b);
      this.loadout.fuse(card.a, card.b);
      this._autocast.delete(freedSeat);
      this._refreshResonance();
      this._syncBadges();
      this._syncAuras(); // M6 T4: a fused-away aura parent stops being seated
    } else if (card.kind === 'passive') {
      this.modifiers.bumpPassive(card.passive);
      if (card.passive === 'vitality') {
        const grown = settings.run.playerHp * this.modifiers.maxHpMult();
        this.playerState.hp += grown - this.playerState.maxHp; // heal the delta
        this.playerState.maxHp = grown;
      }
    }
  }

  /**
   * Turn the movement keys currently held into one step, in the camera's frame.
   *
   * W runs away from the camera rather than along a fixed world axis, so the
   * keys keep meaning the same thing once you have orbited round behind the
   * character — the alternative is that W walks toward you half the time.
   */
  _steer(dt) {
    const axis = this.input.moveAxis(this._moveAxis);

    // The camera's own facing, flattened onto the floor.
    this._camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this._camForward.y = 0;
    if (this._camForward.lengthSq() < 1e-6) {
      // Staring straight down: the forward axis has no footprint on the floor
      // left to steer by, so screen-up stands in for it.
      this._camForward.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this._camForward.y = 0;
    }
    this._camForward.normalize();
    this._camRight.crossVectors(this._camForward, UP);

    this._moveDir
      .copy(this._camRight)
      .multiplyScalar(axis.x)
      .addScaledVector(this._camForward, axis.y);

    this.character.move(
      this._moveDir,
      dt,
      this.runMode ? this.modifiers.moveSpeedMult() : 1
    );
  }

  clearEffects() {
    this.aim.cancel();
    this.abilities.clear();
    this.particles.reset();
    this.decals.clear();
    this.fissures.clear();
    this.bursts.clear();
    this.lights.reset();
    this.shake.reset();
    this.flash.reset();
    // `clearEffects()` also runs in the sandbox (the editor's Clear button, the
    // 'clear' action) where this never got constructed — unlike its siblings
    // above, which are shared VFX services built either way.
    this.deathShards?.clear();
  }

  /* ------------------------------------------------------------------ */

  /** Load assets, warm the shader cache, then start the loop. */
  async load() {
    const assets = this.assets;

    this.loading.setProgress(0.05, 'Loading environment…');
    const hdr = await assets.loadHDR(HDR_URL);
    await this.environment.loadEnvironment(hdr);
    frame.uEnvMap.value = this.environment.equirect;

    this.loading.setProgress(0.35, 'Loading floor…');
    await this.ground.loadTextures(assets);

    this.loading.setProgress(0.5, 'Loading character…');
    await this.character.load(assets);

    this.loading.setProgress(0.85, 'Compiling shaders…');
    // Compile everything up front so the first cast never stutters.
    await this.renderer.gl.compileAsync(this.scene, this.camera);

    this.loading.setProgress(1, 'Ready');
    this.loading.hide();

    this.start();
  }

  start() {
    this.time.reset();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  /* ------------------------------------------------------------------ */

  frame() {
    const gl = this.renderer.gl;
    gl.info.reset();
    // Reset before anything else this frame can call audio.play() — that
    // includes the two DOM-event-driven cast sites (a click/keypress always
    // lands between two frame() calls, so it counts against whichever frame
    // runs next) and the autocast/echo sites further down this same call.
    if (this.runMode) this.audio.beginFrame();

    const raw = this.time.tick();
    // 微顿帧 (M5 Task 9): a few big moments buy the world a brief slowdown —
    // decays on real time so the stagger itself never drags. `worldRaw` feeds
    // everything `dt` already does (VFX/abilities/character/elapsed below)
    // plus the fixed-step run clock's own advance() call further down; aim,
    // camera, movement and the cooldown decrement all keep reading `raw`
    // directly and never feel it, same as they already ignore `paused`.
    // Freeze/verdict outrank it structurally, not by priority check: both
    // gate *after* this scale is folded in, so a frozen or stopped run reads
    // dt = 0 regardless of `_hitstop`. Run mode only — the sandbox never sets it.
    if (this.runMode) this._hitstop = tickHitstop(this._hitstop, raw);
    const worldRaw = this.runMode && this._hitstop > 0 ? raw * settings.run.hitstopFactor : raw;
    const dt = this.paused || this._frozen ? 0 : worldRaw * settings.global.timeScale;
    this.elapsed += dt;

    /* ---- shared uniforms ---- */
    frame.uTime.value = this.elapsed;
    frame.uDelta.value = dt;
    frame.uShaderIntensity.value = settings.global.shaderIntensity;
    frame.uGlobalGlow.value = settings.global.glow;
    frame.uCameraNear.value = this.camera.near;
    frame.uCameraFar.value = this.camera.far;

    /* ---- simulation ---- */
    this.renderer.syncSettings();

    // Walking runs on *real* time, like the aim and the camera below it:
    // pausing freezes the effects, not your ability to walk around and look at
    // them. Everything downstream — the light focus, the aim origin, the dust,
    // the camera anchor, the contact shadows — already reads the character's
    // position, so moving it here is all that is needed for them to follow.
    // A level-up hand or the pause menu is the one thing that does stop it.
    if (!this._frozen) {
      // 翻滚闪避 (M5 Task 9): a roll in flight owns the position for its short
      // window instead of the WASD steer below — same freeze gate as this
      // whole block, so a hand opening mid-roll holds it in place rather than
      // snapping the rest of the way once the hand closes.
      if (this.runMode && this._dodgeT < this._dodgeDuration) {
        this._dodgeT = Math.min(this._dodgeDuration, this._dodgeT + raw);
        this.character.root.position.lerpVectors(
          this._dodgeStart,
          this._dodgeTarget,
          this._dodgeT / this._dodgeDuration
        );
      } else {
        this._steer(raw);
        if (this.runMode && this._moveAxis.lengthSq() > 0) this._markHintDone('move');
      }
    }

    this.environment.setFocus(this.character.position.x, this.character.position.z);
    this.environment.update();

    // Targeting runs on *real* time so the arrow keeps sweeping and animating
    // while the sandbox is paused — pausing freezes the effects, not the UI.
    this.aim.setOrigin(this.character.position);
    this.aim.update(raw);

    // Aiming owns the heading — you strafe around the arrow rather than
    // swinging the body off it. Walking only steers the body when no arrow is
    // out, which is also what keeps the character facing where it is going.
    if (settings.character.turnToAim && this.aim.isArmed) {
      this.character.turnToward(this.aim.facing, settings.character.turnRate, raw);
    } else if (this.character.isMoving) {
      this.character.turnToward(this.character.heading, settings.character.turnToMove, raw);
    }
    this.character.update(dt);

    // A level-up hand or the pause menu freezes the world; a cooldown
    // counting down behind it would hand back an ability the player never
    // earned time for.
    if (!this._frozen) {
      for (const [element, remaining] of this.cooldowns) {
        if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - raw));
      }
    }

    this.ground.update(this.elapsed);
    this.dust.update(this.elapsed, this.character.position);
    // Real time, like the camera and the aim: a target you knocked down should
    // still get back up while the effects are frozen for a look.
    this.dummies.update(raw, this.camera);

    if (this.runMode) {
      // The run ticks on *raw* time (worldRaw during a hitstop, see below)
      // through the fixed-step clock — the enemies do not slow down because
      // the VFX time scale was turned down, and the renderer interpolates
      // between the last two ticks with the leftover.
      this._verdict.value = 'playing';
      // Not sticky — this reset (and a stopped run.tick()'s own 'playing'
      // return) means a cached read is 'playing' again one frame after death
      // or victory; "is the verdict screen up" is only truthfully answered
      // downstream by !run.active.
      // A level-up hand or the pause menu is a full stop: the clock (and
      // with it the echo timer) holds dead still behind it until a card is
      // chosen or the menu closes. dt and _steer, gated where they live,
      // freeze the character and VFX the same way.
      if (!this._frozen) {
        // 微顿帧 reaches the fixed-step run clock too (worldRaw, not raw) —
        // see this frame's own dt computation above for why: enemies/combat
        // still ignore `settings.global.timeScale` (worldRaw carries no
        // timeScale factor), they just also feel the brief hitstop slow.
        this._runAlpha = this.gameClock.advance(worldRaw, this._runTick);
        // Fresh read, not the check above (evaluated before advance() ran):
        // advance() above can open a shard hand synchronously (onShardHand
        // fires mid-tick), and an echo must not cast into a hand that
        // opened this very frame. The pause menu can't change mid-tick the
        // same way, so only upgradeUi needs the re-read here — the
        // short-circuit also holds the timer's own decrement, same as the
        // freeze holds everything else.
        if (!this.upgradeUi.isOpen && this._echoAt && (this._echoAt.t -= raw) <= 0) {
          const { element } = this._echoAt;
          this._echoAt = null;
          this._echoing = true;
          const prevCd = this.cooldowns.get(element) ?? 0;
          this.cooldowns.set(element, 0); // the echo is free
          this._quickCast(element);
          // A zone cast (snare/glacier) can dry-fire: quickCast() bails with
          // no 'cast' event when the cursor sits inside minRange, so _cast()
          // never runs to set a real cooldown. Put the slot back exactly as
          // found rather than leave it permanently armed at 0.
          if (this.cooldowns.get(element) === 0) this.cooldowns.set(element, prevCd);
          this._echoing = false;
        }
      }
      // Fresh read (this._frozen, not a cached value from before advance()
      // ran): a shard hand can have opened synchronously inside the
      // advance() call just above (onShardHand fires mid-tick), and this
      // branch must not clobber it — nor open a hand over the pause menu,
      // which _frozen also now covers. pendingLevels itself stays queued
      // when skipped here — untouched until a later, unfrozen frame finds
      // this false again and the check fires for real.
      if (!this._frozen && this.run.active && this._verdict.value === 'playing' && this.run.pendingLevels > 0) {
        // A tick that banks more than one level (a burst of xp) leaves
        // pickups.level already sitting on the destination — the levels in
        // between never get their own hand. sinceLevel carries that span back
        // to the pool so a milestone crossed mid-jump still guarantees a card.
        const sinceLevel = this.pickups.level - this.run.pendingLevels + 1;
        this.run.pendingLevels--;
        const hand = this.upgradePool.draw(
          this.pickups.level,
          sinceLevel === this.pickups.level ? this.pickups.level : sinceLevel
        );
        this.audio.play('levelup');
        this.upgradeUi.open(hand, {
          rerolls: hand.length ? this.modifiers.passiveLevel('reroll') : 0,
          summary: this._buildSummaryLines().join('　')
        });
      }
      if (this._verdict.value !== 'playing' && this.run.active) {
        this.run.stop();
        this._echoAt = null; // a pending echo must not fire over the death screen
        const won = this._verdict.value === 'won';
        this.audio.play(won ? 'victory' : 'death');
        // Who hit last, and — unless it was the killing blow — what beats them.
        const killer = this.playerState.lastHitBy;
        let deathLine = null;
        if (!won && killer) {
          if (killer.element < 0) {
            deathLine = `${t('verdict.diedTo')}${t('verdict.rangedDeath')}`;
          } else {
            const beats = WUXING_LABEL[BEATS.indexOf(killer.element)];
            const elementName = WUXING_LABEL[killer.element];
            const behaviorName = t('verdict.behaviors')[killer.behavior];
            const suffix = t('verdict.elementSuffix');
            const matchupHint = t('verdict.matchupHint');

            if (settings.ui.language === 'zh') {
              deathLine =
                `${t('verdict.diedTo')}${elementName}${suffix}${behaviorName}` +
                `——${beats}${suffix}对${elementName}${suffix}有 1.25× ${matchupHint}`;
            } else {
              deathLine =
                `${t('verdict.diedTo')}${elementName} ${behaviorName} ` +
                `— ${beats} ${matchupHint} ${elementName} at 1.25×`;
            }
          }
        }
        const topSkills = Object.entries(this.combat.damageDealt)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          // M7 T7: a fused seat books under its fusion id — resolve it to the
          // spell's own name the way the loadout badge already does
          // (fusionName), instead of leaking the raw 'fusion:a+b' string
          // onto the death screen (T2-T6 erratas' shared observation).
          .map(([el, amt]) => [isFusionId(el) ? fusionName(el) : ELEMENT_META[el]?.label ?? el, amt]);
        this.verdictPanel.show({
          won,
          elapsed: this.run.elapsed,
          kills: this.run.kills,
          level: this.pickups.level,
          buildLines: this._buildSummaryLines(),
          topSkills,
          deathLine
        });
      }
      this.enemyRenderer.syncTelegraphs(this.run.telegraphs);
      this.enemyRenderer.render(this.enemySystem, this._runAlpha);
      // Shared scratch read (TideSchedule.tideAt): one call, passed to both —
      // a second call this same frame would still be safe (nothing rolls a
      // spawn between here and the render tail), but there is no reason to.
      const tideInfo = this.run.tide();
      this.arena.update(tideInfo, this.elapsed);
      // After environment.update() (this frame's top) and dust.update()
      // (above) both already ran — TideAtmosphere multiplies onto their
      // post-update runtime colours, never onto settings itself.
      this.tideAtmosphere.update(dt, tideInfo);
      this.threatArrows.update(this.enemySystem, this.character.position);
      this.pickups.sync();
      this.enemyProjectiles.sync();
      this.deathShards.update(dt);
      this.deathShards.sync();
      // Taking a bite flashes the screen red, scaled by how big a bite —
      // the bar alone is easy to miss mid-fight. Restart raises hp, which
      // correctly stays silent here. reduceFlashes' own damping (flashDamp)
      // lives inside ScreenFlash.trigger, not here (see its comment).
      if (this.playerState.hp < this._lastHp) {
        const dmgFrac = (this._lastHp - this.playerState.hp) / this.playerState.maxHp;
        this.flash.trigger(getColor('#ff3226'), MathUtils.clamp(dmgFrac * 2.5, 0.1, 1));
        this.orbBottles.pulseSlosh();
        this.audio.play('hurt');
      }
      this._lastHp = this.playerState.hp;
      // 受击泛红 (M5 Task 9): the character's own materials flicker for as
      // long as `iframes` reads positive — a hit's own recovery window and a
      // dodge's i-frames share that one field, so both flicker the body.
      this.character.setHitFlicker(this.playerState.iframes > 0);
      this.orbBottles.update(
        raw,
        this.camera,
        this.playerState.hp,
        this.playerState.maxHp,
        this.playerState.mana,
        settings.run.manaMax,
        this.playerState.shield
      );
      // The verdict borrows the hp span, so a live update would stamp it out.
      if (this.run.active) {
        this.runHud.update(
          this.playerState,
          this.run,
          this.pickups,
          this.run.tide(),
          this._resonanceText(),
          this.ultimate,
          this._seatCooldowns()
        );
      }
    }

    // 自动施法: every seat left on auto fires itself at the nearest enemy,
    // once its own cooldown allows — same freeze/verdict stop as everything
    // else above (now including the pause menu: without this, a paused
    // run's seats would keep firing at the frozen — but still targetable —
    // horde). run.active is the real "run over" signal: _verdict.value
    // resets to 'playing' every frame, so checking only that would leave a
    // dead run firing seats at the frozen horde forever.
    if (this.runMode && !this._frozen && this.run.active && this._verdict.value === 'playing') {
      for (const seat of this._autocast) {
        const element = this.loadout.elementAt(seat);
        if (!element || (this.cooldowns.get(element) ?? 0) > 0) continue;
        const i = this.enemySystem.nearestTo(this.character.position.x, this.character.position.z);
        if (i === -1) continue;
        this._quickCastToward(element, this.enemySystem.x[i], this.enemySystem.z[i]);
      }
    }

    this.abilities.update(dt);
    this.particles.flush();
    this.decals.update(dt);
    this.fissures.update(dt);
    this.bursts.update(dt);
    this.lights.update(dt);

    /* ---- camera ---- */
    const focus = this.abilities.focus;
    if (focus) this.rig.lookAt(focus.position, MathUtils.clamp(1 - focus.u * 0.4, 0, 1));
    this.rig.setAnchor(this.character.position.x, 0, this.character.position.z);
    this.shake.update(raw);
    this.flash.update(raw);
    this.rig.update(raw);

    this.contactShadows.setPosition(this.character.position.x, this.character.position.z);
    this.contactShadows.render(this.scene);

    /* ---- render ---- */
    // Exactly one cascade shadow update per frame (see Renderer).
    gl.shadowMap.needsUpdate = true;
    this.post.sync(this.elapsed, this.flash);
    this.post.render();

    /* ---- readouts ---- */
    // Sandbox-only: run mode hides .hud__abilities outright (RunHud's own
    // slot bar, fed below, has replaced it), so driving these sandbox-card
    // cooldown rings and the armed-pulse class would just be wasted writes
    // to hidden DOM.
    if (!this.runMode) {
      for (const element of ELEMENTS) {
        this.hud.setCooldown(element, this.cooldowns.get(element) ?? 0, settings[element].cooldown);
      }
      this.hud.setArmed(this.aim.isArmed);
    }
    this.hud.update(raw, () => ({
      particles: this.particles.countLive(this.elapsed),
      calls: gl.info.render.calls,
      spikes: this.abilities.active.reduce((total, ability) => total + ability.instanceCount, 0),
      abilities: this.abilities.active.length
    }));
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.stop();
    if (this.runMode) {
      this.runHud.dispose();
      this.damageNumbers.dispose();
      this.threatArrows.dispose();
      for (const tab of this._panelTabs) tab.remove();
      this.enemyRenderer.dispose();
      this.deathShards.dispose();
      this.arena.dispose();
      this.camera.remove(this.orbBottles.object3D);
      this.orbBottles.dispose();
      this.scene.remove(this.pickups.points);
      this.scene.remove(this.enemyProjectiles.points);
      this.scene.remove(this.camera);
      this.upgradeUi?.dispose();
      this.verdictPanel?.dispose();
      this.pauseMenu?.dispose();
      this.titleScreen?.dispose();
      this._hintsRoot?.remove();
    }
    this.input.dispose();
    this.aim.dispose();
    this.abilities.dispose();
    this.particles.dispose();
    this.decals.dispose();
    this.fissures.dispose();
    this.bursts.dispose();
    this.lights.dispose();
    this.character.dispose();
    this.ground.dispose();
    this.dust.dispose();
    this.contactShadows.dispose();
    this.dummies.dispose();
    this.post.dispose();
    this.environment.dispose();
    this.editor.dispose();
    this.rig.dispose();
    this.renderer.dispose();
  }
}
