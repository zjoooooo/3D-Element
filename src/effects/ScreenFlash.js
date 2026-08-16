import { Color } from 'three';
import { settings } from '../config/settings.js';
import { damp } from '../utils/math.js';

/**
 * Full-screen colour flash for impacts.
 *
 * Holds nothing but state — the composite pass reads `color` and `strength`
 * every frame, so a flash costs no extra draw call.
 */
export class ScreenFlash {
  constructor() {
    this.color = new Color(1, 1, 1);
    this.strength = 0;
    this._decay = 0.0004;
  }

  /**
   * @param {THREE.Color} color
   * @param {number} strength 0..1
   * @param {number} [decay]  fraction remaining after one second
   */
  trigger(color, strength, decay = 0.0004) {
    // Photosensitivity (M5 Task 9): halves every flash through here, not just
    // the run's red hit-variant — `settings.ui.reduceFlashes`'s own comment
    // says "big flashes damped hard" with no carve-out, and this is the one
    // place every flash in the game already funnels through.
    const reduce = settings.ui.reduceFlashes ? 0.5 : 1;
    const scaled = strength * settings.post.flashStrength * reduce;
    if (scaled <= this.strength) return;
    this.color.copy(color);
    this.strength = Math.min(1, scaled);
    this._decay = decay;
  }

  update(dt) {
    if (this.strength <= 0.0005) {
      this.strength = 0;
      return;
    }
    this.strength = damp(this.strength, 0, this._decay, dt);
  }

  reset() {
    this.strength = 0;
  }
}
