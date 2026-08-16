import {
  Group,
  Mesh,
  MeshStandardMaterial,
  MeshBasicMaterial,
  RingGeometry,
  AdditiveBlending
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { ELEMENT_TINTS } from './EnemyRenderer.js';

const WUXING_COUNT = 5;
const TAU = Math.PI * 2;
/**
 * Baseline emissiveIntensity for a stele that is neither the current nor the
 * next tide. Not a settings field — steleGlowAt's three bands are
 * current/next/idle, and only the first two (steleGlow/preheatGlow) are
 * tunable via settings.arena; this is Arena's own implementation constant.
 */
export const DIM_GLOW = 0.15;
const BREATH_SPEED = 2.4; // rad/s the next tide's stele breathes at

/**
 * Bearing (compass-style, 0 = +Z, matches TrainingDummies' ring placement)
 * of stele/rune `i`. Ground's ritual-circle shader places its rune discs
 * with this identical formula so they sit directly under their steles.
 */
function bearingOf(i) {
  return (i / WUXING_COUNT) * TAU;
}

/**
 * A wuxing's stele emissiveIntensity for a given tide and clock reading.
 * Pure — no three.js, no instance state — so check-game.mjs can pin the
 * three bands (current/next/idle) without constructing an Arena.
 */
export function steleGlowAt(wuxing, tideInfo, time) {
  const c = settings.arena;
  if (wuxing === tideInfo.element) return c.steleGlow;
  if (wuxing === tideInfo.nextElement) {
    const breathe = 0.5 + 0.5 * Math.sin(time * BREATH_SPEED);
    return DIM_GLOW + (c.preheatGlow - DIM_GLOW) * breathe;
  }
  return DIM_GLOW;
}

/**
 * One stele: a tall central crystal flanked by two shorter ones, merged into
 * a single BufferGeometry — five steles then cost five draw calls, not
 * fifteen (checklist: draw-call delta must stay ≤ +8).
 */
function buildSteleGeometry(seed, height) {
  const spine = createCrystalGeometry({ seed, sides: 6, taper: 0.2, roughness: 0.12, bend: 0.08 });
  spine.scale(0.85, height, 0.85);

  const parts = [spine];
  const flankAngles = [1.0, -1.15];
  for (let k = 0; k < flankAngles.length; k++) {
    const flank = createCrystalGeometry({
      seed: seed * 3.1 + k * 11.7,
      sides: 5,
      taper: 0.16,
      roughness: 0.32,
      bend: 0.18
    });
    const flankHeight = height * (0.42 + 0.1 * k);
    flank.scale(0.4, flankHeight, 0.4);
    flank.translate(Math.cos(flankAngles[k]) * 0.5, 0, Math.sin(flankAngles[k]) * 0.5);
    parts.push(flank);
  }

  const geometry = mergeGeometries(parts);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The five-wuxing ritual arena (spec 五行法阵, M5 Task 7): five procedural
 * crystal steles standing on the arena ring, tinted per element, plus the
 * boundary arc connecting them. Run mode only — App constructs and disposes
 * this alongside EnemyRenderer, whose M1 placeholder ring this replaces.
 *
 * `update()` is the only thing that changes frame to frame: which stele is
 * lit follows the tide, everything else here is built once.
 */
export class Arena {
  constructor(scene) {
    const c = settings.arena;
    const radius = settings.run.arenaRadius;

    this.group = new Group();
    this.group.name = 'Arena';

    this.steles = [];
    for (let i = 0; i < WUXING_COUNT; i++) {
      const geometry = buildSteleGeometry(i * 7.3 + 1, c.steleHeight);
      const material = new MeshStandardMaterial({
        color: ELEMENT_TINTS[i],
        roughness: 0.35,
        metalness: 0.15,
        emissive: ELEMENT_TINTS[i],
        emissiveIntensity: DIM_GLOW
      });
      const mesh = new Mesh(geometry, material);
      const bearing = bearingOf(i);
      mesh.position.set(Math.sin(bearing) * radius, 0, Math.cos(bearing) * radius);
      mesh.rotation.y = bearing;
      // Receives shadows but doesn't cast them — EnemyRenderer's enemies
      // skip the shadow map for the same reason (spec §5.7): it's what
      // keeps five extra static meshes inside the draw-call budget.
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.layers.set(LAYER.WORLD);
      this.group.add(mesh);
      this.steles.push(mesh);
    }

    // The boundary arc: one ring at the arena radius, connecting the five
    // steles — replaces EnemyRenderer's M1 placeholder rim (same radius).
    this.arc = new Mesh(
      new RingGeometry(radius - 0.12, radius + 0.12, 128).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({
        color: 0x8fd8ff,
        transparent: true,
        opacity: c.arcOpacity,
        depthWrite: false,
        blending: AdditiveBlending
      })
    );
    this.arc.position.y = 0.04;
    this.arc.layers.set(LAYER.VFX);
    this.group.add(this.arc);

    scene.add(this.group);
  }

  /** Per-frame: light the current tide's stele, breathe the next one, dim the rest. */
  update(tideInfo, time) {
    for (let i = 0; i < WUXING_COUNT; i++) {
      this.steles[i].material.emissiveIntensity = steleGlowAt(i, tideInfo, time);
    }
  }

  dispose() {
    for (const mesh of this.steles) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.arc.geometry.dispose();
    this.arc.material.dispose();
    this.group.parent?.remove(this.group);
  }
}
