import { WUXING_LABEL } from './TideSchedule.js';
import { t, wuxingWord, wuxingPhrase } from '../ui/strings.js';
import { settings, ELEMENT_META } from '../config/settings.js';
import { ELEMENT_SIGILS } from '../ui/glyphs.js';

/**
 * Tint per wuxing (金木水火土, same index order as WUXING_LABEL) — used for
 * the tide badge and the 禁咒 fill/glow. Its own small palette rather than
 * EnemyRenderer's ELEMENT_TINTS: that array is tuned for muted 3D materials
 * and isn't exported: a UI accent wants to read brighter/more saturated, and
 * the run HUD shares zero code with anything else by design (spec §9).
 */
const WUXING_TINT = ['#e8c766', '#6fdf9a', '#5fd0ff', '#ff6a4d', '#c99a5b'];

const SLOT_COUNT = 6;

const SLOT_HTML = Array.from(
  { length: SLOT_COUNT },
  (_, seat) =>
    `<div class="hud-slot" data-seat="${seat}">` +
    '<div class="hud-slot__name" data-name></div>' +
    '<div class="hud-slot__sweep"></div>' +
    '<div class="hud-slot__glyph" data-glyph></div>' +
    '<div class="hud-slot__cd" data-cd></div>' +
    '<div class="hud-slot__key" data-key></div>' +
    // 蓝量不足蒙层 (M6 T3): pure CSS opacity toggle off the root's
    // `is-low-mana` class (see `_updateCooldowns`) — no JS reference needed,
    // same "root class drives a child's opacity" pattern `.hud-slot__sweep`
    // already uses for the cooldown wash. Last child so the veil paints over
    // everything else in the slot, not just the glyph.
    '<div class="hud-slot__manamask"></div>' +
    '</div>'
).join('');

/**
 * The run's own HUD (spec §9): dressed replacement for the M1 grey-box.
 * Entirely run-owned DOM — shares zero code with the sandbox's `HUD`/
 * `.ability-card` bar (that class is untouched; App hides it in run mode
 * instead of borrowing it).
 *
 * Two entry points from App, matching how often each actually changes:
 * `syncSlots()` on loadout/autocast shape changes (acquire/fuse/restart/
 * toggle — cheap, infrequent), `update()` every rendered frame (hp/time/
 * cooldowns/charge — the live numbers).
 */
export class RunHud {
  constructor(parent = document.body) {
    this.root = document.createElement('div');
    this.root.className = 'run-hud';
    this.root.innerHTML =
      '<div class="run-hud__resonance" data-k="resonance"></div>' +
      '<div class="run-hud__tide-row">' +
      '<span data-k="time"></span>' +
      '<span class="run-hud__tide-glyph" data-tide-glyph></span>' +
      '<span data-k="tide"></span>' +
      '</div>' +
      '<div class="run-hud__kills"><span data-k="kills"></span><span data-k="level"></span></div>' +
      '<div class="run-hud__row">' +
      '<div class="run-hud__dodge" data-dodge></div>' +
      `<div class="run-hud__slots">${SLOT_HTML}</div>` +
      '<div class="run-hud__ult" data-ult>' +
      '<div class="run-hud__ult-fill" data-ult-fill></div>' +
      '<div class="run-hud__ult-key">F</div>' +
      '</div>' +
      '</div>' +
      '<div class="run-hud__xp" data-xp><i data-xp-fill></i></div>';
    parent.appendChild(this.root);

    this._fields = Object.fromEntries(
      [...this.root.querySelectorAll('[data-k]')].map((el) => [el.dataset.k, el])
    );
    this._tideGlyph = this.root.querySelector('[data-tide-glyph]');
    this._dodge = this.root.querySelector('[data-dodge]');
    this._ult = this.root.querySelector('[data-ult]');
    this._ultFill = this.root.querySelector('[data-ult-fill]');
    this._xp = this.root.querySelector('[data-xp]');
    this._xpFill = this.root.querySelector('[data-xp-fill]');

    /** One entry per seat, index-matched — never rebuilt, only mutated. */
    this._slots = [...this.root.querySelectorAll('.hud-slot')].map((slotRoot) => ({
      root: slotRoot,
      name: slotRoot.querySelector('[data-name]'),
      glyph: slotRoot.querySelector('[data-glyph]'),
      cd: slotRoot.querySelector('[data-cd]'),
      key: slotRoot.querySelector('[data-key]'),
      prevRemaining: 0
    }));

    /** Shift+click a slot toggles that seat's autocast — App wires this. */
    this.onSlotShiftClick = null;
    this._slots.forEach((slot, seat) => {
      slot.root.addEventListener('pointerdown', (event) => {
        if (!event.shiftKey) return;
        event.stopPropagation();
        this.onSlotShiftClick?.(seat);
      });
    });

    this._last = {};
    this._lastTideEl = -1;
    this._lastUltWux = -1;
  }

