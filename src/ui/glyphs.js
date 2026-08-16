/**
 * Ability sigils for the HUD — drawn inline so they inherit `currentColor` (the
 * slot's `--accent`) and need no image assets.
 *
 * A 100×100 box, stroke only, so the mark reads the same at 34px in the ability
 * slot as it does scaled up.
 */

const WRAP = (body) =>
  `<svg class="glyph-svg" viewBox="0 0 100 100" aria-hidden="true" fill="none"
     stroke="currentColor" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * Ice — a six-fold snowflake over a rising lance.
 *
 * Three axes at 60°, each with a pair of barbs, and a heavier vertical that runs
 * past the star into a point: the star says frost, the point says skillshot.
 */
const ICE = WRAP(`
  <path d="M50 12V88"/>
  <path d="M17.5 30.5L82.5 69.5"/>
  <path d="M82.5 30.5L17.5 69.5"/>
  <path d="M50 24L41 33M50 24L59 33"/>
  <path d="M50 76L41 67M50 76L59 67"/>
  <path d="M27.5 36.5L27.7 49.2M27.5 36.5L38.5 30.4"/>
  <path d="M72.5 63.5L72.3 50.8M72.5 63.5L61.5 69.6"/>
  <path d="M72.5 36.5L72.3 49.2M72.5 36.5L61.5 30.4"/>
  <path d="M27.5 63.5L27.7 50.8M27.5 63.5L38.5 69.6"/>
`);

/**
 * Thunder — a bolt struck through a pair of arcs.
 *
 * The zigzag is drawn on the same diagonal the cast travels on, and the two
 * open arcs behind it read as the discharge spreading off it. Stroke only, like
 * the snowflake, so the two slots sit at the same visual weight.
 */
const THUNDER = WRAP(`
  <path d="M60 10L30 52H49L40 90L72 45H52L60 10Z"/>
  <path d="M23 26C13 36 11 52 17 65"/>
  <path d="M84 34C90 47 88 63 78 73"/>
`);

/**
 * Meteor — a cracked ball trailing fire.
 *
 * The circle sits forward and low with three seams splitting it, and three
 * tapering streaks run back up the same diagonal the other two sigils are drawn
 * on, so the slot reads as "the rock, thrown" at 34px.
 */
const METEOR = WRAP(`
  <circle cx="62" cy="62" r="24"/>
  <path d="M46 45L58 58L52 72M74 46L66 60L79 72M58 84L64 70"/>
  <path d="M30 70L10 90M40 34L18 22M22 48L4 44"/>
`);

/**
 * Beam — a charge held in a bracket, firing a cone.
 *
 * The orb sits low-left where the other three sigils start their diagonal, two
 * open brackets behind it read as the hands holding it, and three tapering rays
 * open out to the upper right with a single wave threaded through them: the
 * column, and the coil wrapped around it.
 */
const BEAM = WRAP(`
  <circle cx="27" cy="66" r="11"/>
  <path d="M13 55C7 62 7 74 13 81"/>
  <path d="M40 79C47 73 47 61 40 55"/>
  <path d="M41 57L92 20M42 66L94 50M43 75L92 80"/>
  <path d="M46 63C56 49 64 71 74 57C82 46 88 52 93 46"/>
`);

/**
 * Snare — a ring with a bolt standing in it.
 *
 * The only sigil in the set built around a *circle you look into* rather than a
 * diagonal, because that is the one thing this slot has to say before anything
 * else: it is not a skillshot, it is a footprint. The ellipse is the boundary
 * seen in perspective, four arcs step around it where the rim current runs, and
 * the zigzag rises out of the middle.
 */
const SNARE = WRAP(`
  <ellipse cx="50" cy="70" rx="38" ry="15"/>
  <path d="M12 70L4 70M88 70L96 70M31 82L27 89M69 82L73 89"/>
  <path d="M56 18L38 46H50L44 68"/>
  <path d="M50 55L62 40H52L58 26"/>
