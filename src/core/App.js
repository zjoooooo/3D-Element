import { Vector2, Vector3, MathUtils } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { frame } from './FrameUniforms.js';

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
import { FUSIONS, fusionKey, isFusionId, fusionParents } from '../run/fusions.js';
import { CombatSystem } from '../run/CombatSystem.js';
import { PickupSystem } from '../run/PickupSystem.js';
import { PlayerState } from '../run/PlayerState.js';
import { Modifiers } from '../run/Modifiers.js';
import { Loadout } from '../run/Loadout.js';
import { UpgradePool } from '../run/UpgradePool.js';
import { UpgradeUi } from '../run/UpgradeUi.js';
import { VerdictPanel } from '../run/VerdictPanel.js';
import { Ultimate } from '../run/Ultimate.js';
import { RunManager } from '../run/RunManager.js';
import { RunHud } from '../run/RunHud.js';
import { DamageNumbers } from '../run/DamageNumbers.js';
import { ThreatArrows } from '../run/ThreatArrows.js';
import { OrbBottles } from '../run/OrbBottles.js';
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
import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';
import { t } from '../ui/strings.js';

import { settings, ELEMENTS, ELEMENT_META, CastShape, castShapeOf } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

const UP = new Vector3(0, 1, 0);
const _deathPos = new Vector3();

/** Run-mode key badge per loadout slot, in `settings.run.loadout` order. */
const RUN_SLOT_KEYS = ['LMB', 'RMB', 'Q', 'E', 'R', 'T'];

/**
 * Run mode's keyboard half of the loadout. The six on-stage abilities sit in
 * `settings.run.loadout`, ordered [LMB, RMB, Q, E, R, T] — so the sandbox's
 * seven ability slots collapse onto loadout slots 2–5, and the keys with no
 * seat (F, V, X) sit the run out.
 */
const RUN_KEY_SLOTS = { 0: 2, 1: 3, 2: 4, 6: 5 };

