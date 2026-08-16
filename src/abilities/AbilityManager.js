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
import { ELEMENTS } from '../config/settings.js';
import { ObjectPool } from '../utils/ObjectPool.js';

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
 * classes (LineSweepSkill/ZoneBurstSkill/OrbitAuraSkill); M6 T5 adds the two
 * `shield`-kind specials onto a fourth (ShieldSkill) — several keys below
 * share the same class reference on purpose: the pool-building loop keys
 * everything by element id, not by class, so each still gets its own pool
 * and its own live instances (see the constructor below). Only dashstrike/
 * chainbolt (T6) stay unregistered now.
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

  swordrain: ZoneBurstSkill,
  lifebloom: ZoneBurstSkill,
  frostnova: ZoneBurstSkill,
  boulder: ZoneBurstSkill,
  quake: ZoneBurstSkill,

  bladeorbit: OrbitAuraSkill,
  firering: OrbitAuraSkill,
  sunwheel: OrbitAuraSkill,

  iceshield: ShieldSkill,
  stoneskin: ShieldSkill
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
      this.pools.set(
        element,
        new ObjectPool(() => {
          // The `element` second argument is only read by the M6 T4 template
          // classes (LineSweepSkill/ZoneBurstSkill/OrbitAuraSkill), which
          // register the same class under several ids — every hand-written
          // ability's constructor takes one argument and simply ignores it.
          const ability = new Type(this.ctx, element);
          this.ctx.scene.add(ability.group);
          ability.group.visible = false;
          return ability;
        })
      );
    }
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
    if (!ABILITY_TYPES[element]) return null;

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
