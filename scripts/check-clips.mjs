/**
 * Does every character in `CHARACTERS` load, bind its clips, and keep its feet
 * on the floor?
 *
 * The ways an FBX animation fails here are all silent at load: the empty
 * `Take 001` some exports ship gets picked instead of the real stack and the
 * body just stands there; a character downloaded without an animation applied
 * carries a one-frame "clip" and stands in its bind pose forever; tracks left
 * pointing at bones this rig does not have warn once and animate nothing; and
 * the hips channel — the only one authored in absolute centimetres — can plant
 * a clip from another character above or below the ground. So this plays each
 * clip on its own rig and measures where the planted toe actually lands,
 * against that rig's idle as the reference.
 *
 *   npm run check
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { AnimationMixer, LoopRepeat, Vector3 } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { prepareClip, CHARACTERS } from '../src/animation/CharacterController.js';

// Mixamo re-exports can embed the skin, and FBXLoader turns embedded images
// into blob URLs — which needs a `window` this Node script does not have. Only
// the bones are read here, so a no-op object URL stands in.
globalThis.window ??= { URL: { createObjectURL: () => '' } };
globalThis.document ??= {
  createElementNS: () => ({ addEventListener: () => {}, removeEventListener: () => {} })
};

/** How far below the idle's planted foot a clip may put one, in rig units (cm). */
const SINK_TOLERANCE = 2;

const MODELS = new URL('../public/models/', import.meta.url);

const load = (file) => {
  const buffer = readFileSync(new URL(encodeURIComponent(file), MODELS));
  return new FBXLoader().parse(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    ''
  );
};

const scratch = new Vector3();

/** Lowest either toe gets over one pass of `clip`, in the rig's own units. */
function lowestToe(mixer, rig, toes, clip) {
  const action = mixer.clipAction(clip);
  action.setLoop(LoopRepeat, Infinity);
  action.play();

  const step = 1 / 60;
  let lowest = Infinity;
  for (let time = 0; time < clip.duration; time += step) {
    mixer.update(step);
    rig.updateMatrixWorld(true);
    for (const toe of toes) lowest = Math.min(lowest, toe.getWorldPosition(scratch).y);
  }

  action.stop();
  mixer.uncacheClip(clip);
  return lowest;
}

for (const [id, character] of Object.entries(CHARACTERS)) {
  console.log(`\n— ${id} —`);

  const rig = load(character.model);
  const bones = new Set();
  rig.traverse((node) => bones.add(node.name));

  const toes = [];
  rig.traverse((node) => {
    if (/(Left|Right)ToeBase$/.test(node.name)) toes.push(node);
  });
  assert.equal(toes.length, 2, `${character.model}: expected two toe bones to measure the floor against`);

  const mixer = new AnimationMixer(rig);

  const idle = prepareClip('idle', rig, bones);
  assert.ok(idle, `${character.model}: no usable idle clip — an empty take was picked`);
  assert.ok(
    idle.duration > 0.5,
    `${character.model}: idle "clip" is ${idle.duration.toFixed(2)}s — a static pose, not an animation. ` +
      `Re-download the character from Mixamo with an Idle animation applied (With Skin).`
  );

  const floor = lowestToe(mixer, rig, toes, idle);
  console.log(
    `ok  ${character.model.padEnd(28)} ${idle.duration.toFixed(2)}s idle — planted toe at ${floor.toFixed(1)}, the reference the rest are held to`
  );

  for (const [name, file] of Object.entries(character.clips)) {
    const clip = prepareClip(name, load(file), bones);

    assert.ok(clip, `${file}: no usable clip — an empty take was picked`);
    assert.ok(clip.duration > 0.1, `${file}: clip is ${clip.duration}s long`);

    const unbound = clip.tracks.filter((track) => !bones.has(track.name.split('.')[0]));
    assert.equal(unbound.length, 0, `${file}: ${unbound.length} tracks bind to nothing`);

    const toe = lowestToe(mixer, rig, toes, clip);
    assert.ok(
      toe > floor - SINK_TOLERANCE,
      `${file}: planted toe reaches ${toe.toFixed(1)}, ${(floor - toe).toFixed(1)} below the idle's ${floor.toFixed(1)} — the feet go through the floor`
    );

    console.log(
      `ok  ${(name + ' ← ' + file).padEnd(40)} ${clip.duration.toFixed(2)}s  ${String(clip.tracks.length).padStart(2)} tracks` +
        `  planted toe ${toe > floor ? '+' : ''}${(toe - floor).toFixed(1)} vs idle`
    );
  }
}

console.log('\nevery character loads, every clip binds and stands on the floor');
