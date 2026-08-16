import { Color } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Pure componentwise lerp between two settings colour hexes. `t` is clamped
 * to [0,1]. Exported standalone (no instance state, no THREE.Color aliasing)
 * so it can be asserted directly: halfway is the componentwise midpoint of
 * the two colours' resolved channels, and a from===to pair is the identity
 * at any `t` — the two properties that matter for a tide cross-fade.
 */
export function mixTint(fromHex, toHex, t) {
  const a = getColor(fromHex);
  const b = getColor(toHex);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
}

/**
 * Tints the run's scene toward the current tide's weather over a
 * `settings.tides.blendSeconds` cross-fade.
 *
 * Never writes settings.environment (sandbox-pollution red line). This is a
 * correction layer in the same shape as Modifiers: it reads Environment's
 * *already-updated* runtime colours each frame — App calls this strictly
 * after `environment.update()` — and multiplies its own live-blended tint on
 * top, in place. Next frame, `environment.update()` re-derives every colour
 * straight from settings again before this ever touches them, so a sandbox
 * session (which never constructs this class) is byte-identical to before
 * Task 8, and even a run that never turns a tide leaves every value at
 * exactly ×1 (mixTint(x, x, t) === x) until the first turn actually happens.
 *
 * Rim is deliberately left untouched: Environment's own docstring calls it a
 * fixed silhouette-separation light, not part of the scene's mood, and
 * tinting it would fight the one job it has.
 *
 * DustMotes gets the same treatment through its own `setPreset()` — tint
 * multiplies the particle colour, drift adds a wind vector, both
 * parameterising the existing shader rather than replacing it. The dust
 * drift snaps to the new tide's vector immediately on a turn (unlike the
 * colours, which glide) — a wind shift reads fine as a hard cut, and
 * blending a direction vector smoothly is machinery nobody asked for here.
 */
export class TideAtmosphere {
  /**
   * @param {import('../world/Environment.js').Environment} environment
   * @param {import('../world/DustMotes.js').DustMotes} dust
   */
  constructor(environment, dust) {
    this.environment = environment;
    this.dust = dust;

    this._element = -1; // forces the first update() call to snap, not glide
    this._blend = 1;
    this._fromPreset = null;
    this._toPreset = null;

    // Scratch Colors, mutated every frame — never reallocated.
    this._light = new Color(1, 1, 1);
    this._fog = new Color(1, 1, 1);
    this._dust = new Color(1, 1, 1);
  }

  /**
   * @param {number} dt - frozen-aware delta (0 during a level-up hand, same
   *   as the rest of App's VFX layer) — the blend simply holds still with it.
   * @param {{index:number, element:number}} tideInfo - RunManager.tide()'s
   *   reused scratch object; only `.element` is read this call.
   */
  update(dt, tideInfo) {
    const table = settings.tides.atmosphere;

    if (tideInfo.element !== this._element) {
      // The target element changed — keyed off `.element`, not `.index`:
      // RunManager.start() (every restart, not just the first) reshuffles
      // the tide order and resets both `elapsed` and its tide index to 0, so
      // a death-and-restart while still in tide 0 can leave a *different*
      // element sitting at the same index. Comparing the element is correct
      // in both that case and the ordinary 180s tide turn.
      //
      // "From" becomes whatever "to" already was. On the very first call
      // both are the same fresh preset, so blend starts at 1 — nothing to
      // glide from yet.
      this._fromPreset = this._toPreset ?? table[tideInfo.element];
      this._toPreset = table[tideInfo.element];
      this._blend = this._element === -1 ? 1 : 0;
      this._element = tideInfo.element;
    }

    this._blend = Math.min(1, this._blend + dt / settings.tides.blendSeconds);

    const light = mixTint(this._fromPreset.lightTint, this._toPreset.lightTint, this._blend);
    const fog = mixTint(this._fromPreset.fogTint, this._toPreset.fogTint, this._blend);
    const dust = mixTint(this._fromPreset.dustTint, this._toPreset.dustTint, this._blend);
    this._light.setRGB(light.r, light.g, light.b);
    this._fog.setRGB(fog.r, fog.g, fog.b);
    this._dust.setRGB(dust.r, dust.g, dust.b);

    // Multiply onto Environment's post-update() runtime values.
    const env = this.environment;
    env.sun.color.multiply(this._light);
    env.hemi.color.multiply(this._light);
    env.ambient.color.multiply(this._light);
    env._fog.color.multiply(this._fog);
    // The backdrop is authored to equal fogColor exactly (Environment's own
    // comment: "a fog whose colour matches the flat backdrop") — tint it with
    // the same fog colour or the far horizon grows a visible seam.
    env._bgColor.multiply(this._fog);

    this.dust.setPreset({ tint: this._dust, drift: this._toPreset.dustDrift, density: 1 });
  }
}
