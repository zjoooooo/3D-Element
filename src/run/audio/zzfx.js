// ZzFX - Zuper Zmall Zound Zynth - Micro Edition
// MIT License - Copyright 2019 Frank Force
// https://github.com/KilledByAPixel/ZzFX
//
// Vendored verbatim from ZzFXMicro.js v1.3.2, with one adaptation for this
// project: upstream's `zzfxX` is a module-scope `new AudioContext` created
// the instant the file loads. Chrome/Safari both log an autoplay-policy
// warning for that (a context must not exist, or must be resumed, before a
// user gesture) — every real call site in this codebase runs behind
// GameAudio, which only ever plays in run mode, so the context is built
// lazily on first use instead, via `audioContext()`. `resumeAudio()` is the
// new export App.js calls from a one-shot `pointerdown` listener to satisfy
// that gesture requirement. `zzfx()`'s own generator math — the actual sound
// — is untouched.
//
// This is a minified build of zzfx for use in size coding projects.
// You can use zzfxV to set volume.

'use strict';

const zzfxV = 0.3; // volume

/** The single AudioContext every zzfx() call plays through, built on first use. */
let _ctx = null;
export function audioContext() {
  return _ctx ?? (_ctx = new AudioContext());
}

/** Resume a suspended context. Call from a user-gesture handler — browsers
 * refuse to run audio before one. Safe to call before any sound has played
 * (it just builds the context) or on an already-running one (no-op). */
export function resumeAudio() {
  const ctx = audioContext();
  if (ctx.state === 'suspended') ctx.resume();
}

// ZzFXMicro - Zuper Zmall Zound Zynth - v1.3.2 by Frank Force
export function zzfx(
  volume = 1,
  randomness = 0.05,
  frequency = 220,
  attack = 0,
  sustain = 0,
  release = 0.1,
  shape = 0,
  shapeCurve = 1,
  slide = 0,
  deltaSlide = 0,
  pitchJump = 0,
  pitchJumpTime = 0,
  repeatTime = 0,
  noise = 0,
  modulation = 0,
  bitCrush = 0,
  delay = 0,
  sustainVolume = 1,
  decay = 0,
  tremolo = 0,
  filter = 0
) {
  // init parameters
  const sampleRate = 44100;
  const zzfxX = audioContext();
  let PI2 = Math.PI * 2,
    abs = Math.abs,
    sign = (v) => (v < 0 ? -1 : 1),
    startSlide = (slide *= (500 * PI2) / sampleRate / sampleRate),
    startFrequency = (frequency *= (1 + randomness * 2 * Math.random() - randomness) * PI2 / sampleRate),
    modOffset = 0, // modulation offset
    repeat = 0, // repeat offset
    crush = 0, // bit crush offset
    jump = 1, // pitch jump timer
    length, // sample length
    b = [], // sample buffer
    t = 0, // sample time
    i = 0, // sample index
    s = 0, // sample value
    f, // wave frequency
    // source and buffer
    source = zzfxX.createBufferSource(),
    buffer,
    // biquad LP/HP filter
    quality = 2,
    w = (PI2 * abs(filter) * 2) / sampleRate,
    cos = Math.cos(w),
    alpha = Math.sin(w) / 2 / quality,
    a0 = 1 + alpha,
    a1 = (-2 * cos) / a0,
    a2 = (1 - alpha) / a0,
    b0 = (1 + sign(filter) * cos) / 2 / a0,
    b1 = -(sign(filter) + cos) / a0,
    b2 = b0,
    x2 = 0,
    x1 = 0,
    y2 = 0,
    y1 = 0;

  // scale by sample rate
  const minAttack = 9; // prevent pop if attack is 0
  attack = attack * sampleRate || minAttack;
  decay *= sampleRate;
  sustain *= sampleRate;
  release *= sampleRate;
  delay *= sampleRate;
  deltaSlide *= (500 * PI2) / sampleRate ** 3;
  modulation *= PI2 / sampleRate;
  pitchJump *= PI2 / sampleRate;
  pitchJumpTime *= sampleRate;
  repeatTime = (repeatTime * sampleRate) | 0;
  volume *= zzfxV;

  // generate waveform
  for (length = (attack + decay + sustain + release + delay) | 0; i < length; b[i++] = s * volume) {
    if (!(++crush % (bitCrush * 100 | 0))) {
      // bit crush
      s = shape
        ? shape > 1
          ? shape > 2
            ? shape > 3
              ? shape > 4
                ? ((t / PI2) % 1 < shapeCurve / 2) * 2 - 1 // 5 square duty
                : Math.sin(t ** 3) // 4 noise
              : Math.max(Math.min(Math.tan(t), 1), -1) // 3 tan
            : 1 - (((2 * t) / PI2) % 2 + 2) % 2 // 2 saw
          : 1 - 4 * abs(Math.round(t / PI2) - t / PI2) // 1 triangle
        : Math.sin(t); // 0 sin

      s =
        (repeatTime ? 1 - tremolo + tremolo * Math.sin((PI2 * i) / repeatTime) /* tremolo */ : 1) *
        (shape > 4 ? s : sign(s) * abs(s) ** shapeCurve) * // shape curve
        (i < attack
          ? i / attack // attack
          : i < attack + decay
          ? 1 - ((i - attack) / decay) * (1 - sustainVolume) // decay falloff
          : i < attack + decay + sustain
          ? sustainVolume // sustain volume
          : i < length - delay
          ? ((length - i - delay) / release) * sustainVolume // release falloff
          : 0); // post release

      s = delay
        ? s / 2 +
          (delay > i ? 0 : (i < length - delay ? 1 : (length - i) / delay) * (b[(i - delay) | 0] / 2 / volume)) // sample delay
        : s;

      if (filter) s = y1 = b2 * x2 + b1 * (x2 = x1) + b0 * (x1 = s) - a2 * y2 - a1 * (y2 = y1); // apply filter
    }

    f = (frequency += slide += deltaSlide) * Math.cos(modulation * modOffset++); // frequency + modulation
    t += f + f * noise * Math.sin(i ** 5); // noise

    if (jump && ++jump > pitchJumpTime) {
      // pitch jump
      frequency += pitchJump;
      startFrequency += pitchJump;
      jump = 0;
    }

    if (repeatTime && !(++repeat % repeatTime)) {
      // repeat
      frequency = startFrequency;
      slide = startSlide;
      jump ||= 1;
    }
  }

  // copy samples to buffer and play
  buffer = zzfxX.createBuffer(1, b.length, sampleRate);
  buffer.getChannelData(0).set(b);
  source.buffer = buffer;
  source.connect(zzfxX.destination);
  source.start();
  return source;
}
