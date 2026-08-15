import { Vector3 } from 'three';

/**
 * Pooled damage figures for the horde (spec §5.5's third readout, pulled
 * forward from M3 — without a number, a two-hit kill reads as "no damage").
 *
 * Reuses the dummies' `.dummy-hit` look wholesale so every figure in the game
 * floats the same way. The difference is discipline: a sweep can clip thirty
 * enemies in one tick, so the spans are a fixed pool — a hit past the pool
 * recycles the oldest figure instead of growing the DOM.
 * ponytail: oldest-steal under overflow; the spec's "×12" aggregation replaces
 * it in M3 if heavy casts read as churn.
 */
const POOL = 24;

const _world = new Vector3();

export class DamageNumbers {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;

    this._layer = document.createElement('div');
    this._layer.className = 'dummy-layer';
    document.body.appendChild(this._layer);

    this._pool = [];
    this._next = 0;
    for (let i = 0; i < POOL; i++) {
      const node = document.createElement('span');
      node.style.display = 'none';
      this._layer.appendChild(node);
      this._pool.push(node);
    }
  }

  /** Throw a figure off a world position. Projects now — hits land mid-frame. */
  spawn(x, z, amount) {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    _world.set(x, 1.5, z);
    _world.project(this.camera);
    if (_world.z >= 1 || Math.abs(_world.x) > 1.2 || Math.abs(_world.y) > 1.2) return;
    const sx = (_world.x * 0.5 + 0.5) * width;
    const sy = (-_world.y * 0.5 + 0.5) * height;

    const node = this._pool[this._next];
    this._next = (this._next + 1) % POOL;

    // Rewind the pooled node's animation: strip the class, force a reflow,
    // then dress it again — the cheap idiom for "play it from the top".
    node.className = '';
    node.style.display = 'none';
    void node.offsetWidth;
    node.textContent = `${Math.max(1, Math.round(amount))}`;
    node.style.display = '';
    node.style.transform = `translate(-50%, -50%) translate(${sx}px, ${sy}px)`;
    node.style.setProperty('--drift', `${(Math.random() * 2 - 1) * 26}px`);
    node.className = 'dummy-hit';
  }

  dispose() {
    this._layer.remove();
  }
}
