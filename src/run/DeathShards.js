import {
  InstancedMesh,
  TetrahedronGeometry,
  MeshStandardMaterial,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  Object3D
} from 'three';
import { ELEMENT_TINTS } from './EnemyRenderer.js';

/**
 * Death shatter (spec 打击感 / M5 Task 9): a kill pops into a handful of
 * tinted tetrahedra — five-wuxing colour off `onDeath`'s own `element` index,
 * the same `ELEMENT_TINTS` EnemyRenderer paints the horde with — flying out
 * radially, pulled down by gravity, shrinking to nothing over their short
 * life. One InstancedMesh, flat per-shard arrays, zero allocation once built
 * (same discipline as EnemyProjectiles/PickupSystem — swap-remove, no `new`
 * inside `burst()`/`update()`). Run-only: constructed only inside App's
 * `if (this.runMode)` block, alongside the other horde-driven renderers.
 */
const SHARDS_PER_BURST = 8;
const MAX_BURSTS = 40; // concurrent death-bursts the pool holds at once
const CAP = MAX_BURSTS * SHARDS_PER_BURST; // 320
const GRAVITY = 14; // m/s² — matches this project's other *Gravity settings for chips/shards
const LIFE = 0.7; // seconds a shard takes to shrink away, ± a little per shard
const SPEED = 2.6; // m/s, radial (horizontal)
const UP_SPEED = 2.2; // m/s, initial vertical kick
const SIZE = 0.12; // metres, base tetrahedron radius; elites burst at ×2

export class DeathShards {
  constructor(scene) {
    this.count = 0;
    this.x = new Float32Array(CAP);
    this.y = new Float32Array(CAP);
    this.z = new Float32Array(CAP);
    this.vx = new Float32Array(CAP);
    this.vy = new Float32Array(CAP);
    this.vz = new Float32Array(CAP);
    this.age = new Float32Array(CAP);
    this.life = new Float32Array(CAP);
    this.size = new Float32Array(CAP); // base radius (age/life shrinks it toward 0 at sync time)
    this.element = new Uint8Array(CAP); // ELEMENT_TINTS index, 0-4 (金木水火土)

    // Unit tetrahedron; per-instance scale carries the real (shrinking) size.
    const geometry = new TetrahedronGeometry(1, 0);
    const material = new MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
    this.mesh = new InstancedMesh(geometry, material, CAP);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Minted eagerly, same reason as EnemyRenderer: setColorAt would otherwise
    // lazily create the attribute with the static (non-dynamic) usage hint.
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = false; // small, short-lived debris — not worth the shadow pass
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this._proxy = new Object3D();
    this._color = new Color();
  }

  /**
   * A kill's shatter: `SHARDS_PER_BURST` shards tinted by `element` (spec's
   * five wuxing), doubled in size for an elite. Silently drops shards past
   * `CAP` (a burst never fires more than once per death, so a full pool means
   * an extraordinary pile-up of simultaneous kills — dropping the overflow
   * reads as "a few less fragments" rather than needing a bigger pool or a
   * recycle policy).
   */
  burst(x, z, element, elite) {
    const size = elite ? SIZE * 2 : SIZE;
    for (let n = 0; n < SHARDS_PER_BURST; n++) {
      if (this.count >= CAP) return;
      const i = this.count++;
      const angle = (n / SHARDS_PER_BURST) * Math.PI * 2 + Math.random() * 0.6;
      const speed = SPEED * (0.7 + Math.random() * 0.6);
      this.x[i] = x;
      this.y[i] = 0.5;
      this.z[i] = z;
      this.vx[i] = Math.cos(angle) * speed;
      this.vz[i] = Math.sin(angle) * speed;
      this.vy[i] = UP_SPEED * (0.6 + Math.random() * 0.8);
      this.age[i] = 0;
      this.life[i] = LIFE * (0.85 + Math.random() * 0.3);
      this.size[i] = size;
      this.element[i] = element;
    }
  }

  /** Advance every shard; dead ones swap-remove like the rest of the run's pools. */
  update(dt) {
    for (let i = this.count - 1; i >= 0; i--) {
      this.vy[i] -= GRAVITY * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
      if ((this.age[i] += dt) < this.life[i]) continue;

      const last = --this.count;
      this.x[i] = this.x[last];
      this.y[i] = this.y[last];
      this.z[i] = this.z[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.vz[i] = this.vz[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.size[i] = this.size[last];
      this.element[i] = this.element[last];
    }
  }

  /** Push position/scale/colour into the InstancedMesh; call once per rendered frame. */
  sync() {
    for (let i = 0; i < this.count; i++) {
      const shrink = Math.max(0, 1 - this.age[i] / this.life[i]);
      this._proxy.position.set(this.x[i], this.y[i], this.z[i]);
      this._proxy.scale.setScalar(this.size[i] * shrink);
      this._proxy.updateMatrix();
      this.mesh.setMatrixAt(i, this._proxy.matrix);
      this._color.setHex(ELEMENT_TINTS[this.element[i]]);
      this.mesh.setColorAt(i, this._color);
    }
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Drop every live shard instantly — restart's clean slate (App.clearEffects). */
  clear() {
    this.count = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
