import { IceAbility } from './IceAbility.js';
import { ThunderAbility } from './ThunderAbility.js';
import { MeteorAbility } from './MeteorAbility.js';
import { BeamAbility } from './BeamAbility.js';
import { SnareAbility } from './SnareAbility.js';
import { GlacierAbility } from './GlacierAbility.js';
import { FireballAbility } from './FireballAbility.js';
import { LineSweepSkill } from './templates/LineSweepSkill.js';
import { ZoneBurstSkill } from './templates/ZoneBurstSkill.js';
import { OrbitAuraSkill } from './templates/OrbitAuraSkill.js';
import { ShieldSkill } from './templates/ShieldSkill.js';
import { DashStrikeSkill } from './templates/DashStrikeSkill.js';
import { ChainBoltSkill } from './templates/ChainBoltSkill.js';
import { ELEMENTS } from '../config/settings.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { isFusionId, pairKeyOf } from '../run/fusions.js';
import { VineBlazeSkill } from './fusions/VineBlazeSkill.js';
import { VolcanoSkill } from './fusions/VolcanoSkill.js';
import { PrismArraySkill } from './fusions/PrismArraySkill.js';
import { BladeTideSkill } from './fusions/BladeTideSkill.js';
import { ThunderMarshSkill } from './fusions/ThunderMarshSkill.js';

/**
 * Registry: adding an ability means adding one line here.
 *
 * Exported (M6 T2) as the single source of truth for "does this `ELEMENTS`
 * id actually have a class yet" — `ELEMENTS` itself carries thirteen ids
 * with no class until T4-6 register them here, and anything that offers an
 * element up for the player to pick (a draft card, a HUD slot) needs to ask
 * this, not `ELEMENTS`, or it offers something that can never actually cast.
 *
 * M6 T4 registered nine of the thirteen onto three data-driven template
 * classes (LineSweepSkill/ZoneBurstSkill/OrbitAuraSkill); M6 T5 added the two
 * `shield`-kind specials onto a fourth (ShieldSkill); M6 T6 adds the last
 * two `self`-kind specials onto a fifth and sixth (DashStrikeSkill,
 * ChainBoltSkill — each is its own class, unlike the shared-class rows
 * above, since a dash and a chain hop are shaped nothing alike) — several
 * keys below share the same class reference on purpose: the pool-building
 * loop keys everything by element id, not by class, so each still gets its
 * own pool and its own live instances (see the constructor below). Every one
 * of the thirteen M6 T2 ids is now registered.
 */
export const ABILITY_TYPES = {
  ice: IceAbility,
  thunder: ThunderAbility,
  meteor: MeteorAbility,
  beam: BeamAbility,
  snare: SnareAbility,
  glacier: GlacierAbility,
  fireball: FireballAbility,

  rockspikes: LineSweepSkill,
  // M8 T2: two more line fields on the same template — a water wall that
  // sweeps and shoves, and a thorn road that keeps burning where it stood.
  tidalsurge: LineSweepSkill,
  thornroad: LineSweepSkill,

  swordrain: ZoneBurstSkill,
  // M8 T2: a six-wave hail barrage and a single heavy pillar, both pure
  // data on the burst template (their wave tables live in settings.combat).
  hailstorm: ZoneBurstSkill,
  stonepillar: ZoneBurstSkill,
  lifebloom: ZoneBurstSkill,
  frostnova: ZoneBurstSkill,
  boulder: ZoneBurstSkill,
  quake: ZoneBurstSkill,

  bladeorbit: OrbitAuraSkill,
  firering: OrbitAuraSkill,
  sunwheel: OrbitAuraSkill,

  iceshield: ShieldSkill,
  stoneskin: ShieldSkill,

  dashstrike: DashStrikeSkill,
  chainbolt: ChainBoltSkill
};

/**
 * Fusion registry (M7 T1 skeleton): a fusion id resolves its class by
 * pair-key ('4+0'), not by the literal fusion id string — many different
 * specific parent pairs share one wuxing pair (`fusions.js#pairKeyOf`), and
 * every one of them casts the same bespoke spell, so `ABILITY_TYPES`'s
 * flat per-skill-id keying can't answer this the way it answers a plain
 * element. Every entry is null until its own task (T2-T6) lands a class
 * here — `cast()` below already treats a null resolve exactly like an
 * `ABILITY_TYPES` miss (return null, no throw), so a still-unregistered
 * pair safely no-ops.
 */
export const FUSION_CLASSES = {
  '1+3': VineBlazeSkill, // 业火燎原 (T2)
  '3+4': VolcanoSkill, // 地心火山 (T3)
  '4+0': PrismArraySkill, // 锋岩星阵 (T4)
  '0+2': BladeTideSkill, // 霜刃洪流 (T5)
  '2+1': ThunderMarshSkill // 回春雷泽 (T6)
};

const MAX_CONCURRENT = 4;

/**
 * Spawns, updates and recycles abilities.
 *
 * Instances are pooled per type: casting fifty times constructs at most a
 * handful of objects per ability, and every one of them keeps its meshes and
 * materials for the lifetime of the app. Nothing is built during a cast.
 *
 * `MAX_CONCURRENT` is shared across types, so mixing abilities retires the
 * oldest cast whichever element it was.
 */