`);

/**
 * Glacier — a crown of blades standing on a ring.
 *
 * The second sigil built around a *circle you look into*, because it is the
 * second far cast and that is the first thing the slot has to say. Where the
 * Snare stands one bolt in the middle of its ellipse, this one stands the ring
 * itself up: five blades of uneven height rising off the boundary with the
 * spire tallest in the middle, which is the silhouette the ability actually
 * makes.
 */
const GLACIER = WRAP(`
  <ellipse cx="50" cy="74" rx="38" ry="13"/>
  <path d="M9 70L13 41L21 66"/>
  <path d="M24 65L30 31L37 60"/>
  <path d="M42 61L50 15L58 61"/>
  <path d="M63 60L70 31L76 65"/>
  <path d="M79 66L87 41L91 70"/>
`);

/**
 * Fireball — a small ball with the flame streaming off it.
 *
 * Deliberately the same reading as the Meteor sigil, one size down and with
 * nothing cracked: a plain circle, half the radius, sat at the head of a teardrop
 * of flame that runs back along the shared diagonal. The pair say "the rock" and
 * "the bolt", which is exactly how the two abilities differ.
 */
const FIREBALL = WRAP(`
  <path d="M70 30C82 42 82 58 70 70C58 82 42 82 30 70C24 64 22 55 24 47C29 52 35 52 38 48C43 42 40 33 34 26C46 22 62 22 70 30Z"/>
  <circle cx="56" cy="56" r="12"/>
  <path d="M20 82L8 94M30 88L24 96M12 70L4 76"/>
`);

/**
 * M6 T2 — the thirteen v1 launch skills. Each of the five 五行 families
 * shares one base motif so the set reads as five groups at a glance; the
 * per-skill path on top of it is the one thing that tells its members apart.
 * Same 100×100 stroke-only contract as the seven above — authored blind,
 * visual polish (spacing, weight) is a browser-verification pass, not this one.
 *
 * 金 — a blade (lens). 木 — chain links / a bloom. 水 — a ring, burst or closed.
 * 火 — a ring, flame or wheel. 土 — jagged rock strokes.
 */

/** Sword Rain — three falling blades over their ground-impact ticks. */
const SWORDRAIN = WRAP(`
  <path d="M28 6L22 40L28 50L34 40Z"/>
  <path d="M52 2L45 38L52 50L59 38Z"/>
  <path d="M74 12L68 44L74 54L80 44Z"/>
  <path d="M14 66L26 60M40 70L52 64M62 68L74 62M84 66L92 60"/>
`);

/** Blade Orbit — five blades riding an orbit ring around the caster. */
const BLADEORBIT = WRAP(`
  <ellipse cx="50" cy="55" rx="32" ry="13"/>
  <path d="M50 30L46 42L50 48L54 42Z"/>
  <path d="M83 44L77 53L81 60L87 53Z"/>
  <path d="M70 76L64 82L69 88L75 82Z"/>
  <path d="M30 76L24 82L29 88L35 82Z"/>
  <path d="M17 44L11 53L15 60L21 53Z"/>
`);

/** God-Killing Flash — one big blade on the slash, trailed by its own speed lines. */
const DASHSTRIKE = WRAP(`
  <path d="M20 80L58 18L68 26L34 90Z"/>
  <path d="M8 60L26 68M4 44L20 50M12 76L28 84"/>
`);

/** Chain Bolt — a zigzag bolt strung through its four hop targets. */
const CHAINBOLT = WRAP(`
  <path d="M20 15L45 40L30 45L75 85"/>
  <circle cx="20" cy="15" r="6"/>
  <circle cx="45" cy="40" r="6"/>
  <circle cx="30" cy="45" r="6"/>
  <circle cx="75" cy="85" r="6"/>
`);

/** Life Bloom — a four-petal flower opening around its own centre. */
const LIFEBLOOM = WRAP(`
  <path d="M50 50C50 50 42 30 50 15C58 30 50 50 50 50Z"/>
  <path d="M50 50C50 50 70 42 85 50C70 58 50 50 50 50Z"/>
  <path d="M50 50C50 50 58 70 50 85C42 70 50 50 50 50Z"/>
  <path d="M50 50C50 50 30 58 15 50C30 42 50 50 50 50Z"/>
  <circle cx="50" cy="50" r="8"/>
