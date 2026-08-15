import { Vector3 } from 'three';

/**
 * Edge arrows for the enemies you cannot see yet.
 *
 * The tide spawns outside the view on purpose (spec §5), which also means the
 * player learns about an approaching pack only when it walks into frame. These
 * arrows sit on the screen edge and point at what is coming: the circle is
 * split into twelve sectors, each showing one arrow for its nearest off-screen
 * enemy, sized and brightened by how close that enemy is. Twelve fixed DOM
 * nodes, no churn.
 */
const SECTORS = 12;
const EDGE = 0.92; // NDC box the arrows sit on
const RANGE = 30; // metres at which an arrow has faded to nothing

const _p = new Vector3();

export class ThreatArrows {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;

    this._layer = document.createElement('div');
    this._layer.className = 'threat-layer';
    document.body.appendChild(this._layer);

    this._arrows = [];
    this._nearest = new Float32Array(SECTORS);
    for (let i = 0; i < SECTORS; i++) {
      const node = document.createElement('i');
      node.className = 'threat-arrow';
      node.style.display = 'none';
      this._layer.appendChild(node);
      this._arrows.push(node);
    }
  }

  /** Point the edge at every off-screen enemy; call once per rendered frame. */
  update(enemies, player) {
    this._nearest.fill(Infinity);

    for (let i = 0; i < enemies.count; i++) {
      _p.set(enemies.x[i], 0.8, enemies.z[i]);
      _p.project(this.camera);
      // On screen (or behind the camera in a way that still lands in frame):
      // the body itself is the indicator.
      if (_p.z < 1 && Math.abs(_p.x) < EDGE && Math.abs(_p.y) < EDGE) continue;

      const distance = Math.hypot(enemies.x[i] - player.x, enemies.z[i] - player.z);
      // Behind-camera projections mirror; recover the true screen heading from
      // the sign of z so the arrow still points the right way.
      const sx = _p.z < 1 ? _p.x : -_p.x;
      const sy = _p.z < 1 ? _p.y : -_p.y;
      const angle = Math.atan2(sy, sx);
      const sector = ((Math.round((angle / (Math.PI * 2)) * SECTORS) % SECTORS) + SECTORS) % SECTORS;
      if (distance < this._nearest[sector]) this._nearest[sector] = distance;
    }

    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    for (let s = 0; s < SECTORS; s++) {
      const node = this._arrows[s];
      const distance = this._nearest[s];
      if (!Number.isFinite(distance)) {
        if (node.style.display !== 'none') node.style.display = 'none';
        continue;
      }
      const angle = (s / SECTORS) * Math.PI * 2;
      // Clamp the direction onto the EDGE box, screen space.
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const t = EDGE / Math.max(Math.abs(dx), Math.abs(dy));
      const px = (dx * t * 0.5 + 0.5) * width;
      const py = (-dy * t * 0.5 + 0.5) * height;
      const near = 1 - Math.min(1, distance / RANGE); // 1 right here … 0 far away
      node.style.display = '';
      node.style.opacity = (0.25 + near * 0.65).toFixed(2);
      node.style.transform =
        `translate(-50%, -50%) translate(${px.toFixed(0)}px, ${py.toFixed(0)}px) ` +
        `rotate(${(-angle).toFixed(3)}rad) scale(${(0.7 + near * 0.6).toFixed(2)})`;
    }
  }

  dispose() {
    this._layer.remove();
  }
}
