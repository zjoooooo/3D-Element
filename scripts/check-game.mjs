/**
 * Game-logic checks: pure Node, no renderer. Mirrors the check-clips pattern —
 * every silent way the run mode can rot gets one loud assert here.
 *
 *   npm run check:game
 */
import assert from 'node:assert/strict';

import { createRng } from '../src/run/rng.js';

/* ---- rng: same seed, same stream ---- */
{
  const a = createRng(42);
  const b = createRng(42);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  assert.deepEqual(seqA, seqB, 'rng: identical seeds must replay identically');
  assert.ok(seqA.every((v) => v >= 0 && v < 1), 'rng: values in [0,1)');
  assert.notDeepEqual(
    seqA,
    Array.from({ length: 5 }, createRng(43)),
    'rng: different seeds diverge'
  );
  console.log('ok  rng');
}

console.log('\nevery game-logic check passed');