  /**
   * Push the loadout's current shape (spec §9's six-slot bar). Call after
   * anything that changes seats or autocast: construction, restart, acquire,
   * fuse, and the autocast toggle itself.
   *
   * @param {Array<{key:string, element:?string, label?:string, fusion?:boolean,
   *   autocast?:boolean, manaCost?:boolean}>} slots seat-indexed, length 6.
   *   `element` null means the seat is empty; `label` is the hover title
   *   (fusion display name for a fused seat, otherwise unused).
   */
  syncSlots(slots) {
    slots.forEach((data, i) => {
      const slot = this._slots[i];
      if (!slot) return;
      slot.key.textContent = data.key ?? '';
      const empty = !data.element;
      slot.root.classList.toggle('hud-slot--empty', empty);
      slot.root.classList.toggle('hud-slot--fusion', !!data.fusion);
      slot.root.classList.toggle('hud-slot--auto', !!data.autocast);
      slot.root.classList.toggle('hud-slot--mana', !!data.manaCost);
      // Forget stale cooldowns on restart: prevRemaining from death must not
      // false-trigger a 0-crossing when cooldowns reset.
      slot.prevRemaining = 0;
      if (empty) {
        slot.glyph.innerHTML = '';
        slot.name.textContent = '';
        slot.root.title = '';
        slot.root.style.removeProperty('--accent');
        return;
      }
      slot.glyph.innerHTML = ELEMENT_SIGILS[data.element] ?? '';
      slot.root.style.setProperty('--accent', ELEMENT_META[data.element]?.accent ?? '');
      slot.name.textContent = data.fusion ? (data.label ?? '') : '';
      slot.root.title = data.label ?? data.element;
    });
  }

