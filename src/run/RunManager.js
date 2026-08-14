import { settings } from '../config/settings.js';

/**
 * The 15 minutes themselves (spec §7).
 *
 * Owns the clock-facing state — elapsed time, spawn scheduling, telegraphs,
 * kills — and hands down one verdict per tick: playing, dead or won. Systems
 * stay ignorant of each other; every cross-wire (deaths feed gems, finished
 * casts release their hit memory) is knotted here and nowhere else.
 */
const TELEGRAPH_TIME = 0.5; // seconds a spawn ring shows before the enemy lands

export class RunManager {
  constructor(systems) {
    this.s = systems;
    this.active = false;
    this.elapsed = 0;
    this.kills = 0;
    this.telegraphs = [];
    this._spawnDebt = 0;

    this.s.enemies.onDeath = (x, z) => {
      this.kills++;
      this.s.pickups.dropAt(x, z, this.elapsed / 60);
    };

    // Casts hand back their hit memory the moment the manager retires them —
    // scanning `active` misses them (the manager splices finished casts out
    // of that array inside its own update, before this tick ever runs).
    this.s.abilities.onRetire = (ability) => {
      const id = this.s.combat.release(ability);
      if (id !== -1) this.s.enemies.releaseCast(id);
    };
  }

  start() {
    this.active = true;
    this.elapsed = 0;
    this.kills = 0;
    this.telegraphs.length = 0;
    this._spawnDebt = 0;
    this.s.enemies.clear();
    this.s.pickups.clear();
    this.s.player.reset();
  }

  stop() {
    this.active = false;
  }

  tick(step, playerPos) {
    if (!this.active) return 'playing';
    if (!this.s.player.alive) return 'dead';
    if (this.elapsed >= settings.run.duration) return 'won';

    this.elapsed += step;
    const minute = this.elapsed / 60;

    // Accrue spawn debt from the budget curve, jittered ±20%.
    const perSecond = (settings.run.spawnBase + settings.run.spawnQuad * minute * minute) / 60;
    this._spawnDebt += perSecond * step * (0.8 + 0.4 * this.s.rng());
    while (this._spawnDebt >= 1) {
      this._spawnDebt -= 1;
      this._queueSpawn(playerPos);
    }

    // Telegraphs count up; expired ones become enemies.
    for (let i = this.telegraphs.length - 1; i >= 0; i--) {
      const tg = this.telegraphs[i];
      tg.t += step / TELEGRAPH_TIME;
      if (tg.t >= 1) {
        this.s.enemies.spawnAt(tg.x, tg.z, minute);
        this.telegraphs[i] = this.telegraphs[this.telegraphs.length - 1];
        this.telegraphs.pop();
      }
    }

    // March, bite, collect.
    const contact = this.s.enemies.tick(step, playerPos, minute);
    if (contact > 0) this.s.player.takeDamage(contact);
    this.s.player.tick(step);
    this.s.combat.tick(step, this.s.abilities.active);
    this.s.pickups.tick(step, playerPos);

    return 'playing';
  }

  _queueSpawn(playerPos) {
    const angle = this.s.rng() * Math.PI * 2;
    const r = settings.run.spawnRadius;
    const x = playerPos.x + Math.cos(angle) * r;
    const z = playerPos.z + Math.sin(angle) * r;
    const a = settings.run.arenaRadius - 1;
    const d = Math.hypot(x, z);
    // Clamp the ring onto the arena so edge-hugging never starves spawns.
    const cx = d > a ? (x / d) * a : x;
    const cz = d > a ? (z / d) * a : z;
    this.telegraphs.push({ x: cx, z: cz, t: 0 });
  }
}
