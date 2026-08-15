import {
  AnimationMixer,
  Box3,
  Group,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector3
} from 'three';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { disposeObject } from '../utils/dispose.js';
import { clamp, damp } from '../utils/math.js';

/**
 * Character id → the files one skin needs.
 *
 * Clips are listed per character because Mixamo retargets the hips track in
 * absolute centimetres: a clip downloaded for one rig quietly floats or sinks
 * on another, so every character brings its own set. `model` carries the mesh
 * and the idle clip in one export; `texture` is the sidecar skin for models
 * that ship without an embedded map. The clip ids are fixed —
 * `settings[element].castAnim` and the editor dropdown speak them — so swapping
 * an animation is editing a filename here, not renaming a download.
 */
export const CHARACTERS = {
  classic: {
    model: 'Idle.fbx',
    texture: 'diffuse.png',
    clips: { run: 'run.fbx', cast1: 'cast1.fbx', cast2: 'cast2.fbx', cast3: 'cast3.fbx' }
  },
  sorcerer: {
    model: 'Standing Idle.fbx',
    texture: 'diffuse2.png',
    clips: {
      run: 'Fast Run-2.fbx',
      cast1: 'Standing 1H Magic Attack 02.fbx',
      cast2: 'Standing 1H Magic Attack 02.fbx',
      cast3: 'Standing 1H Magic Attack 02.fbx'
    }
  }
};

const modelUrl = (file) => `./models/${file}`;
const _scratch = new Vector3();
/** Mixamo exports in centimetres. */
const FBX_SCALE = 0.01;
/** Rigs vary; normalise to a believable human height so the world scale holds. */
const TARGET_HEIGHT = 1.78;

/**
 * Pull the clip out of a freshly loaded export and make it playable on *this* rig.
 *
 * Two things sit between a Mixamo file and the mixer:
 *
 *  - Some exports carry an empty `Take 001` beside the real take, so the first
 *    clip in the list is not necessarily the one holding the animation.
 *  - A clip authored on another character binds by bone name, so its tracks for
 *    bones this rig does not have — fingers, usually — animate nothing and warn
 *    once each at bind time. They are dropped here instead.
 *
 * The hips track is left exactly as authored. It is the one channel in absolute
 * centimetres rather than a rotation, so a clip from a differently proportioned
 * character *can* stand this one off the floor — but rescaling it on the clips
 * we actually ship pushes the feet 5cm through it, so the correction is not
 * applied blind. `npm run check` measures where the planted foot lands.
 *
 * @param {string} name                  what to call the clip
 * @param {import('three').Group} file   the loaded export
 * @param {Set<string>} bones            every node name in this rig
 * @returns {import('three').AnimationClip|null}
 */
export function prepareClip(name, file, bones) {
  const clip = (file?.animations ?? []).find((entry) => entry.tracks.length > 0);
  if (!clip) {
    console.warn(`[CharacterController] "${name}" carries no animation`);
    return null;
  }

  clip.tracks = clip.tracks.filter((track) => bones.has(track.name.split('.')[0]));
  if (!clip.tracks.length) {
    console.warn(`[CharacterController] "${name}" does not match this skeleton`);
    return null;
  }

  clip.name = name;
  return clip;
}

/** Both toe bones, whatever namespace the exporter wrote them under. */
function findToes(root) {
  const toes = [];
  root.traverse((node) => {
    if (!node.isBone) return;
    const short = node.name.split(':').pop().replace(/^mixamorig/i, '');
    if (short === 'LeftToeBase' || short === 'RightToeBase') toes.push(node);
  });
  return toes;
}

/** How high the lower toe is standing right now, world space. */
function toeHeight(root, toes) {
  root.updateMatrixWorld(true);
  let lowest = Infinity;
  for (const toe of toes) lowest = Math.min(lowest, toe.getWorldPosition(_scratch).y);
  return lowest;
}

