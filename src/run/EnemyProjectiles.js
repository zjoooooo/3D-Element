import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';
import { settings } from '../config/settings.js';

/**
 * The spitters' shots (spec §5): straight red bolts, dodgeable by the
 * spacebar's iframes downstream. Same flat arrays as everything else; the
 * Points cloud is red and slightly fat because threats read in red and
 * nothing else does (spec §5.5 敌我可读性).
 */
const CAP = 128;

export class EnemyProjectiles {
  constructor() {
    this.count = 0;
    this.x = new Float32Array(CAP);
    this.z = new Float32Array(CAP);
    this.vx = new Float32Array(CAP);
    this.vz = new Float32Array(CAP);
    this.age = new Float32Array(CAP);

    const geometry = new BufferGeometry();
    this._positions = new Float32Array(CAP * 3);
    geometry.setAttribute('position', new BufferAttribute(this._positions, 3));
    geometry.setDrawRange(0, 0);
    this.points = new Points(
      geometry,
      new PointsMaterial({ color: 0xff4433, size: 0.5, sizeAttenuation: true })
    );
    this.points.frustumCulled = false;
  }

  spawn(x, z, dirX, dirZ) {
    if (this.count >= CAP) return;
    const c = settings.enemies.projectile;
    const i = this.count++;
    this.x[i] = x;
    this.z[i] = z;
    this.vx[i] = dirX * c.speed;
    this.vz[i] = dirZ * c.speed;
    this.age[i] = 0;
  }

  /** Advance every shot; returns the damage that reached the player this tick. */
  tick(step, player) {
    const c = settings.enemies.projectile;
    let dealt = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      this.x[i] += this.vx[i] * step;
      this.z[i] += this.vz[i] * step;
      if ((this.age[i] += step) > c.life) {
        this._remove(i);
        continue;
      }
      if (Math.hypot(this.x[i] - player.x, this.z[i] - player.z) < c.radius + 0.5) {
        dealt += c.damage;
        this._remove(i);
      }
    }
    return dealt;
  }

  _remove(i) {
    const last = --this.count;
    this.x[i] = this.x[last];
    this.z[i] = this.z[last];
    this.vx[i] = this.vx[last];
    this.vz[i] = this.vz[last];
    this.age[i] = this.age[last];
  }

  sync() {
    for (let i = 0; i < this.count; i++) {
      this._positions[i * 3] = this.x[i];
      this._positions[i * 3 + 1] = 0.9; // chest height — a shot, not a gem
      this._positions[i * 3 + 2] = this.z[i];
    }
    this.points.geometry.setDrawRange(0, this.count);
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  clear() {
    this.count = 0;
  }
}
