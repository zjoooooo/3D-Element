import { Group, Mesh, PlaneGeometry, ShaderMaterial, MathUtils } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { damp, lerp, clamp } from '../utils/math.js';
import { getColor } from '../utils/color.js';

/* ---- tunables — source-only, no settings.js/editor entry: nothing here is
   meant to be live-tuned mid-run, only re-balanced by hand ---- */
const ASPECT = 0.58; // bottle silhouette, width : height
const TARGET_HEIGHT_PX = 90; // spec §9: ~90px visual height
const MARGIN_BOTTOM_PX = 26; // matches .hud__abilities { bottom: 26px } — same shelf
const MARGIN_SIDE_PX = 30;
const DEPTH = 2; // local -Z the quads sit at, camera space

const LOW_HP_RATIO = 0.3;
const HEART_RATE_MIN = 1.1; // Hz, right at the 30% threshold
const HEART_RATE_MAX = 2.6; // Hz, at 0 hp — panicked
const MANA_DIM_RATIO = 0.3; // spec: dims below 30% (no consumer yet)

const SLOSH_DECAY = 0.02; // damp() rate: fraction of the impulse left after 1s
const SLOSH_BUMP = 0.85;
const SLOSH_MAX = 1.5;

const HP_LIQUID = '#d81f2d';
const MANA_LIQUID = '#2f95e6';

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * One shader for both bottles — a flat quad SDF, not a lit volume, so there
 * is no real normal to bounce a view vector off. The "fresnel" and
 * "refraction" the brief asks for are both faked off the same signed distance
 * that draws the silhouette: brightest right at the glass edge (rim), tinted
 * toward the liquid colour with depth into the shape (glassTint).
 */
