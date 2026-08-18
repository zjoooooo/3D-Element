import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';
import { settings } from '../config/settings.js';

/**
 * Gems on the floor and the xp they carry (spec §6).
 *
 * Same flat-array discipline as the enemies. A gem inside the magnet radius
 * flies to the player and converts to xp on contact; levels accumulate here
 * and the upgrade UI (M2) drains them. Rendering is one Points cloud — gems
 * are dots of light, not meshes.
 *
 * Four kinds share the arrays: green and gold are xp like any gem; blue's
 * magnet reaches the whole arena (an elite's kill should always find you);
 * shard carries an element index instead of xp and calls `onShard` on pickup.
 */
const CAP = 512;
const MAGNET_SPEED = 12; // metres/second once caught by the magnet
const KIND_COLOR = [
  [0.62, 0.91, 0.42], // 0 green
  [0.35, 0.65, 1], // 1 blue
  [1, 0.85, 0.3], // 2 gold
  [1, 1, 1] // 3 shard
];

export class PickupSystem {
  constructor() {
    this.count = 0;
    this.x = new Float32Array(CAP);
    this.z = new Float32Array(CAP);
    this.value = new Float32Array(CAP);
    this.kind = new Uint8Array(CAP); // 0 green / 1 blue(全场磁吸) / 2 gold / 3 shard
    this.xp = 0;
    this.level = 0;
    // Run upgrade layer; null in the sandbox — xp then passes through unscaled.
    this.mods = null;
    // Shards call back instead of granting xp; unset in the sandbox, where
    // nothing ever drops one.
    this.onShard = null;

    const geometry = new BufferGeometry();
    this._positions = new Float32Array(CAP * 3);
    this._colors = new Float32Array(CAP * 3);
    geometry.setAttribute('position', new BufferAttribute(this._positions, 3));
    geometry.setAttribute('color', new BufferAttribute(this._colors, 3));
    geometry.setDrawRange(0, 0);
    this.points = new Points(
      geometry,
      new PointsMaterial({ vertexColors: true, size: 0.35, sizeAttenuation: true })
    );
    this.points.frustumCulled = false;
  }

  dropAt(x, z, minute, kind = 0, value = null) {
    if (this.count >= CAP) {
      // M12 T1: a full field used to discard EVERYTHING, and by minute nine
      // the field is full — fourteen boss gems dropped into it and zero
      // landed. A drop that states its own value now evicts the cheapest gem
      // on the field instead; the common minute-gem keeps the old
      // drop-on-full, because an O(n) sweep for the commonest drop in the
      // game is a per-frame cost nobody sees, while one for the rarest is
      // the whole point.
      if (value === null) return;
      let cheapest = 0;
      for (let k = 1; k < this.count; k++) if (this.value[k] < this.value[cheapest]) cheapest = k;
      if (this.value[cheapest] >= value) return; // the field is already worth more
      this.x[cheapest] = x;
      this.z[cheapest] = z;
      this.kind[cheapest] = kind;
      this.value[cheapest] = value;
      return;
    }
    const i = this.count++;
    this.x[i] = x;
    this.z[i] = z;
    this.kind[i] = kind;
    this.value[i] =
      value ??
      (kind === 1
        ? settings.enemies.elites.gemValue
        : kind === 2
          ? settings.tides.goldRain.value
          : settings.run.gemBase * (1 + settings.run.gemPerMinute * minute));
  }

  /** Tide-end shower: goldRain.count gold gems scattered inside a radius circle. */
  rainAt(x, z, rng) {
    const rain = settings.tides.goldRain;
    for (let n = 0; n < rain.count; n++) {
      const angle = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * rain.radius;
      this.dropAt(x + Math.cos(angle) * r, z + Math.sin(angle) * r, 0, 2);
    }
  }

  /** An elite's dropped element — value carries the element index, not xp. */
  dropShard(x, z, element) {
    this.dropAt(x, z, 0, 3, element);
  }

  xpNeed(level) {
    return settings.run.xpBase * Math.pow(settings.run.xpGrowth, level);
  }

  tick(step, player) {
    let gained = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const dx = player.x - this.x[i];
      const dz = player.z - this.z[i];
      const d = Math.hypot(dx, dz);
      if (d < 0.5) {
        if (this.kind[i] === 3) this.onShard?.(this.value[i] | 0);
        else this.xp += this.value[i] * (this.mods ? this.mods.xpMult() : 1);
        const last = --this.count;
        this.x[i] = this.x[last];
        this.z[i] = this.z[last];
        this.value[i] = this.value[last];
        this.kind[i] = this.kind[last];
        continue;
      }
      const magnet = this.kind[i] === 1 ? settings.run.gemBlueMagnet : settings.run.magnetRadius;
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

  /** Push gem positions and per-kind colour into the Points cloud; call once per rendered frame. */
  sync() {
    for (let i = 0; i < this.count; i++) {
      this._positions[i * 3] = this.x[i];
      this._positions[i * 3 + 1] = 0.25;
      this._positions[i * 3 + 2] = this.z[i];
      const c = KIND_COLOR[this.kind[i]];
      this._colors[i * 3] = c[0];
      this._colors[i * 3 + 1] = c[1];
      this._colors[i * 3 + 2] = c[2];
    }
    this.points.geometry.setDrawRange(0, this.count);
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  clear() {
    this.count = 0;
    this.xp = 0;
    this.level = 0;
  }
}