export class AbilityManager {
  /**
   * @param {object} context shared systems handed to every ability:
   *   { scene, camera, environment, particles, lights, decals, bursts, shake, flash }
   */
  constructor(context) {
    this.ctx = context;
    this.active = [];
    this.selected = ELEMENTS[0];
    /** Assigned by the run mode: observes every ability leaving play (pooling-safe cast cleanup). */
    this.onRetire = null;

    this.pools = new Map();
    for (const [element, Type] of Object.entries(ABILITY_TYPES)) {
      this.pools.set(element, new ObjectPool(() => this._spawnInstance(Type, element)));
    }
  }

  /**
   * Build one pooled instance: construct, add its group to the scene,
   * hide it until the first `spawn()`. Shared by the constructor's eager
   * `ABILITY_TYPES` loop above and `cast()`'s own lazy fusion branch below.
   *
   * The `element` second argument is only read by the M6 T4 template
   * classes (LineSweepSkill/ZoneBurstSkill/OrbitAuraSkill), which register
   * the same class under several ids — every hand-written ability's
   * constructor takes one argument and simply ignores it.
   */
  _spawnInstance(Type, element) {
    const ability = new Type(this.ctx, element);
    this.ctx.scene.add(ability.group);
    ability.group.visible = false;
    return ability;
  }

  select(element) {
    if (!ABILITY_TYPES[element]) return;
    this.selected = element;
  }

  /**
   * Cast the selected ability along a line.
   *
   * A far cast takes the same three arguments and simply works from the far end
   * of that line — which is why adding zone targeting needed nothing here.
   *
   * @param {THREE.Vector3} origin     on the floor
   * @param {THREE.Vector3} direction  unit, flat
   * @param {number} distance          metres
   * @returns {import('./Ability.js').Ability|null}
   */
  cast(origin, direction, distance, element = this.selected) {
    // M7 T1: a fusion id resolves through FUSION_CLASSES by pair-key
    // instead of ABILITY_TYPES by literal id (see that registry's own
    // doc) — a still-null entry (T3-T6, not yet landed) is a no-throw
    // no-op, same as an ABILITY_TYPES miss.
    const registered = isFusionId(element) ? FUSION_CLASSES[pairKeyOf(element)] : ABILITY_TYPES[element];
    if (!registered) return null;

    // M7 T2: unlike ABILITY_TYPES (a fixed, small id set the constructor
    // pools eagerly, above), the set of literal fusion ids that will ever
    // actually be cast can't be known up front — many different specific
    // parent-name pairs can share one pair-key (fusions.js#pairKeyOf), and
    // every one of them still pools separately, keyed by its own literal id
    // (every call below keys `this.pools` off `ability.element`, i.e. the
    // literal id, never the pair-key). Build this one pool lazily, the
    // first time this exact literal id is ever cast.
    if (isFusionId(element) && !this.pools.has(element)) {
      this.pools.set(element, new ObjectPool(() => this._spawnInstance(registered, element)));
    }

    // Retire the oldest cast rather than letting the scene grow without bound.
    // M6 T4: a permanent aura (`ability.permanent` — OrbitAuraSkill) never
    // reaches DONE on its own, so it would otherwise always BE "the oldest"
    // and flicker out the moment a fourth unrelated spell is in flight —
    // evict the oldest ordinary cast instead. At most three elements are
    // ever permanent, so this can't starve: there's always a non-permanent
    // "oldest" once four-plus casts are actually active.
    if (this.active.length >= MAX_CONCURRENT) {
      const i = this.active.findIndex((a) => !a.permanent);
      if (i !== -1) {
        const oldest = this.active[i];
        this.active.splice(i, 1);
        this.onRetire?.(oldest);
        oldest.destroy();
        this.pools.get(oldest.element).release(oldest);
      }
    }

    const ability = this.pools.get(element).acquire();
    ability.spawn(origin, direction, distance);
    this.active.push(ability);
    return ability;
  }

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const ability = this.active[i];
      ability.update(dt);
      if (ability.isFinished) {
        this.active.splice(i, 1);
        this.onRetire?.(ability);
        ability.destroy();
        this.pools.get(ability.element).release(ability);
      }
    }
  }

  /**
   * Force-retire one specific active cast immediately, before it would ever
   * finish on its own — the M6 T4 permanent-aura unseat/run-end path
   * (`装备即常驻`: OrbitAuraSkill never reaches DONE by itself, see its own
   * doc). Same three-step shape as every other exit point in this file
   * (onRetire → destroy → pool release). No-op if `ability` isn't active
   * (already retired, or never was).
   */
  retire(ability) {
    const i = this.active.indexOf(ability);
    if (i === -1) return;
    this.active.splice(i, 1);
    this.onRetire?.(ability);
    ability.destroy();
    this.pools.get(ability.element).release(ability);
  }

  /** Cancel everything currently in flight. */
  clear() {
    for (const ability of this.active) {
      this.onRetire?.(ability);
      ability.destroy();
      this.pools.get(ability.element).release(ability);
    }
    this.active.length = 0;
  }

  /** The most recent still-running cast — used to frame the camera. */
  get focus() {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].isActive) return this.active[i];
    }
    return null;
  }

  dispose() {
    this.clear();
    for (const pool of this.pools.values()) pool.dispose((ability) => ability.dispose());
    this.pools.clear();
  }
}
