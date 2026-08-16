/**
 * Performance mode's write/restore pair (spec §9.5 性能模式开关): halves four
 * of `settings.global`'s multipliers when switched on, restores their exact
 * pre-halve values when switched off. Takes the multiplier object as a
 * parameter rather than importing `settings` itself — App always calls this
 * as `applyPerfPreset(settings.global, on)`, but the function has no way to
 * reach any *other* settings block (settings.environment included) even by
 * accident, since it never holds a reference to `settings` at all.
 *
 * Idempotent by design: a second "on" while already on must not halve an
 * already-halved value, and a second "off" while already off must not touch
 * anything — both are silent no-ops, which is what lets App wire this
 * straight off the checkbox's own `checked` state without tracking whether
 * it already matches.
 */
const KEYS = ['particleCount', 'glow', 'lightIntensity', 'shaderIntensity'];

let saved = null; // pre-halve snapshot while on, null while off

export function applyPerfPreset(globals, on) {
  if (on) {
    if (saved) return; // already applied
    saved = {};
    for (const key of KEYS) {
      saved[key] = globals[key];
      globals[key] = globals[key] * 0.5;
    }
  } else {
    if (!saved) return; // nothing to restore
    for (const key of KEYS) globals[key] = saved[key];
    saved = null;
  }
}
