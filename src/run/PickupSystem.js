import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';
import { settings } from '../config/settings.js';

/**
 * Gems on the floor and the xp they carry (spec §6).
 *
 * Same flat-array discipline as the enemies. A gem inside the magnet radius
 * flies to the player and converts to xp on contact; levels accumulate here
 * and the upgrade UI (M2) drains them. Rendering is one Points cloud — gems
 * are dots of light, not meshes.
 */
const CAP = 512;
const MAGNET_SPEED = 12; // metres/second once caught by the magnet

export class PickupSystem {
  constructor() {
    this.count = 0;
    this.x = new Float32Array(CAP);
    this.z = new Float32Array(CAP);
    this.value = new Float32Array(CAP);
    this.xp = 0;
    this.level = 0;
    // Run upgrade layer; null in the sandbox — xp then passes through unscaled.
    this.mods = null;

    const geometry = new BufferGeometry();
    this._positions = new Float32Array(CAP * 3);
    geometry.setAttribute('position', new BufferAttribute(this._positions, 3));
    geometry.setDrawRange(0, 0);
    this.points = new Points(
      geometry,
      new PointsMaterial({ color: 0x9fe86a, size: 0.35, sizeAttenuation: true })
    );
    this.points.frustumCulled = false;
  }

  dropAt(x, z, minute) {
    if (this.count >= CAP) return; // oldest-gem eviction is M3 polish if ever needed
    const i = this.count++;
    this.x[i] = x;
    this.z[i] = z;
    this.value[i] = settings.run.gemBase * (1 + settings.run.gemPerMinute * minute);
  }

  xpNeed(level) {
    return settings.run.xpBase * Math.pow(settings.run.xpGrowth, level);
  }

  tick(step, player) {
    const magnet = settings.run.magnetRadius;
    let gained = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const dx = player.x - this.x[i];
      const dz = player.z - this.z[i];
      const d = Math.hypot(dx, dz);
      if (d < 0.5) {
        this.xp += this.value[i] * (this.mods ? this.mods.xpMult() : 1);
        const last = --this.count;
        this.x[i] = this.x[last];
        this.z[i] = this.z[last];
        this.value[i] = this.value[last];
        continue;
      }
      if (d < magnet) {
        this.x[i] += (dx / d) * MAGNET_SPEED * step;
        this.z[i] += (dz / d) * MAGNET_SPEED * step;
      }
    }
    while (this.xp >= this.xpNeed(this.level + 1)) {
      this.xp -= this.xpNeed(this.level + 1);
      this.level++;
      gained++;
    }
    return gained;
  }

  /** Push gem positions into the Points cloud; call once per rendered frame. */
  sync() {
    for (let i = 0; i < this.count; i++) {
      this._positions[i * 3] = this.x[i];
      this._positions[i * 3 + 1] = 0.25;
      this._positions[i * 3 + 2] = this.z[i];
    }
    this.points.geometry.setDrawRange(0, this.count);
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  clear() {
    this.count = 0;
    this.xp = 0;
    this.level = 0;
  }
}