`);

/** Frost Nova — spikes bursting outward through the ring, the nova mid-expansion. */
const FROSTNOVA = WRAP(`
  <circle cx="50" cy="50" r="22"/>
  <path d="M50 8L50 22M50 78L50 92M8 50L22 50M78 50L92 50"/>
  <path d="M21 21L30 30M79 21L70 30M21 79L30 70M79 79L70 70"/>
`);

/** Crystal Ward — the same ring, closed over a hexagonal plate instead: armour, not a burst. */
const ICESHIELD = WRAP(`
  <circle cx="50" cy="50" r="24"/>
  <path d="M50 28L69 39V61L50 72L31 61V39Z"/>
`);

/** Cinder Ring — flame tongues licking up off the ground ring. */
const FIRERING = WRAP(`
  <ellipse cx="50" cy="62" rx="30" ry="11"/>
  <path d="M50 51C46 40 46 30 52 20C56 32 58 42 50 51Z"/>
  <path d="M78 58C76 48 80 40 88 34C88 46 86 54 78 58Z"/>
  <path d="M22 58C24 48 20 40 12 34C12 46 14 54 22 58Z"/>
`);

/** Sun Wheel — a hub of rays with its three orbiting fireballs. */
const SUNWHEEL = WRAP(`
  <circle cx="50" cy="50" r="10"/>
  <path d="M50 30V16M65 39L76 28M70 50H84M65 61L76 72M50 70V84M35 61L24 72M30 50H16M35 39L24 28"/>
  <circle cx="50" cy="20" r="7"/>
  <circle cx="76" cy="65" r="7"/>
  <circle cx="24" cy="65" r="7"/>
`);

/** Stone Spikes — jagged spikes rising in sequence along the ground line. */
const ROCKSPIKES = WRAP(`
  <path d="M10 80H90"/>
  <path d="M18 80L26 45L34 80"/>
  <path d="M40 80L50 30L60 80"/>
  <path d="M66 80L74 50L82 80"/>
`);

/** Boulder Fall — the rock, cracked, under its own fall lines. */
const BOULDER = WRAP(`
  <path d="M20 20L26 34M34 14L38 30M46 20L48 32"/>
  <circle cx="55" cy="60" r="26"/>
  <path d="M55 38L48 60L62 58L50 82M35 55L55 60L72 50"/>
`);

/** Quake — a jagged shockwave ring tearing the ground open on its diagonals. */
const QUAKE = WRAP(`
  <path d="M76 50L62.7 62.7L50 76L37.3 62.7L24 50L37.3 37.3L50 24L62.7 37.3Z"/>
  <path d="M68 68L82 82M32 68L18 82M68 32L82 18M32 32L18 18"/>
`);

/** Stone Skin — two overlapping plates, scaled like armour. */
const STONESKIN = WRAP(`
  <path d="M50 12L74 24V50L50 62L26 50V24Z"/>
  <path d="M50 40L74 52V78L50 90L26 78V52Z"/>
`);

/** Keyed by the ids in `ELEMENTS`. */
export const ELEMENT_SIGILS = {
  ice: ICE,
  thunder: THUNDER,
  meteor: METEOR,
  beam: BEAM,
  snare: SNARE,
  glacier: GLACIER,
  fireball: FIREBALL,

  // M6 T2
  swordrain: SWORDRAIN,
  bladeorbit: BLADEORBIT,
  dashstrike: DASHSTRIKE,
  chainbolt: CHAINBOLT,
  lifebloom: LIFEBLOOM,
  frostnova: FROSTNOVA,
  iceshield: ICESHIELD,
  firering: FIRERING,
  sunwheel: SUNWHEEL,
  rockspikes: ROCKSPIKES,
  boulder: BOULDER,
  quake: QUAKE,
  stoneskin: STONESKIN
};