const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uRatio;     // fill level, 0..1
  uniform float uSlosh;     // damage impulse, decays to 0
  uniform float uHeartbeat; // HP only: lub-dub envelope × amplitude, App-computed
  uniform float uDim;       // mana only: 1 when the pool is low
  uniform float uRise;      // 1 the frame the level is climbing (heal / regen)
  uniform vec3  uLiquidColor;
  uniform float uOpacity;

  varying vec2 vUv;

  ${noiseGLSL}

  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  float opSmoothUnion(float d1, float d2, float k) {
    float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
    return mix(d2, d1, h) - k * h * (1.0 - h);
  }

  void main() {
    // vUv -> bottle space: x across the silhouette's own aspect, y 0 (base) .. 1 (rim).
    vec2 p = vec2((vUv.x - 0.5) * ${ASPECT.toFixed(3)}, vUv.y);

    /* ---- silhouette: round body + short neck, unioned smoothly ---- */
    float body = sdRoundBox(p - vec2(0.0, 0.30), vec2(0.155, 0.20), 0.12);
    float neck = sdRoundBox(p - vec2(0.0, 0.62), vec2(0.05, 0.09), 0.03);
    float d = opSmoothUnion(body, neck, 0.04);

    float aa = fwidth(d) + 0.0015;
    float inside = 1.0 - smoothstep(-aa, aa, d);

    /* ---- liquid surface: fill ratio + idle wobble + damage slosh ---- */
    float bodyBottom = 0.12;
    float fillTop = 0.66; // a "full" bottle laps partway up the neck
    float wobble = sin(p.x * 15.0 + uTime * 2.0) * 0.006
                 + snoise(vec3(p.x * 2.2, uTime * 0.45, 4.0)) * 0.006;
    float slosh = sin(p.x * 6.0 - uTime * 6.5) * uSlosh * 0.045;
    float liquidTop = mix(bodyBottom, fillTop, clamp(uRatio, 0.0, 1.0)) + wobble + slosh;

    float edge = fwidth(p.y) + 0.0025;
    // Clipped to the glass interior — this is also what narrows the liquid
    // for free as it rises past the shoulder into the neck.
    float liquidMask = (1.0 - smoothstep(liquidTop - edge, liquidTop + edge, p.y)) * step(d, 0.0);

    // A thin brighter band riding the surface while the level is climbing
    // (heal / mana regen). App only feeds a positive uRise on a rising frame.
    float band = (1.0 - smoothstep(0.0, 0.03, abs(p.y - liquidTop))) * clamp(uRise, 0.0, 1.0) * liquidMask;

    /* ---- a few rising bubbles, procedural (no texture, no instancing) ---- */
    float bubbles = 0.0;
    for (int i = 0; i < 5; i++) {
      float seed = float(i) * 17.7 + 3.1;
      float speed = 0.10 + hash11(seed) * 0.12;
      float lane = mix(-0.10, 0.10, hash11(seed + 1.0));
      float phase = fract(uTime * speed + hash11(seed + 2.0));
      float by = mix(bodyBottom + 0.02, liquidTop - 0.03, phase);
      float radius = mix(0.006, 0.013, hash11(seed + 3.0));
      bubbles += 1.0 - smoothstep(radius * 0.5, radius, length(p - vec2(lane, by)));
    }
    bubbles = clamp(bubbles, 0.0, 1.0) * liquidMask;

    /* ---- glass: faint body wash + an edge rim standing in for fresnel ---- */
    float rim = 1.0 - smoothstep(0.0, 0.05, abs(d));
    vec3 glassTint = mix(vec3(1.0), uLiquidColor, 0.22);
    vec3 glass = glassTint * (0.05 + rim * 0.55) * inside;

    // HP-only: the rim flushes on a lub-dub double pulse when hp is low. App
    // already folds the envelope shape, the current rate and the
    // reduceFlashes damping into this one scalar — the shader just trusts it.
    glass += vec3(1.0, 0.16, 0.12) * rim * uHeartbeat * 1.6;

    /* ---- liquid body colour ---- */
    float dimAmt = clamp(uDim, 0.0, 1.0);
    vec3 liquid = uLiquidColor * mix(1.0, 0.4, dimAmt);
    liquid += bubbles * 0.55;
    liquid += band * 0.5;

    vec3 color = glass + liquid * liquidMask;
    float alpha = clamp(
      inside * mix(0.24, 0.15, dimAmt) + liquidMask * mix(0.88, 0.55, dimAmt) + rim * inside * 0.5,
      0.0, 1.0
    ) * uOpacity;

    if (alpha < 0.003) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** Two narrow pulses per cycle (lub, then a softer dub) then a long rest —
 * one scalar a frame, so this runs here rather than per-pixel in the shader. */
function heartbeatEnvelope(phase) {
  const t = phase - Math.floor(phase);
  const lub = Math.exp(-(((t - 0.06) * 16) ** 2));
  const dub = Math.exp(-(((t - 0.22) * 20) ** 2)) * 0.6;
  return Math.min(1, lub + dub);
}

/**
 * The HP/mana glass bottles (spec §9 血蓝玻璃瓶) — two quads parented straight
 * to the camera instead of positioned in world space. A mesh whose parent is
 * the camera sits in the camera's own local space, so `position.z = -DEPTH`
 * plants it DEPTH units in front of the lens every frame for free, with no
 * per-frame billboard math. The one thing that trick needs which this rig
 * never had before is a seat *in* the scene graph: three only walks a
 * camera's children if the camera itself is reachable from `scene`, so App
 * adds `this.camera` to the scene once, alongside these (App.js, run mode
 * only — the sandbox never touches either).
 *
 * One shader, two instances — only the uniform values differ: which liquid
 * colour, and which of `uHeartbeat` (HP's low-hp warning) / `uDim` (mana's
 * low-pool dim) actually ever climbs above 0.
 */
export class OrbBottles {
  constructor(canvas) {
    this.canvas = canvas;
    this.group = new Group();
    this.group.name = 'OrbBottles';

    this._geometry = new PlaneGeometry(1, 1);
    this.hp = this._buildBottle(HP_LIQUID);
    this.mana = this._buildBottle(MANA_LIQUID);
    this.group.add(this.hp.mesh, this.mana.mesh);

    this._heartPhase = 0;
    this._heartAmp = 0;
    this._sloshValue = 0;
    this._prevHpRatio = 1;
    this._prevManaRatio = 1;
  }

  _buildBottle(liquidHex) {
    const material = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: sharedUniforms({
        uRatio: { value: 1 },
        uSlosh: { value: 0 },
        uHeartbeat: { value: 0 },
        uDim: { value: 0 },
        uRise: { value: 0 },
        uLiquidColor: { value: getColor(liquidHex).clone() },
        uOpacity: { value: 1 }
      }),
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT
    });
    const mesh = new Mesh(this._geometry, material);
    mesh.name = liquidHex === HP_LIQUID ? 'OrbBottle-hp' : 'OrbBottle-mana';
    mesh.layers.set(LAYER.VFX);
    mesh.renderOrder = 100; // topmost — screen-space chrome over every world VFX
    mesh.frustumCulled = false;
    mesh.position.z = -DEPTH;
    return { mesh, material };
  }

  get object3D() {
    return this.group;
  }

  /** A hit landed — kick the liquid. App calls this from its own hp-drop check. */
  pulseSlosh(amount = SLOSH_BUMP) {
    this._sloshValue = Math.min(SLOSH_MAX, this._sloshValue + amount);
  }

  /**
   * Per-frame feed. `dt` is real time, like the camera/aim this sits in front
   * of, so the idle wobble and the heartbeat keep breathing through a frozen
   * level-up hand instead of seizing mid-cycle.
   */
  update(dt, camera, hp, maxHp, mana, maxMana) {
    this._layout(camera);

    const hpRatio = maxHp > 0 ? clamp(hp / maxHp, 0, 1) : 0;
    const manaRatio = maxMana > 0 ? clamp(mana / maxMana, 0, 1) : 0;

    this._sloshValue = damp(this._sloshValue, 0, SLOSH_DECAY, dt);

    /* ---- HP: lub-dub heartbeat under the threshold, faster as it drops ---- */
    const lowHp = hp > 0 && hpRatio < LOW_HP_RATIO;
    const rateHz = lowHp ? lerp(HEART_RATE_MAX, HEART_RATE_MIN, hpRatio / LOW_HP_RATIO) : 0;
    // Always integrated, never reset — a rate change turns the beat faster or
    // slower, it never skips or rewinds it.
    this._heartPhase += rateHz * dt;
    const ampTarget = lowHp ? (settings.ui.reduceFlashes ? settings.ui.flashDamp : 1) : 0;
    this._heartAmp = damp(this._heartAmp, ampTarget, 0.05, dt);

    this._feed(this.hp, hpRatio, this._prevHpRatio);
    this.hp.material.uniforms.uSlosh.value = this._sloshValue;
    this.hp.material.uniforms.uHeartbeat.value = heartbeatEnvelope(this._heartPhase) * this._heartAmp;
    this._prevHpRatio = hpRatio;

    /* ---- mana: dims below the same 30% line (spec: no consumer yet) ---- */
    this._feed(this.mana, manaRatio, this._prevManaRatio);
    this.mana.material.uniforms.uDim.value = manaRatio < MANA_DIM_RATIO ? 1 : 0;
    this._prevManaRatio = manaRatio;
  }

  /** Uniforms both bottles drive the same way: fill ratio, rise band, opacity. */
  _feed(bottle, ratio, prevRatio) {
    const u = bottle.material.uniforms;
    u.uRatio.value = ratio;
    u.uRise.value = ratio > prevRatio + 1e-4 ? 1 : 0;
    u.uOpacity.value = settings.global.opacity;
  }

  /**
   * Re-derive scale and corner position every frame from the camera's own
   * fov/aspect and the canvas's CSS pixel height, rather than caching it on
   * resize — a handful of scalars, no allocation, and it keeps the ~90px
   * target true even if `settings.camera.fov` itself is ever tuned live.
   */
  _layout(camera) {
    const heightPx = this.canvas.clientHeight || window.innerHeight || 1;
    const vFov = MathUtils.degToRad(camera.fov);
    const viewH = 2 * DEPTH * Math.tan(vFov / 2);
    const viewW = viewH * camera.aspect;
    const worldPerPixel = viewH / heightPx;

    const bottleH = TARGET_HEIGHT_PX * worldPerPixel;
    const bottleW = bottleH * ASPECT;
    const marginX = MARGIN_SIDE_PX * worldPerPixel;
    const marginY = MARGIN_BOTTOM_PX * worldPerPixel;

    const centerY = -viewH / 2 + marginY + bottleH / 2;
    const leftX = -viewW / 2 + marginX + bottleW / 2;
    const rightX = viewW / 2 - marginX - bottleW / 2;

    this.hp.mesh.position.set(leftX, centerY, -DEPTH);
    this.hp.mesh.scale.set(bottleW, bottleH, 1);
    this.mana.mesh.position.set(rightX, centerY, -DEPTH);
    this.mana.mesh.scale.set(bottleW, bottleH, 1);
  }

  dispose() {
    this._geometry.dispose();
    this.hp.material.dispose();
    this.mana.material.dispose();
  }
}
