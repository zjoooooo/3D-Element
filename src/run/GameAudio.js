import { settings } from '../config/settings.js';
import { zzfx } from './audio/zzfx.js';

// Per-frame throttle (spec §10 / M5 Task 10): a packed fight can trigger a
// hit/reaction/cast every few milliseconds, and firing zzfx unthrottled
// turns that into noise (and, on some browsers, a dropped-audio-node
// warning). Base 8 plays/frame; a priority>=2 call — the "big moment" class
// (there is no crit system here to rank above it: a sheng reaction, getting
// hit, a level-up, dying, winning) — can push 4 more through, 12 total.
const BASE_LIMIT = 8;
const HARD_LIMIT = 12;

/**
 * The run's sound layer: looks a sound up in `settings.audio.sounds`, scales
 * its authored volume by the right UI slider, optionally jitters pitch, and
 * throttles bursts through `_shouldPlay`. Sandbox never constructs one —
 * every `play()` call site in App.js is already run-mode-gated by its own
 * position (see App.js's notes at each site).
 *
 * The throttle decision (`_shouldPlay`) is a plain counter with no
 * zzfx/AudioContext involvement, precisely so check-game.mjs can pin it
 * headlessly; `play()` itself never calls the real synth directly either —
 * it goes through an injectable `_player` (defaults to the real `zzfx`), so
 * a Node test can hand it a no-op/spy and never touch AudioContext at all.
 */
export class GameAudio {
  constructor(player = zzfx) {
    this._player = player;
    this._count = 0;
  }

  /** Reset the per-frame budget. Call once, at the very top of App.frame(). */
  beginFrame() {
    this._count = 0;
  }

  /**
   * Base 8 plays/frame, any priority; once that's spent, only priority>=2
   * still gets through, and only up to the hard cap of 12. One counter:
   * count<8 always plays, count 8..11 plays only if priority>=2, count>=12
   * always drops. Every allowed call spends one unit of the shared budget,
   * base or overflow alike.
   */
  _shouldPlay(priority) {
    if (this._count >= HARD_LIMIT) return false;
    if (this._count < BASE_LIMIT || priority >= 2) {
      this._count++;
      return true;
    }
    return false;
  }

  /**
   * Play sound `id` from settings.audio.sounds. An unknown id is a silent
   * no-op (a missing table row is a content bug, not a crash). `priority`
   * defaults to the sound's own authored `priority` — so the table stays
   * the single tunable source for "is this a big-moment sound", and a call
   * site only needs to override it for something unusual. `pitchJitter`
   * shakes the frequency param (index 2) by up to ±15%, for e.g. hits
   * landing back to back without every one sounding identical.
   */
  play(id, { priority, pitchJitter = false } = {}) {
    const cfg = settings.audio.sounds[id];
    if (!cfg) return;
    if (!this._shouldPlay(priority ?? cfg.priority ?? 0)) return;

    const volume = cfg.channel === 'ui' ? settings.ui.uiVolume : settings.ui.sfxVolume;
    const params = cfg.params.slice();
    params[0] *= volume;
    if (pitchJitter) params[2] *= 1 + (Math.random() * 2 - 1) * 0.15;
    this._player(...params);
  }
}
