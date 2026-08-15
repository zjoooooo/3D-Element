import { settings } from '../config/settings.js';
import { FEEDS } from './TideSchedule.js';

/**
 * 相生轮转 (spec §4.8): casting along the generating cycle within the window
 * halves the second cast's cooldown. Pure so the check script can pin it.
 */
export function sequenceRefund(prevWux, prevAt, wux, now) {
  if (prevWux < 0 || wux < 0) return false;
  if (now - prevAt > settings.sequence.window) return false;
  return FEEDS[prevWux] === wux;
}
