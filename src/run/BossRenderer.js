import {
  Color,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  MeshBasicMaterial,
  AdditiveBlending,
  DoubleSide
} from 'three';
import { settings } from '../config/settings.js';

/**
 * 潮汐之主's body (M11 T5) — procedural, and deliberately replaceable.
 *
 * The spec asks for an authored boss (Meshy + Mixamo); CLAUDE.md's harder
 * constraint is that everything except the player's own FBX is procedural, and
 * the owner confirmed this milestone goes procedural with an imported model
 * left for later. So the seam matters more than the shape: this class READS
 * `BossSystem` and `BossSystem` never reads this. Swapping the geometry below
 * for a loaded mesh touches nothing about the fight.
 *
 * Three parts, no textures: a heavy faceted core that breathes, a ring of
 * shards orbiting it that thins as the fight goes on, and the telegraph ring
 * on the floor. That last one is not decoration — its radius is the radius the
 * move will actually judge, read from the same settings row the hit test uses
 * (WYSIWYG, spec §3): what the player dodges is what would have hit them.
 */

const SHARDS = 9;

/** Per-act tint: cold and composed, then hot, then furious. */
const PHASE_TINT = [0x5e86ff, 0xff9a3c, 0xff3b28];

export class BossRenderer {
  constructor(scene) {
    this.group = new Group();
    this.group.name = 'Boss';
    this.group.visible = false;

    const r = settings.enemies.boss.radius;

    /* ---- core ---- */
    this.coreGeometry = new IcosahedronGeometry(r * 0.62, 1);
    this.coreMaterial = new MeshStandardMaterial({
      color: 0x2a2f3d,
      roughness: 0.55,
      metalness: 0.35,
      emissive: PHASE_TINT[0],
      emissiveIntensity: 0.55,
      flatShading: true
    });
    this.core = new Mesh(this.coreGeometry, this.coreMaterial);
    this.core.position.y = r * 0.95;
    this.core.frustumCulled = false;

    /* ---- orbiting shards ---- */
    this.shardGeometry = new IcosahedronGeometry(r * 0.2, 0);
    this.shardMaterial = new MeshStandardMaterial({
      color: 0x1b2030,
      roughness: 0.4,
      metalness: 0.5,
      emissive: PHASE_TINT[0],
      emissiveIntensity: 0.8,
      flatShading: true
    });
    this.shards = new InstancedMesh(this.shardGeometry, this.shardMaterial, SHARDS);
    // 27b8397's lesson: an InstancedMesh's per-instance transforms never reach
    // its bounding sphere, so a culled one takes the whole formation with it.
    this.shards.frustumCulled = false;

    /* ---- telegraph ---- */
    // Unit ring, scaled to whatever the incoming move will judge.
    this.ringGeometry = new RingGeometry(0.93, 1, 64).rotateX(-Math.PI / 2);
    this.ringMaterial = new MeshBasicMaterial({
      color: 0xff5a3c,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      side: DoubleSide,
      depthWrite: false,
      toneMapped: false
    });
    this.ring = new Mesh(this.ringGeometry, this.ringMaterial);
    this.ring.position.y = 0.06;
    this.ring.frustumCulled = false;

    this.group.add(this.core, this.shards, this.ring);
    scene.add(this.group);

    this._proxy = new Object3D();
    this._tint = new Color();
    this._age = 0;
  }

  /**
   * @param {import('./BossSystem.js').BossSystem} boss
   * @param {import('./EnemySystem.js').EnemySystem} enemies
   * @param {number} dt seconds of real time — cosmetic only, never a judge
   * @param {number} alpha render interpolation, same one EnemyRenderer uses
   */
  render(boss, enemies, dt, alpha) {
    const i = boss?.active ? boss.index : -1;
    this.group.visible = i !== -1;
    if (i === -1) return;

    this._age += dt;
    const r = settings.enemies.boss.radius;
    const x = enemies.prevX[i] + (enemies.x[i] - enemies.prevX[i]) * alpha;
    const z = enemies.prevZ[i] + (enemies.z[i] - enemies.prevZ[i]) * alpha;
    this.group.position.set(x, 0, z);

    const phase = Math.min(PHASE_TINT.length - 1, boss.phase);
    this._tint.setHex(PHASE_TINT[phase]);
    // Hurt reads as heat: the emissive climbs as the bar empties, so the last
    // act glows even before the tint gets there.
    const heat = 0.55 + (1 - boss.hp01) * 1.1;
    this.coreMaterial.emissive.copy(this._tint);
    this.coreMaterial.emissiveIntensity = heat;
    this.shardMaterial.emissive.copy(this._tint);
    this.shardMaterial.emissiveIntensity = heat * 1.3;

    // The core breathes, faster as it gets angrier.
    const breathe = 1 + 0.05 * Math.sin(this._age * (1.6 + phase * 0.9));
    this.core.scale.setScalar(breathe);
    this.core.rotation.y = this._age * 0.35;
    this.core.rotation.x = Math.sin(this._age * 0.4) * 0.12;

    // Shards thin out act by act — the armour comes off.
    const live = Math.max(3, SHARDS - phase * 3);
    const spin = this._age * (0.8 + phase * 0.5);
    for (let k = 0; k < SHARDS; k++) {
      const a = (k / SHARDS) * Math.PI * 2 + spin;
      const lift = r * (0.75 + 0.45 * Math.sin(this._age * 1.3 + k));
      const s = k < live ? 1 : 0; // hidden rather than removed: no rebuild, no alloc
      this._proxy.position.set(Math.cos(a) * r * 1.15, lift, Math.sin(a) * r * 1.15);
      this._proxy.rotation.set(a * 1.7, a, this._age * 0.6 + k);
      this._proxy.scale.setScalar(s);
      this._proxy.updateMatrix();
      this.shards.setMatrixAt(k, this._proxy.matrix);
    }
    this.shards.instanceMatrix.needsUpdate = true;

    /* ---- the telegraph, which is the footprint ---- */
    const w = boss.windup;
    if (w?.move) {
      const t = Math.min(1, w.of > 0 ? w.t / w.of : 1);
      // World-placed, not parented: 碾压冲锋 warns where it will LAND, which is
      // where the player is standing, not where the boss is.
      this.ring.position.set(w.x - x, 0.06, w.z - z);
      this.ring.scale.setScalar(Math.max(0.01, w.radius));
      // Fills in as it winds up, so "how long have I got" is readable at a
      // glance rather than something you learn by dying to it.
      this.ringMaterial.opacity = 0.25 + 0.6 * t * t;
    } else {
      this.ringMaterial.opacity = 0;
    }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.coreGeometry.dispose();
    this.coreMaterial.dispose();
    this.shardGeometry.dispose();
    this.shardMaterial.dispose();
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
  }
}
