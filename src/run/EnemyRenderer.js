import {
  CapsuleGeometry, Color, DynamicDrawUsage, InstancedBufferAttribute,
  InstancedMesh, MeshStandardMaterial, Object3D, RingGeometry, MeshBasicMaterial
} from 'three';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';

/**
 * The horde's appearance: one InstancedMesh, colour per element, hit-flash via
 * instance colour, positions interpolated between the last two fixed ticks so
 * a 144Hz display never sees the 60Hz simulation stutter.
 *
 * Spawn telegraphs are a small pool of flat red rings (spec: threats are red,
 * nothing spawns in your face unannounced). Grey-box bodies for M1 — the five
 * per-element silhouettes arrive with the tides in M3.
 */
export const ELEMENT_TINTS = [0xd8b46a, 0x74d7a8, 0x6fb8e8, 0xe86f4f, 0xb58f5e]; // 金木水火土
const TELEGRAPH_POOL = 24;

export class EnemyRenderer {
  constructor(scene) {
    const cap = settings.run.enemyCap;
    const geometry = new CapsuleGeometry(0.35, 0.6, 3, 8);
    geometry.translate(0, 0.65, 0);
    // A smoulder under the tint: the arena is night-dark and a matte capsule
    // simply vanishes into the floor. Threats read warm (spec §5.7's brightness
    // hierarchy, grey-box edition) — instance colours only multiply the diffuse,
    // so the emissive stays uniform across elements.
    const material = new MeshStandardMaterial({
      roughness: 0.8,
      metalness: 0.05,
      emissive: 0x94261a,
      emissiveIntensity: 0.5
    });

    this.mesh = new InstancedMesh(geometry, material, cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Minted eagerly so the colour buffer carries the dynamic hint too —
    // setColorAt would otherwise lazily create it with the static default.
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = false; // spec §5.7: enemies never enter the shadow map
    this.mesh.layers.set(LAYER.WORLD);
    scene.add(this.mesh);

    this._proxy = new Object3D();
    this._color = new Color();
    this._white = new Color(1, 1, 1);

    this.telegraphs = new InstancedMesh(
      new RingGeometry(0.5, 0.72, 24).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: 0xff4433, transparent: true, opacity: 0.7, depthWrite: false }),
      TELEGRAPH_POOL
    );
    this.telegraphs.instanceMatrix.setUsage(DynamicDrawUsage);
    this.telegraphs.count = 0;
    this.telegraphs.layers.set(LAYER.VFX);
    scene.add(this.telegraphs);
    // The arena's edge (roam clamp stops the runner here) used to be a plain
    // rim ring baked here at construction — replaced by the real 法阵 arena
    // (Arena.js's boundary arc + steles), M5 Task 7.
  }

  /** Draw pending spawn rings; `t` runs 0→1 and scales the ring up. */
  syncTelegraphs(list) {
    const n = Math.min(list.length, TELEGRAPH_POOL);
    for (let k = 0; k < n; k++) {
      const { x, z, t } = list[k];
      this._proxy.position.set(x, 0.02, z);
      const s = 0.6 + t * 0.8;
      this._proxy.scale.set(s, 1, s);
      this._proxy.rotation.set(0, 0, 0);
      this._proxy.updateMatrix();
      this.telegraphs.setMatrixAt(k, this._proxy.matrix);
    }
    this.telegraphs.count = n;
    this.telegraphs.instanceMatrix.needsUpdate = true;
  }

  render(enemies, alpha) {
    const n = enemies.count;
    for (let i = 0; i < n; i++) {
      const x = enemies.prevX[i] + (enemies.x[i] - enemies.prevX[i]) * alpha;
      const z = enemies.prevZ[i] + (enemies.z[i] - enemies.prevZ[i]) * alpha;
      // Hit reaction: flash whitens the tint and pops the scale (spec §5.5).
      const pop = 1 + enemies.flash[i] * 0.15;
      const scale = pop * (enemies.elite[i] ? settings.enemies.elites.scale : 1);
      this._proxy.position.set(x, 0, z);
      this._proxy.scale.set(scale, scale, scale);
      this._proxy.updateMatrix();
      this.mesh.setMatrixAt(i, this._proxy.matrix);

      this._color.setHex(ELEMENT_TINTS[enemies.element[i]]);
      // Elite: brighten toward white first, then the hit flash lerps again on top.
      if (enemies.elite[i]) this._color.lerp(this._white, 0.35);
      this._color.lerp(this._white, enemies.flash[i]);
      this.mesh.setColorAt(i, this._color);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
    this.telegraphs.geometry.dispose();
    this.telegraphs.material.dispose();
    this.telegraphs.parent?.remove(this.telegraphs);
  }
}