  /**
   * Per-frame live readout. `ultimate` is the whole `Ultimate` instance
   * (charge + its fixed home wuxing); `cooldowns` is `App#_seatCooldowns()`'s
   * preallocated 6-entry `{active, remaining, total, lowMana}` array, or
   * omitted to leave the skill bar's cooldown/mana visuals as they were.
   */
  update(player, run, pickups, tideInfo, resonanceText, ultimate, cooldowns) {
    const s = Math.floor(run.elapsed);
    this._set('time', `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    this._set('kills', `${t('run.kills')} ${run.kills}`);
    this._set('level', `${t('run.level')} ${pickups.level}`);
    this._set('resonance', resonanceText);
    this._updateTide(tideInfo);

    const dodgeRatio = Math.max(
      0,
      Math.min(1, player.dodgeCooldown / Math.max(settings.run.dodgeCooldown, 0.001))
    );
    this._dodge.style.setProperty('--ratio', dodgeRatio);
    this._dodge.title = t('run.dodge');

    const ultRatio = Math.max(0, Math.min(1, ultimate.charge / settings.ultimate.chargeMax));
    this._ultFill.style.height = `${ultRatio * 100}%`;
    this._ult.classList.toggle('is-full', ultRatio >= 1);
    if (ultimate.wuxing !== this._lastUltWux) {
      this._lastUltWux = ultimate.wuxing;
      this._ult.style.setProperty('--ult-tint', WUXING_TINT[ultimate.wuxing] ?? '#e8c766');
    }
    this._ult.title = `${t('ult.label')} ${Math.floor(ultimate.charge)}/${settings.ultimate.chargeMax}`;

    const need = pickups.xpNeed(pickups.level + 1);
    const xpRatio = need > 0 ? Math.max(0, Math.min(1, pickups.xp / need)) : 0;
    this._xpFill.style.width = `${xpRatio * 100}%`;
    this._xp.title = `${Math.floor(pickups.xp)}/${Math.ceil(need)}`;

    if (cooldowns) this._updateCooldowns(cooldowns);
  }

  /** Current-tide badge (glyph + tint, title on every call so a language
   * flip is visible without waiting for the next tide turn) and the
   * countdown+next sentence — same wording the M1 grey-box used. The badge
   * glyph itself (`textContent`) stays WUXING_LABEL in both languages: it's
   * a small fixed-size circular icon (colour is its real channel, spec
   * §9.5), not a translated sentence — only the title/countdown prose below
   * switches to the WUXING word in en (M6 facade debt: en used to jam the
   * glyph straight against latin text, "金Tide"). */
  _updateTide(tideInfo) {
    const el = tideInfo.element;
    if (el !== this._lastTideEl) {
      this._lastTideEl = el;
      this._tideGlyph.textContent = WUXING_LABEL[el];
      this._tideGlyph.style.setProperty('--tint', WUXING_TINT[el]);
    }
    const tidePhrase = wuxingPhrase(el, 'run.tide');
    this._tideGlyph.title = tidePhrase;
    this._set(
      'tide',
      `${tidePhrase} ${Math.ceil(tideInfo.timeLeft)}s · ${t('run.nextTide')} ${wuxingWord(tideInfo.nextElement)}`
    );
  }

  /** Sweep ratio, ≥3s countdown text, the ready-pop transition, and the
   * low-mana veil (M6 T3) — one seat at a time, off the preallocated
   * cooldowns array. `is-low-mana` is independent of `is-cooling`: a seat
   * can be both at once (a wide cooldown that also outlasted a mana dip),
   * each its own visual (dark conic sweep vs. flat blue veil) so neither
   * reads as the other. */
  _updateCooldowns(cooldowns) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this._slots[i];
      const cd = cooldowns[i];
      if (!cd?.active) {
        slot.root.classList.remove('is-cooling');
        slot.root.classList.remove('is-low-mana');
        slot.cd.textContent = '';
        slot.prevRemaining = 0;
        continue;
      }
      slot.root.classList.toggle('is-low-mana', !!cd.lowMana);
      const remaining = Math.max(0, cd.remaining);
      const ratio = cd.total > 0 ? Math.min(1, remaining / cd.total) : 0;
      slot.root.style.setProperty('--cooldown', ratio);
      slot.root.classList.toggle('is-cooling', ratio > 0.001);
      slot.cd.textContent = remaining >= 3 ? String(Math.ceil(remaining)) : '';
      // 就绪弹跳: only on the actual >0 → 0 crossing, never on a seat that
      // was already idle (an empty seat re-filling, or a fresh cast at 0
      // this same frame, must not pop).
      if (slot.prevRemaining > 0.001 && remaining <= 0.001) this._pop(slot.root);
      slot.prevRemaining = remaining;
    }
  }

  /** Restart a CSS animation unconditionally — remove, force reflow, add
   * back, so a slot that pops twice in quick succession (a very short
   * cooldown) replays instead of the second trigger being a no-op. */
  _pop(el) {
    el.classList.remove('is-ready-pop');
    void el.offsetWidth;
    el.classList.add('is-ready-pop');
  }

  _set(key, text) {
    if (this._last[key] === text) return;
    this._last[key] = text;
    this._fields[key].textContent = text;
  }

  setVisible(on) {
    this.root.style.display = on ? '' : 'none';
  }

  dispose() {
    this.root.remove();
  }
}