/** A fusion id's display name (spec §4.7 table), resolved off its parents' wuxing. */
function fusionName(id) {
  const [a, b] = fusionParents(id);
  return FUSIONS[fusionKey(settings.combat.wuxingOf[a], settings.combat.wuxingOf[b])]?.name ?? id;
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
    this.runMode = location.hash === '#run';

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
      this._slotCd = Array.from({ length: 6 }, () => ({ active: false, remaining: 0, total: 0 }));
      this._lastCastWux = -1;
      this._lastCastAt = -Infinity;
      this.upgradePool = new UpgradePool(rng, this.loadout, this.modifiers);
      this.upgradeUi = new UpgradeUi();
      this.upgradeUi.onChoice = (result) => this._onUpgradeChoice(result);
      this.verdictPanel = new VerdictPanel();
      this.pickups.mods = this.modifiers;
      // FireballAbility reads ctx.mods?.damageMult() straight from the ability
      // context; every other element's damage rides CombatSystem below instead.
      this.abilities.ctx.mods = this.modifiers;
      this.combat = new CombatSystem(this.targets, this.modifiers);
      // FireballAbility books its self-resolved hits straight into the run's
      // damage ledger (D-M3-8) — same wiring shape as ctx.mods above.
      this.abilities.ctx.stats = this.combat;
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
      // through _fireUltimate. `wuxing` is set below, after loadout.reset().
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
      // Hits throw a pooled damage figure — without a number, a two-hit kill
      // reads as "no damage" against enemies that carry no health bar.
      this.damageNumbers = new DamageNumbers(canvas, this.camera);
      this.enemySystem.onHit = (x, z, amount) => this.damageNumbers.spawn(x, z, amount);
      // Enemies spawn outside the frame by design; the edge arrows say from
      // where, so a pack never simply materialises at the screen edge.
      this.threatArrows = new ThreatArrows(canvas, this.camera);
      // 血蓝玻璃瓶 (spec §9): screen-space HP/mana readout, parented straight to
      // the camera rather than positioned in world space — see OrbBottles for
      // why that trick needs the camera itself sitting in the scene graph.
      this.orbBottles = new OrbBottles(canvas);
      this.camera.add(this.orbBottles.object3D);
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
      this.loadout.reset();
      // 本命系 (spec §4.9): the ultimate's home element is whatever the draft/
      // debug reset above put in seat 0. Placeholder until Task 11's real
      // title-screen draft picks it before the run even starts.
      this.ultimate.wuxing = fusionWux(this.loadout.elementAt(0));
      this.modifiers.reset();
      this.run.start();
      this._refreshResonance();
    }

    /* ---- character ---- */
    this.character = new CharacterController(this.environment);
    this.scene.add(this.character.root);

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
      onCharacter: (id) => {
        this.hud.showToast('Loading character…');
        this.character
          .setCharacter(id, this.assets)
          .then(() => this.hud.showToast(`Character: ${id}`))
          .catch((error) => {
            console.error('[App] character switch failed', error);
            this.hud.showToast('Character failed to load');
          });
      }
    });

    if (this.runMode) {
      this._syncBadges();
      this.run.onTideTurn = (element) => this.hud.showToast(`${WUXING_LABEL[element]}${t('run.tideTurn')}`);
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
  }

  /** The ability currently in the slot. */
  get element() {
    return this.abilities.selected;
  }

  /* ------------------------------------------------------------------ */

  _bindEvents() {
    this.renderer.onResize((width, height, pixelRatio) => {
      this.rig.resize(width, height);
      this.post.setSize(width, height, pixelRatio);
      this.dust.setPixelRatio(pixelRatio);
    });

    this.input.on('pointer:move', (pointer) => this.aim.point(pointer));
    this.input.on('pointer:confirm', (pointer) => {
      this.aim.point(pointer);
      if (this.runMode) this._quickCast(this.loadout.elementAt(0));
      else this.aim.confirm();
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

  _handleAction(action, slot) {
    // A level-up hand is a full stop. Its own keydown listener already
    // swallows the keyboard in the capture phase before InputManager ever
    // sees it; this is the double-check for whatever reaches here another
    // way (the HUD's click path).
    if (this.runMode && this.upgradeUi.isOpen) return;
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
        this.aim.cancel();
        break;
      case 'dodge': {
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
        this._moveDir.normalize().multiplyScalar(settings.run.dodgeDistance);
        this.character.root.position.add(this._moveDir);
        break;
      }
      case 'restart':
        if (this.runMode && !this.run.active) {
          this.clearEffects();
          this.verdictPanel.hide();
          // A fresh run starts with every ability ready.
          for (const element of this.cooldowns.keys()) this.cooldowns.set(element, 0);
          this.loadout.reset();
          this.ultimate.wuxing = fusionWux(this.loadout.elementAt(0)); // seat 0 again (see constructor)
          this.modifiers.reset();
          this._autocast.clear();
          this._syncBadges();
          this._echoAt = null;
          this._lastCastWux = -1;
          this._lastCastAt = -Infinity;
          this.run.start();
          this._refreshResonance();
        }
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
    if (isFusionId(element)) {
      if ((this.cooldowns.get(element) ?? 0) > 0) return;
      const [a, b] = fusionParents(element);
      const prevAim = this.aim.element;
      this.aim.setElement(settings[a].range >= settings[b].range ? a : b);
      this.aim._resolve();
      const tx = this.aim.origin.x + this.aim.direction.x * this.aim.distance;
      const tz = this.aim.origin.z + this.aim.direction.z * this.aim.distance;
      this._quickCastToward(element, tx, tz, false);
      // Give the aim back: it was only borrowed to resolve the fusion's shared
      // target point, and leaving it on the longer-range parent would corrupt
      // the next plain quick-cast of the selected element (wrong range/shape),
      // since only `selectAbility` otherwise keeps `aim.element` in sync.
      this.aim.setElement(prevAim);
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
   * Guard shape matches autocast's own loop in frame() — upgradeUi.isOpen is
   * already caught by _handleAction's early return above this switch, so
   * only the run-over half needs repeating here.
   */
  _fireUltimate() {
    if (!this.run.active || this._verdict.value !== 'playing') return;
    if (this.ultimate.fire(this.character.position)) {
      this.flash.trigger(getColor('#fff2c8'), 0.45);
      this.shake.add(1, 1.2, 20);
      this.hud.showToast(t('ult.fired'));
    } else {
      this.hud.showToast(t('ult.notReady'));
    }
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

  _cast(origin, direction, distance) {
    const element = this.element;
    const ability = this.abilities.cast(origin, direction, distance, element);
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
    const cdMult = this.runMode ? this.modifiers.cooldownMult() : 1;
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown * cdMult));

    if (this.runMode) this._applySequence(element);

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
   * A fusion seat (spec §4.7) fires both parents at this same point,
   * back-to-back, each independently clamped to its own range — the run's
   * fusion budget (scaled by the fusion's own level) rides as
   * `ability.fusionMult`, and the cooldown/sequence/echo bookkeeping below
   * happens once, on the fusion id, never on either parent's own key.
   * `autocast` tells apart a background seat's own cast (the only caller
   * until this task) from `_quickCast`'s manual fusion hand-off, which
   * resolves a pointer-aimed target point and forwards here as `false`.
   */
  _quickCastToward(element, tx, tz, autocast = true) {
    if (!element || (this.cooldowns.get(element) ?? 0) > 0) return;

    const origin = this.character.position;
    const dx = tx - origin.x;
    const dz = tz - origin.z;
    const rawDist = Math.hypot(dx, dz);
    if (rawDist < 1e-6) return; // degenerate: target sits exactly on the caster
    const direction = { x: dx / rawDist, y: 0, z: dz / rawDist };

    let castAnim;
    if (isFusionId(element)) {
      const [a, b] = fusionParents(element);
      const fusionMult =
        settings.fusion.budget * (1 + settings.fusion.levelMult * (this.loadout.levelOf(element) - 1));
      // 淬炼 spends once per fused cast action, not once per parent (I3): b is
      // the generated half (spec §4.7 挂印取子系), so wuxingOf[b] is exactly
      // fusionWux(element) — consumeQuench(b) is the fusion's own metal-
      // identity check and its spend in one call. Stamped onto both parents.
      const quenched = this.runMode ? this.modifiers.consumeQuench(b) : false;
      for (const part of [a, b]) {
        const ability = this.abilities.cast(origin, direction, this._quickCastDistance(part, rawDist), part);
        if (ability) {
          ability.autocast = autocast;
          ability.fusionMult = fusionMult;
          ability.quenched = quenched;
        }
      }
      this.cooldowns.set(
        element,
        Math.max(0, Math.max(settings[a].cooldown, settings[b].cooldown) * this.modifiers.cooldownMult())
      );
      castAnim = settings[a].castAnim;
    } else {
      const c = settings[element];
      const ability = this.abilities.cast(origin, direction, this._quickCastDistance(element, rawDist), element);
      if (ability) {
        ability.autocast = autocast;
        ability.fusionMult = 1;
        ability.quenched = this.runMode ? this.modifiers.consumeQuench(element) : false;
      }
      this.cooldowns.set(element, Math.max(0, c.cooldown * this.modifiers.cooldownMult()));
      castAnim = c.castAnim;
    }

    // Autocast is only ever invoked from the runMode-gated loop in frame(),
    // so this.run always exists here — no `if (this.runMode)` gate needed
    // (same assumption _cast's cdMult/echo lines below already make).
    this._applySequence(element);

    // 施法回响 applies here exactly as it does to a manual cast (spec: any
    // cast can proc it); see `_cast`'s own copy of this same roll.
    if (!this._echoing && this.runRng() < this.modifiers.echoChance() && !this._echoAt) {
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
        // Structural (spec §9): no ability has a manaCost yet, so this is
        // always false until an M6 skill sets one — the dot's CSS/markup
        // already exists, waiting on a real value here.
        manaCost: !!settings[element]?.manaCost
      };
    });
    this.runHud.syncSlots(view);
  }

  /**
   * This frame's per-seat cooldown state for RunHud's slot bar — mutates
   * the preallocated `_slotCd` array in place rather than building six
   * fresh objects every frame. A fused seat's cooldown lives under the
   * fusion id itself in `this.cooldowns` (the same key `_quickCastToward`
   * writes), with `total` the slower of its two parents — same numbers the
   * old sandbox-card fusion loop in `frame()` used to compute.
   */
  _seatCooldowns() {
    this.loadout.seats.forEach((element, seat) => {
      const slot = this._slotCd[seat];
      if (!element) {
        slot.active = false;
        return;
      }
      slot.active = true;
      if (isFusionId(element)) {
        const [a, b] = fusionParents(element);
        slot.total = Math.max(settings[a].cooldown, settings[b].cooldown);
      } else {
        slot.total = settings[element].cooldown;
      }
      slot.remaining = this.cooldowns.get(element) ?? 0;
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
   * currently resonate, '· 周天' appended once every wuxing does; counts
   * aren't public so this only lists labels, never tallies. Empty when
   * nothing resonates. */
  _resonanceText() {
    const labels = [];
    for (let w = 0; w < 5; w++) {
      if (this.modifiers.resonates(w)) labels.push(WUXING_LABEL[w]);
    }
    if (!labels.length) return '';
    return `${t('run.resonance')} ${labels.join(' ')}${this.modifiers.cycleActive() ? ` · ${t('run.cycleActive')}` : ''}`;
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

    const raw = this.time.tick();
    const dt = this.paused || (this.runMode && this.upgradeUi?.isOpen) ? 0 : raw * settings.global.timeScale;
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
    // A level-up hand is the one thing that does stop it.
    if (!(this.runMode && this.upgradeUi.isOpen)) this._steer(raw);

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

    // A level-up hand freezes the world; a cooldown counting down behind it
    // would hand back an ability the player never earned time for.
    const frozen = this.runMode && this.upgradeUi.isOpen;
    if (!frozen) {
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
      // The run ticks on *raw* time through the fixed-step clock — the enemies
      // do not slow down because the VFX time scale was turned down, and the
      // renderer interpolates between the last two ticks with the leftover.
      this._verdict.value = 'playing';
      // Not sticky — this reset (and a stopped run.tick()'s own 'playing'
      // return) means a cached read is 'playing' again one frame after death
      // or victory; "is the verdict screen up" is only truthfully answered
      // downstream by !run.active.
      // A level-up hand is a full stop: the clock (and with it the echo timer)
      // holds dead still behind it until a card is chosen. dt and _steer,
      // gated where they live, freeze the character and VFX the same way.
      const frozen = this.upgradeUi.isOpen;
      if (!frozen) {
        this._runAlpha = this.gameClock.advance(raw, this._runTick);
        // Fresh read, not the frame-start `frozen`: advance() above can open
        // a shard hand synchronously (onShardHand fires mid-tick), and an
        // echo must not cast into a hand that opened this very frame. The
        // short-circuit also holds the timer's own decrement here, same as
        // the freeze holds everything else.
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
      // Fresh read, not the frame-start `frozen`: a shard hand can have opened
      // synchronously inside the advance() call just above (onShardHand fires
      // mid-tick), and this branch must not clobber it. pendingLevels itself
      // stays queued when skipped here — untouched until a later, unfrozen
      // frame finds isOpen false again and this same check fires for real.
      if (!this.upgradeUi.isOpen && this.run.active && this._verdict.value === 'playing' && this.run.pendingLevels > 0) {
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
        this.upgradeUi.open(hand, {
          rerolls: hand.length ? this.modifiers.passiveLevel('reroll') : 0,
          summary: this._buildSummaryLines().join('　')
        });
      }
      if (this._verdict.value !== 'playing' && this.run.active) {
        this.run.stop();
        this._echoAt = null; // a pending echo must not fire over the death screen
        const won = this._verdict.value === 'won';
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
          .map(([el, amt]) => [ELEMENT_META[el]?.label ?? el, amt]);
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
      // Taking a bite flashes the screen red — the bar alone is easy to miss
      // mid-fight. Restart raises hp, which correctly stays silent here.
      if (this.playerState.hp < this._lastHp) {
        this.flash.trigger(getColor('#ff3226'), 0.22);
        this.orbBottles.pulseSlosh();
      }
      this._lastHp = this.playerState.hp;
      this.orbBottles.update(
        raw,
        this.camera,
        this.playerState.hp,
        this.playerState.maxHp,
        this.playerState.mana,
        settings.run.manaMax
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
    // else above. run.active is the real "run over" signal: _verdict.value
    // resets to 'playing' every frame, so checking only that would leave a
    // dead run firing seats at the frozen horde forever.
    if (this.runMode && !this.upgradeUi.isOpen && this.run.active && this._verdict.value === 'playing') {
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
      this.arena.dispose();
      this.camera.remove(this.orbBottles.object3D);
      this.orbBottles.dispose();
      this.scene.remove(this.pickups.points);
      this.scene.remove(this.enemyProjectiles.points);
      this.scene.remove(this.camera);
      this.upgradeUi?.dispose();
      this.verdictPanel?.dispose();
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
