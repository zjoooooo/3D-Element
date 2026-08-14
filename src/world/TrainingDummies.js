import {
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3
} from 'three';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { clamp, damp } from '../utils/math.js';

const _world = new Vector3();
const _screen = new Vector3();

/**
 * Straw targets you can hit, and the readouts that say you hit them.
 *
 * The sandbox had nothing in it that could be damaged — six abilities, all of
 * them pure presentation. This is the smallest thing that changes that: a ring
 * of posts with a hit point total each, a sphere test against the ability's
 * footprint, and the two readouts that make a number real (a bar that drops and
 * a figure that floats off).
 *
 * Both readouts are DOM rather than geometry. A health bar is a rectangle that
 * must stay legible at every camera distance and never be occluded, which is
 * exactly what a projected `<div>` is good at and what a sprite in the scene has
 * to fight the renderer to achieve — and it keeps the whole feature in one file
 * instead of adding a texture atlas and a draw call to say "184".
 *
 * The dummies do not move, block, or fight back. That is the point: they are a
 * measuring stick for how far an ability reaches and how hard it lands, which is
 * what a VFX sandbox actually needs from a target.
 */
export class TrainingDummies {
  /**
   * @param {import('./Environment.js').Environment} environment
   * @param {HTMLCanvasElement} canvas the projection is measured against
   */
  constructor(environment, canvas) {
    this.environment = environment;
    this.canvas = canvas;

    this.group = new Group();
    this.group.name = 'TrainingDummies';

    /** One entry per post. Rebuilt when `count` changes. */
    this.dummies = [];
    this._built = -1;
    this._ring = -1;

    // Shared across every post; only the material is per-dummy, because the hit
    // flash is per-dummy.
    this._baseGeometry = new CylinderGeometry(0.42, 0.5, 0.12, 16);
    this._postGeometry = new CylinderGeometry(0.07, 0.09, 1.6, 10);
    this._bodyGeometry = new CapsuleGeometry(0.26, 0.5, 4, 12);
    this._armGeometry = new CylinderGeometry(0.05, 0.05, 1.05, 8);

    this._layer = document.createElement('div');
    this._layer.className = 'dummy-layer';
    document.body.appendChild(this._layer);
  }

  /* ------------------------------------------------------------------ */
  /* Building                                                            */
  /* ------------------------------------------------------------------ */

  /** One post: three primitives, its own material, its own bar. */
  _create(index, count) {
    const c = settings.dummies;
    const angle = (index / count) * Math.PI * 2;

    const root = new Group();
    root.position.set(Math.sin(angle) * c.ringRadius, 0, Math.cos(angle) * c.ringRadius);
    root.rotation.y = angle + Math.PI; // face the middle, where the caster stands

    const material = new MeshStandardMaterial({
      color: 0x8a7458,
      roughness: 0.86,
      metalness: 0,
      emissive: 0xff5a1e,
      emissiveIntensity: 0
    });
    this.environment.registerShadowCaster(material);

    const base = new Mesh(this._baseGeometry, material);
    base.position.y = 0.06;
    const post = new Mesh(this._postGeometry, material);
    post.position.y = 0.8;
    const body = new Mesh(this._bodyGeometry, material);
    body.position.y = 1.24;
    const arms = new Mesh(this._armGeometry, material);
    arms.position.y = 1.36;
    arms.rotation.z = Math.PI / 2;

    for (const mesh of [base, post, body, arms]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER.WORLD);
      mesh.layers.enable(LAYER.CONTACT);
      root.add(mesh);
    }

    const bar = document.createElement('div');
    bar.className = 'dummy-bar';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    this._layer.appendChild(bar);