/**
 * Take back out whatever the idle clip does to the rig's *height*.
 *
 * The drop in `_buildBundle` is measured on the bind pose, and a clip is under
 * no obligation to agree with it. `Idle.fbx` binds standing on its own origin,
 * so its drop is zero and nothing moves. `Standing Idle.fbx` binds *centred* on
 * its origin — half the body below the floor — so it is lifted 0.89m to stand
 * up, and then the first frame of its own hips track puts the body back where
 * the file had it. The lift stays. The character floats by exactly half its own
 * height, which is what you are looking at when a new model hangs in the air.
 *
 * So: measure the feet in the bind pose, measure them again with the clip
 * playing, and subtract the difference. A rig that already stood correctly
 * measures zero and is left alone.
 *
 * It has to be the toes. `Box3.setFromObject` transforms a skinned mesh's
 * *bind* geometry by its node matrix, and that node does not move when the
 * bones do — the box happily reports the feet on the floor no matter where the
 * animation has actually put them, which is why the original placement could
 * not see this at all.
 */
function plantOnFloor(root, mixer, action) {
  const toes = findToes(root);
  if (!toes.length || !action) return;

  const bindHeight = toeHeight(root, toes);

  action.play();
  const clip = action.getClip();
  const step = 1 / 30;
  let lowest = Infinity;
  // Over a cycle rather than at frame zero: an idle that shifts its weight has
  // a lowest moment, and that is the one that should be touching the floor.
  for (let time = 0; time < Math.min(clip.duration, 4); time += step) {
    mixer.update(step);
    lowest = Math.min(lowest, toeHeight(root, toes));
  }
  action.stop();
  mixer.setTime(0);

  if (Number.isFinite(lowest)) root.position.y -= lowest - bindHeight;
  root.updateMatrixWorld(true);
}

/**
 * Derive a rig's own forward from its bind pose.
 *
 * The heel → toe vector is the most reliable indicator of facing on a bind
 * pose that may not be axis aligned, and everything that turns the body reads
 * the yaw it produces.
 */
function measureFacing(root) {
  root.updateMatrixWorld(true);

  let foot = null;
  let toe = null;
  root.traverse((node) => {
    if (!node.isBone) return;
    // Exporters disagree on the namespace: "mixamorig:LeftFoot", "mixamorigLeftFoot".
    const short = node.name.split(':').pop().replace(/^mixamorig/i, '');
    if (short === 'LeftFoot' && !foot) foot = node;
    else if (short === 'LeftToeBase' && !toe) toe = node;
  });

  const forwardAxis = new Vector3(0, 0, 1);
  if (foot && toe) {
    const heel = foot.getWorldPosition(new Vector3());
    const tip = toe.getWorldPosition(new Vector3()).sub(heel).setY(0);
    if (tip.lengthSq() > 1e-6) forwardAxis.copy(tip).normalize();
  }

  return {
    forwardAxis,
    forwardYaw: Math.atan2(forwardAxis.x, forwardAxis.z),
    rightAxis: new Vector3(0, 1, 0).cross(forwardAxis).normalize()
  };
}

/**
 * Loads the rigged FBX, normalises it for the scene and drives its animation.
 *
 * The character breathes on a loop, runs where you steer it, turns to face
 * where you are aiming, and throws one of the cast clips when you fire. Those
 * clips ship as separate Mixamo exports of the *same* skeleton, so only their
 * `AnimationClip` is kept: the mixer binds tracks by bone name, which is all
 * that a shared rig needs for a clip authored in another file to play here.
 *
 * Which clip an ability throws is `settings[element].castAnim` — a per-ability
 * choice, editable live, which is why `playCast` takes the name each time
 * rather than caching one.
 *
 * Locomotion is the idle and the run cycle held against each other: `move`
 * carries the travel in the transform — position, heading, a lean into the run
 * — and `_blendLegs` trades weight between the two clips against how fast the
 * body is actually going, so a tap of a key walks and a held key runs. A cast
 * takes both of them off screen for its duration; it is a full-body clip and a
 * run left underneath it would average the two into neither.
 */
