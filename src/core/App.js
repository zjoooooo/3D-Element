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
import { CombatSystem } from '../run/CombatSystem.js';
import { PickupSystem } from '../run/PickupSystem.js';
import { PlayerState } from '../run/PlayerState.js';
import { RunManager } from '../run/RunManager.js';
import { RunHud } from '../run/RunHud.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { CharacterController } from '../animation/CharacterController.js';

import { InputManager } from '../input/InputManager.js';
import { AimController } from '../input/AimController.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { FissureSystem } from '../effects/GroundFissures.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { AbilityManager } from '../abilities/AbilityManager.js';
import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';

import { settings, ELEMENTS } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

const UP = new Vector3(0, 1, 0);

/**
 * Run mode's keyboard half of the loadout. The six on-stage abilities sit in
 * `settings.run.loadout`, ordered [LMB, RMB, Q, E, R, T] — so the sandbox's
 * seven ability slots collapse onto loadout slots 2–5, and the keys with no
 * seat (F, V, X) sit the run out.
 */
const RUN_KEY_SLOTS = { 0: 2, 1: 3, 2: 4, 6: 5 };

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
      const rng = createRng((Date.now() % 0xffffffff) >>> 0);
      this.gameClock = new GameClock(settings.run.tickRate);
      this.enemySystem = new EnemySystem(rng);
      this.enemyRenderer = new EnemyRenderer(this.scene);
      this.pickups = new PickupSystem();
      this.scene.add(this.pickups.points);
      this.playerState = new PlayerState();
      this.combat = new CombatSystem(this.targets);
      this.targets.register(this.enemySystem);
      this.run = new RunManager({
        enemies: this.enemySystem,
        pickups: this.pickups,
        combat: this.combat,
        player: this.playerState,
        targets: this.targets,
        abilities: this.abilities,
        rng
      });
      this.runHud = new RunHud();
      // Frame-loop scratch: the verdict box and the tick closure are minted
      // once here so advance() never allocates per frame.
      this._verdict = { value: 'playing' };
      this._runTick = (step) => {
        this._verdict.value = this.run.tick(step, this.character.position);
      };
      this.run.start();
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
      if (this.runMode) this._quickCast(settings.run.loadout[0]);
      else this.aim.confirm();
    });
    this.input.on('action', (action, slot) => this._handleAction(action, slot));

    this.aim.on('cast', (origin, direction, distance) => this._cast(origin, direction, distance));
    this.aim.on('reject', () => this.hud.showToast('Too close — aim further out'));

    // The HUD shows all seven abilities, off-stage snare included, so in run
    // mode a click there must not arm the sandbox aim arrow.
    this.hud.onAbility = (element) => {
      if (!this.runMode) this.armAbility(element);
    };
  }

  _handleAction(action, slot) {
    switch (action) {
      case 'ability': {
        if (this.runMode) {
          // Keys cast their loadout seat straight away; unseated keys do nothing.
          const seat = RUN_KEY_SLOTS[slot];
          if (seat !== undefined) this._quickCast(settings.run.loadout[seat]);
          break;
        }
        const element = ELEMENTS[slot] ?? this.element;
        // Pressing the *same* key again puts an armed cast away, as it does in a
        // MOBA; pressing a different one swaps the slot without disarming.
        if (this.aim.isArmed && element === this.element) this.aim.cancel();
        else this.armAbility(element);
        break;
      }
      case 'rightclick':
        // A right click that never became a camera drag: the sandbox reads it
        // as "put the cast away", the run mode as the second loadout seat.
        if (this.runMode) this._quickCast(settings.run.loadout[1]);
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
          // A fresh run starts with every ability ready.
          for (const element of this.cooldowns.keys()) this.cooldowns.set(element, 0);
          this.run.start();
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

  /** Run mode's casting verb: no arm/confirm dance, straight from the pointer. */
  _quickCast(element) {
    if (!element || !ELEMENTS.includes(element)) return;
    if ((this.cooldowns.get(element) ?? 0) > 0) return;
    if (element !== this.element) this.selectAbility(element, { silent: true });
    this.aim.quickCast();
  }

  _cast(origin, direction, distance) {
    const element = this.element;
    this.abilities.cast(origin, direction, distance, element);
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown));

    // Snap onto the shot and throw the body into it. Which clip that is belongs
    // to the ability, so each spell can be cast with its own gesture.
    this.character.setFacing(this.aim.facing);
    this.character.playCast(settings[element].castAnim);
    this.character.castLunge();
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

    this.character.move(this._moveDir, dt);
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
    const dt = this.paused ? 0 : raw * settings.global.timeScale;
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
    this._steer(raw);

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

    for (const [element, remaining] of this.cooldowns) {
      if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - raw));
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
      this._runAlpha = this.gameClock.advance(raw, this._runTick);
      if (this._verdict.value !== 'playing' && this.run.active) {
        this.run.stop();
        this.runHud.showVerdict(this._verdict.value === 'won' ? '生存达成 — 回车重开' : '倒下了 — 回车重开');
      }
      this.enemyRenderer.syncTelegraphs(this.run.telegraphs);
      this.enemyRenderer.render(this.enemySystem, this._runAlpha);
      this.pickups.sync();
      // The verdict borrows the hp span, so a live update would stamp it out.
      if (this.run.active) this.runHud.update(this.playerState, this.run, this.pickups);
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
    for (const element of ELEMENTS) {
      this.hud.setCooldown(element, this.cooldowns.get(element) ?? 0, settings[element].cooldown);
    }
    this.hud.setArmed(this.aim.isArmed);
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
      this.enemyRenderer.dispose();
      this.scene.remove(this.pickups.points);
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