    this.group.add(root);
    return {
      root,
      material,
      bar,
      fill,
      /** Centre of mass, world space — what a blast is measured to. */
      centre: new Vector3(root.position.x, 1.1, root.position.z),
      /** Where the bar and the numbers sit. */
      head: new Vector3(root.position.x, 2.1, root.position.z),
      radius: 0.45,
      /** Last projected screen position; damage figures spawn from it. */
      sx: 0,
      sy: 0,
      hp: c.hp,
      /** Drives the hit flash and the recoil; decays on its own. */
      flash: 0,
      /** Seconds until it stands back up, 0 while it is alive. */
      down: 0
    };
  }

  /** Match the scene to `count` / `ringRadius`, which are live editor values. */
  _sync() {
    const c = settings.dummies;
    const count = Math.max(0, Math.round(c.count));
    if (count === this._built && c.ringRadius === this._ring) return;

    if (count !== this._built) {
      for (const dummy of this.dummies) this._release(dummy);
      this.dummies.length = 0;
      for (let i = 0; i < count; i++) this.dummies.push(this._create(i, count));
      this._built = count;
    } else {
      // Only the ring changed: move them rather than rebuilding.
      this.dummies.forEach((dummy, index) => {
        const angle = (index / count) * Math.PI * 2;
        dummy.root.position.set(Math.sin(angle) * c.ringRadius, 0, Math.cos(angle) * c.ringRadius);
        dummy.centre.set(dummy.root.position.x, 1.1, dummy.root.position.z);
        dummy.head.set(dummy.root.position.x, 2.1, dummy.root.position.z);
      });
    }
    this._ring = c.ringRadius;
  }

  _release(dummy) {
    this.group.remove(dummy.root);
    dummy.material.dispose();
    dummy.bar.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Taking a hit                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Is anything standing inside this sphere?
   *
   * The overlap test on its own, with no damage and no readouts, because a
   * projectile has to ask it every frame of its flight.
   *
   * @param {Vector3} point
   * @param {number} radius metres
   */
  hits(point, radius) {
    for (const dummy of this.dummies) {
      if (dummy.down > 0) continue;
      if (point.distanceTo(dummy.centre) <= radius + dummy.radius) return true;
    }
    return false;
  }

  /**
   * Damage everything inside a sphere.
   *
   * Falls off linearly to half at the edge, so `radius` is the honest reach of
   * the blast rather than a cliff: clipping a target with the rim of a fireball
   * should not do what landing it on their head does.
   *
   * @param {Vector3} point   centre of the blast, world space
   * @param {number} radius   metres
   * @param {number} amount   damage at the centre
   * @returns {number} how many targets it touched
   */
  damage(point, radius, amount) {
    if (!(radius > 0) || !(amount > 0)) return 0;
    let hits = 0;

    for (const dummy of this.dummies) {
      if (dummy.down > 0) continue;

      // Sphere against sphere: the post is a body, not a point, so its own
      // radius counts toward the reach.
      const distance = point.distanceTo(dummy.centre) - dummy.radius;
      if (distance > radius) continue;

      const falloff = 1 - 0.5 * clamp(distance / radius, 0, 1);
      const dealt = Math.max(1, Math.round(amount * falloff));
      dummy.hp -= dealt;
      dummy.flash = 1;
      hits++;

      this._number(dummy, dealt, falloff);
      if (dummy.hp <= 0) {
        dummy.hp = 0;
        dummy.down = Math.max(0.5, settings.dummies.respawn);
      }
    }

    return hits;
  }

  /** Full health, everything standing. */
  reset() {
    for (const dummy of this.dummies) {
      dummy.hp = settings.dummies.hp;
      dummy.down = 0;
      dummy.flash = 0;
      dummy.root.visible = true;
      dummy.root.rotation.x = 0;
    }
  }

  /**
   * A damage figure thrown off the target it belongs to.
   *
   * Placed from the screen position `update` cached last frame rather than from
   * a fresh projection, and placed *now* rather than on the next update: a hit
   * can land at any point in the frame, and a figure appended without a
   * transform spends its first frame in the top-left corner of the screen before
   * jumping to the target. One frame is enough to see.
   */
  _number(dummy, dealt, falloff) {
    const node = document.createElement('span');
    node.className = falloff > 0.85 ? 'dummy-hit dummy-hit--solid' : 'dummy-hit';
    node.textContent = `${dealt}`;
    node.style.transform = `translate(-50%, -50%) translate(${dummy.sx}px, ${dummy.sy}px)`;
    // Scatter them, or a burst of hits stacks into one illegible figure.
    node.style.setProperty('--drift', `${(Math.random() * 2 - 1) * 26}px`);
    node.addEventListener('animationend', () => node.remove());
    this._layer.appendChild(node);
  }

  /* ------------------------------------------------------------------ */
  /* Per frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt   real seconds — targets stand back up while paused
   * @param {import('three').Camera} camera
   */
  update(dt, camera) {
    this._camera = camera;
    this._sync();

    const c = settings.dummies;
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;

    for (const dummy of this.dummies) {
      /* the hit flash, and the knock the post takes from it */
      if (dummy.flash > 0) {
        dummy.flash = Math.max(0, dummy.flash - dt * 3.4);
        dummy.material.emissiveIntensity = dummy.flash * 1.6;
        dummy.root.rotation.x = damp(dummy.root.rotation.x, 0, 0.0001, dt);
      }

      /* down and getting back up */
      if (dummy.down > 0) {
        dummy.down = Math.max(0, dummy.down - dt);
        // Tip over, lie there, then stand back up on the last half second.
        const rising = dummy.down < 0.5;
        dummy.root.rotation.x = damp(
          dummy.root.rotation.x,
          rising ? 0 : Math.PI * 0.46,
          rising ? 0.00005 : 0.002,
          dt
        );
        if (dummy.down === 0) {
          dummy.hp = c.hp;
          dummy.root.rotation.x = 0;
        }
      }

      /* the bar, and any figures still floating off it */
      _world.copy(dummy.head);
      _screen.copy(_world).project(camera);
      const onScreen =
        _screen.z < 1 && Math.abs(_screen.x) < 1.6 && Math.abs(_screen.y) < 1.6 && c.showBars;
      // Cached whether it is on screen or not: a figure spawned by a hit reads
      // this, and a target killed just off the edge still throws its number
      // toward where it stood rather than into the corner.
      dummy.sx = (_screen.x * 0.5 + 0.5) * width;
      dummy.sy = (-_screen.y * 0.5 + 0.5) * height;

      dummy.bar.style.display = onScreen && dummy.down === 0 ? 'block' : 'none';
      if (onScreen) {
        const left = clamp(dummy.hp / Math.max(1, c.hp), 0, 1);
        dummy.bar.style.transform = `translate(-50%, -50%) translate(${dummy.sx}px, ${dummy.sy}px)`;
        dummy.fill.style.width = `${left * 100}%`;
        dummy.fill.style.background = left > 0.5 ? '#7ee08a' : left > 0.25 ? '#ffc24a' : '#ff5a3c';
      }
    }
  }

  dispose() {
    for (const dummy of this.dummies) this._release(dummy);
    this.dummies.length = 0;
    this._layer.remove();
    this._baseGeometry.dispose();
    this._postGeometry.dispose();
    this._bodyGeometry.dispose();
    this._armGeometry.dispose();
  }
}