export class CharacterController {
  constructor(environment) {
    this.environment = environment;
    this.root = new Group();
    this.root.name = 'Character';

    // Position and heading live on `root`; the bank (walk mode leans into its
    // turns) lives on a joint underneath it, so the two never fight over the
    // same rotation.
    this.tilt = new Group();
    this.tilt.name = 'CharacterTilt';
    this.root.add(this.tilt);

    this.mixer = null;
    /** The looping breath, always running underneath a cast. */
    this.idle = null;
    /** The looping run cycle, weighted against the idle by travel speed. */
    this.run = null;
    /** name → one-shot cast action. */
    this.casts = new Map();
    /** The cast currently being thrown, null while idling. */
    this._cast = null;
    /** Every character built so far, kept warm so switching back is instant. */
    this._bundles = new Map();
    this._active = null;
    this.height = 1.8;
    this.headPosition = new Vector3(0, 1.5, 0);
    /** The rig's own forward, in model space — the axis a bank rotates about. */
    this.forwardAxis = new Vector3(0, 0, 1);

    /**
     * Yaw of the rig's own forward in model space. Bind poses are not
     * necessarily axis aligned, so `setFacing` subtracts this to make "0 faces
     * +Z" true for the caller regardless of how the FBX was authored.
     */
    this._forwardYaw = 0;
    /** 0..1 lunge envelope, decays on its own after `castLunge()`. */
    this._lunge = 0;
    this._rightAxis = new Vector3(1, 0, 0);

    /** World-space walk velocity on XZ; y stays 0, the character does not leave the floor. */
    this.velocity = new Vector3();
    /** Radians the body is currently leaning into its own run. */
    this._moveLean = 0;
    this._desiredVelocity = new Vector3();
    this._bodyForward = new Vector3();
  }

  /**
   * Load the configured character and put it on stage.
   * @param {import('../loaders/AssetLoader.js').AssetLoader} assets
   */
  async load(assets) {
    return this.setCharacter(settings.character.model, assets);
  }

  /**
   * Switch to (and lazily build) a character by id.
   *
   * Safe at runtime: each character is built once and kept warm, so toggling
   * back is instant and no GPU resource is ever shared between two rigs.
   */
  async setCharacter(id, assets) {
    const character = CHARACTERS[id] ?? Object.values(CHARACTERS)[0];
    let bundle = this._bundles.get(character);
    if (!bundle) {
      bundle = await this._buildBundle(character, assets);
      this._bundles.set(character, bundle);
    }
    this._activate(bundle);
    return this;
  }

  /** Parse one character's files into a self-contained, stage-ready bundle. */
  async _buildBundle(character, assets) {
    const clipIds = ['run', ...CAST_ANIMATIONS];
    // The clip files are the same skeleton again, so they cost a parse each
    // but nothing at run time — everything but the clip is thrown away below.
    const [fbx, skin, ...clipFiles] = await Promise.all([
      assets.loadFBX(modelUrl(character.model)),
      assets.loadTexture(modelUrl(character.texture)),
      ...clipIds.map((id) => assets.loadFBX(modelUrl(character.clips[id] ?? `${id}.fbx`)))
    ]);
    // The FBX resolves before its textures do; material prep inspects them.
    await assets.settled();

    fbx.scale.setScalar(FBX_SCALE);
    fbx.updateMatrixWorld(true);

    const box = new Box3().setFromObject(fbx);
    const size = new Vector3();
    const center = new Vector3();
    box.getSize(size);

    // Normalise the rig's height, then drop it onto y = 0 and centre it.
    fbx.scale.setScalar(FBX_SCALE * (TARGET_HEIGHT / Math.max(0.001, size.y)));
    fbx.updateMatrixWorld(true);
    box.setFromObject(fbx);
    box.getSize(size);
    box.getCenter(center);
    fbx.position.x -= center.x;
    fbx.position.z -= center.z;
    fbx.position.y -= box.min.y;

    this._prepareMaterials(fbx, skin);

    const mixer = new AnimationMixer(fbx);
    mixer.addEventListener('finished', this._onCastFinished);

    // Every clip binds by bone name, so this rig's names decide what plays.
    const bones = new Set();
    fbx.traverse((node) => bones.add(node.name));

    const bundle = {
      root: fbx,
      mixer,
      idle: null,
      run: null,
      casts: new Map(),
      height: size.y,
      headY: size.y * 0.86,
      ...measureFacing(fbx)
    };

    // The breath ships inside the character file itself.
    const idleClip = prepareClip('idle', fbx, bones);
    if (!idleClip) {
      console.warn(`[CharacterController] no idle clip found in ${character.model}`);
    } else {
      bundle.idle = mixer.clipAction(idleClip);
      bundle.idle.setLoop(LoopRepeat, Infinity);
      // The drop above was measured on a pose nobody ever sees. Plant it against
      // the one that is actually on screen.
      plantOnFloor(fbx, mixer, bundle.idle);
    }

    // The run loops from the start and simply carries no weight while standing,
    // so stepping off is a blend rather than a clip starting from frame zero.
    const runClip = prepareClip('run', clipFiles[0], bones);
    if (runClip) {
      bundle.run = mixer.clipAction(runClip);
      bundle.run.setLoop(LoopRepeat, Infinity);
      disposeObject(clipFiles[0]); // the duplicate rig it came with, like the casts
    }

    CAST_ANIMATIONS.forEach((name, index) => {
      const clip = prepareClip(name, clipFiles[index + 1], bones);
      if (!clip) return;
      const action = mixer.clipAction(clip);
      action.setLoop(LoopOnce, 1);
      // Hold the last frame rather than snapping home; the fade back to the
      // idle is what actually ends the cast.
      action.clampWhenFinished = true;
      bundle.casts.set(name, action);
      disposeObject(clipFiles[index + 1]);
    });

    return bundle;
  }

  /** Put a built bundle on stage, replacing whatever is there. */
  _activate(bundle) {
    if (this._active === bundle) return;
    // Rigs bind facing different ways; carry the current heading across.
    const yaw = this._active ? this.facing : null;

    if (this._active) {
      this._active.mixer.stopAllAction();
      this.tilt.remove(this._active.root);
    }

    this._active = bundle;
    this.model = bundle.root;
    this.mixer = bundle.mixer;
    this.idle = bundle.idle;
    this.run = bundle.run;
    this.casts = bundle.casts;
    this._cast = null;
    this.height = bundle.height;
    this.headPosition.set(0, bundle.headY, 0);
    this.forwardAxis.copy(bundle.forwardAxis);
    this._forwardYaw = bundle.forwardYaw;
    this._rightAxis.copy(bundle.rightAxis);

    this.tilt.add(bundle.root);
    if (yaw !== null) this.setFacing(yaw);

    if (this.idle) this.idle.reset().play();
    if (this.run) {
      this.run.reset().play();
      this.run.weight = 0;
    }
  }

  /**
   * Convert imported materials to PBR and hook them into the shadow system.
   *
   * @param {import('three').Object3D} root
   * @param {import('three').Texture} skin the character's colour map
   */
  _prepareMaterials(root, skin) {
    const converted = new Map();

    // TextureLoader assumes linear data; this one is authored colour.
    skin.colorSpace = SRGBColorSpace;

    root.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      node.layers.enable(LAYER.CONTACT); // captured by the contact shadow pass

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (!material) return material;
        if (converted.has(material)) return converted.get(material);

        // FBX gives us Phong/Lambert; move to Standard so IBL and CSM apply.
        // This export ships no texture of its own, so the skin loaded alongside
        // it is the colour map — but a file that *does* carry one embedded still
        // wins, since that map is authored against its own UVs. Exporters
        // disagree on which slot the normal map lands in, so both are passed
        // through and the empty one costs nothing.
        //
        // The tint is dropped with the map: an untextured FBX defaults to a flat
        // grey that would otherwise darken every texel of the skin.
        const standard = new MeshStandardMaterial({
          name: material.name,
          color: material.map ? (material.color ?? 0xffffff) : 0xffffff,
          map: material.map ?? skin,
          normalMap: material.normalMap ?? null,
          bumpMap: material.normalMap ? null : (material.bumpMap ?? null),
          roughness: 0.85,
          metalness: 0,
          transparent: material.transparent ?? false,
          opacity: material.opacity ?? 1,
          side: material.side
        });

        // Worth the samples: the character is the one thing on screen the camera
        // gets close to, and its texels sit at a grazing angle across the torso.
        for (const map of [standard.map, standard.normalMap, standard.bumpMap]) {
          if (map) map.anisotropy = 4;
        }

        this.environment.registerShadowCaster(standard);
        material.dispose(); // textures are shared with the new material, not owned
        converted.set(material, standard);
        return standard;
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });
  }

  /* ------------------------------------------------------------------ */
  /* cast clips                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Throw one cast clip over the idle, once.
   *
   * @param {string} [name] an id from `CAST_ANIMATIONS`; falls back to the first
   *   one so an ability configured with a clip that failed to load still moves.
   */
  playCast(name) {
    const next = this.casts.get(name) ?? this.casts.get(CAST_ANIMATIONS[0]);
    if (!next || !this.idle) return;

    const previous = this._cast;
    this._cast = next;

    next.reset();
    next.setEffectiveTimeScale(settings.character.castSpeed);
    next.play();

    // Fade from whatever is actually on screen — the idle on a first cast, the
    // clip still finishing on a re-cast — so the body never drops to the bind
    // pose for a frame in between two throws. Re-throwing the *same* clip only
    // restarts it: `reset()` has already left it at full weight.
    const from = previous ?? this.idle;
    if (from !== next) next.crossFadeFrom(from, settings.character.castBlendIn, false);

    // The legs leave with the idle. Only on the *first* throw: a re-cast would
    // restart this fade from full weight and pop the run back for a frame.
    if (this.run && !previous) this.run.fadeOut(settings.character.castBlendIn);
  }

  /** True while a cast clip is playing. */
  get isCasting() {
    return this._cast !== null;
  }

  _onCastFinished = (event) => {
    // Anything else finishing is an older clip that a re-cast already faded out.
    if (event.action !== this._cast) return;
    this._cast = null;

    // The fade in disabled the idle once its weight hit zero; wake it back up
    // before asking it to come in again.
    this.idle.enabled = true;
    this.idle.setEffectiveTimeScale(1);
    this.idle.crossFadeFrom(event.action, settings.character.castBlendOut, false);

    // Same for the legs — their own fade left them disabled at zero weight.
    if (this.run) {
      this.run.enabled = true;
      this.run.fadeIn(settings.character.castBlendOut);
    }
  };

  /* ------------------------------------------------------------------ */
  /* placement — driven by walk mode, inert otherwise                    */
  /* ------------------------------------------------------------------ */

  /** Heading, radians about world +Y. 0 faces +Z, whichever way the rig binds. */
  setFacing(yaw) {
    this.root.rotation.y = yaw - this._forwardYaw;
  }

  get facing() {
    return this.root.rotation.y + this._forwardYaw;
  }

  /**
   * Walk the body one step along a world-space direction.
   *
   * `direction` is where the player is pushing, already resolved into world
   * space by the caller — this controller has no idea a camera exists. Its
   * length is the throttle: 0 stands still, 1 runs flat out.
   *
   * Meant to be driven by *real* time rather than the simulation delta, so you
   * can still walk around a frozen effect to look at it while paused.
   *
   * @param {Vector3} direction on XZ, length 0..1
   * @param {number} dt
   */
  move(direction, dt, speedScale = 1) {
    const c = settings.character;
    const throttle = Math.min(1, Math.hypot(direction.x, direction.z));

    this._desiredVelocity.set(direction.x, 0, direction.z).multiplyScalar(c.walkSpeed * speedScale);

    // Two eases rather than one: holding a key ramps the body up, letting go
    // plants it. Which applies is just whether anything is being asked for.
    const ease = throttle > 0 ? c.walkAccel : c.walkStop;
    this.velocity.set(
      damp(this.velocity.x, this._desiredVelocity.x, ease, dt),
      0,
      damp(this.velocity.z, this._desiredVelocity.z, ease, dt)
    );

    this.root.position.x += this.velocity.x * dt;
    this.root.position.z += this.velocity.z * dt;

    // The floor is a finite plane; keep the character on the part of the world
    // that is actually drawn.
    const distance = Math.hypot(this.root.position.x, this.root.position.z);
    if (distance > c.roamRadius) {
      const scale = c.roamRadius / distance;
      this.root.position.x *= scale;
      this.root.position.z *= scale;
    }

    // Lean into the run, measured along the body's *own* forward rather than
    // along the direction of travel: strafing sideways while aiming down the
    // arrow should not pitch the torso at the floor.
    this._bodyForward.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    const forward = this.velocity.dot(this._bodyForward) / Math.max(0.001, c.walkSpeed);
    this._moveLean = damp(this._moveLean, clamp(forward, -1, 1) * c.walkLean, 0.0001, dt);
  }

  /** True once the body is actually travelling, not merely being pushed. */
  get isMoving() {
    return this.velocity.lengthSq() > 0.01;
  }

  /** Heading of travel, radians about world +Y, in the same frame as `facing`. */
  get heading() {
    return Math.atan2(this.velocity.x, this.velocity.z);
  }

  /**
   * Turn toward `yaw` over time rather than snapping.
   * @param {number} rate fraction of the angle gap left after one second
   */
  turnToward(yaw, rate, dt) {
    const current = this.facing;
    // Shortest way round, so aiming across the -Z seam does not spin the body.
    const delta = MathUtils.euclideanModulo(yaw - current + Math.PI, Math.PI * 2) - Math.PI;
    this.setFacing(current + delta * (1 - Math.pow(MathUtils.clamp(rate, 1e-6, 1), dt)));
  }

  /**
   * Punch the body forward, then let it settle.
   *
   * An accent laid over the cast clip rather than a substitute for it: a pitch
   * about the body's own right axis plus a shove back along its forward axis,
   * both riding on one decaying envelope. Applied to `tilt` rather than `root`
   * so it composes with the heading instead of fighting it, and turned off by
   * dropping `castLean` and `castRecoil` to zero when the clip says it all.
   */
  castLunge() {
    this._lunge = 1;
  }

  /**
   * Compose every procedural accent the body carries onto `tilt`.
   *
   * The cast lunge and the walk lean are both a pitch about the body's own
   * right axis, so they are summed into a single rotation here rather than
   * written one after the other — two components racing to own
   * `tilt.quaternion` would mean whichever ran last simply erased the other.
   */
  _applyBodyAccents(dt) {
    const c = settings.character;
    if (this._lunge > 0) {
      this._lunge = Math.max(0, this._lunge - c.castSettle * dt);
    }
    // A short overshoot at the front of the envelope reads as a snap rather than
    // a slow bow.
    const envelope = this._lunge * this._lunge * (1 + 0.35 * Math.sin(this._lunge * Math.PI));
    this.tilt.quaternion.setFromAxisAngle(this._rightAxis, envelope * c.castLean + this._moveLean);
    this.tilt.position.copy(this.forwardAxis).multiplyScalar(-envelope * c.castRecoil);
  }

  /** Put the character back on the floor, upright, still and facing where it was. */
  resetPlacement() {
    this.root.position.y = 0;
    this._lunge = 0;
    this._moveLean = 0;
    this.velocity.set(0, 0, 0);
    this.tilt.quaternion.identity();
    this.tilt.position.set(0, 0, 0);
  }

  /**
   * Trade weight between the idle and the run against how fast the body is
   * actually travelling.
   *
   * Written to `weight` — the *base* the mixer's own cross-fades are applied on
   * top of — rather than through `setEffectiveWeight`, which cancels any fade in
   * flight. So the legs are steered here every frame and a cast still owns the
   * blend for as long as it runs.
   */
  _blendLegs() {
    if (!this.run || !this.idle) return;

    const c = settings.character;
    const blend = clamp(this.velocity.length() / Math.max(0.001, c.walkSpeed), 0, 1);
    this.idle.weight = 1 - blend;
    this.run.weight = blend;

    // Stride follows ground speed, or the feet skate across the floor. The clip
    // covers `walkSpeed` at rate 1 closely enough that `runPlayback` starts at
    // one; it is the knob for when it does not.
    this.run.timeScale = blend * c.runPlayback;
  }

  update(dt) {
    // Driven by the *simulation* delta, and re-applied every frame even at
    // dt = 0: pausing mid-cast holds the lunge, and `castLean` stays a live
    // slider against that frozen pose.
    this._applyBodyAccents(dt);

    if (!this.mixer) return;

    this._blendLegs();
    this.mixer.timeScale = settings.global.animationSpeed;
    this.mixer.update(dt);
  }

  get position() {
    return this.root.position;
  }

  dispose() {
    for (const bundle of this._bundles.values()) {
      bundle.mixer.removeEventListener('finished', this._onCastFinished);
      bundle.mixer.stopAllAction();
      disposeObject(bundle.root);
    }
    this._bundles.clear();
    this._active = null;
    this.mixer = null;
    this.idle = null;
    this.run = null;
    this.casts.clear();
    this._cast = null;
    disposeObject(this.root);
  }
}
