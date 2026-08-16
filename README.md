# Elemental Sandbox

A skillshot VFX sandbox built with **Three.js**, **Vite** and hand-written **GLSL**.

Five abilities and two ways to aim them. Four are **line casts**: press the key to arm, a
League-of-Legends style arrow appears on the ground and swings with the mouse, click to fire. The
fifth is a **far cast**: the arrow is replaced by a circle with a deliberately thick boundary that
follows the cursor and answers the only question a ground-targeted AoE has to answer before you
commit — how much space is this going to take.

**Q — Frost Lance.** A fracture front races out along the line while a field of ice crystals
tears up out of the floor behind it — small and dense at your feet, opening into a wall of blades
at the far end, with a cluster thrown up around the impact point.

**E — Storm Lance.** A bolt leaves the caster's hand and a bundle of lightning filaments is drawn
out behind the strike front, holds while it gutters and re-strikes, then blows out. Sparks come
off it the whole way, the floor underneath takes a branching electric burn and a dark scorch, and
the far end gets a shell of ionised air.

**R — Cinder Fall.** A burning rock is lobbed downrange on an arc, trailing a raymarched wake of
burning gas and heating up the whole way: the lava seams splitting its surface prise wider and
brighter as it comes in. It detonates on arrival, throws its own shattered chunks across the floor, and tears the
ground open into a network of molten cracks that keep glowing while the crater burns out.

**F — Nova Beam.** The caster winds a ball of light up in both hands, pulling motes in out of the
air, then lets a column of it out along the line — white-hot core, cyan sheath, gold ribbons
spiralling around it and shock discs racing down it. It *holds* there, burning into the floor and
throwing spray back up the beam, before collapsing to a thread and blinking out. The only cast in
the sandbox that is still happening a second after it landed.

**V — Voltaic Snare.** The far cast. A leash of current is whipped out across the floor, and where
it lands the ring snaps open past its own radius and pulls back onto it: a violet column tears up
out of the middle, tendrils crawl outward to the boundary, arcs run around the rim and the whole
disc burns. It holds there re-striking and hauling the air up into the pillar, then collapses to a
thread. The circle you measured out before the click is exactly the circle you get.

**T — Ember Bolt.** The small one, and the cheap one. A 30cm ball of fire thrown flat and fast,
detonating on whatever it touches into a torn sphere of flame, a ring across the floor and a burnt
patch that outlives it. It owns no mesh and no shader: the ball is a hundred and ninety additive
particles a second emitted along the flight path with a fifth-of-a-second life, the wake is the same
emission inheriting a fraction of the velocity instead of all of it, and the impact is the burst
sphere and the decals every other element already drives. Which is why it is the one to copy when
adding an ability.

It is also the only ability that **does anything** — see *Targets and damage* below.

Everything you can see is generated. There are no textures, no sprite sheets and no meshes on
disk except the character: the crystals are procedural geometry, the bolt is a strip of ribbon
placed entirely by a vertex shader, the meteor is an icosphere cratered and sliced by fracture
planes on the CPU, the beam is a parametric tube drawn three times at three radii, the snare's
whole cage is that same ribbon strip threaded along four different parametric paths, the arrow, the
targeting circle, the rime, the burns and the molten cracks are signed-distance and noise shaders,
and the mist, sparks, chips and glitter are GPU particles.

**Every parameter is a live slider** — 1217 of them — and they stay live while the simulation is
paused. That is the point of the project: freeze a frame mid-eruption, mid-strike or mid-burn with
**P**, then reshape the silhouette, the palette and the timing against a still image.

References for the look: `icecast.jpg`, `thundercast.jpg`, `superbeam.jpg` and
`electricalboost.jpg`.

---

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Then open the URL Vite prints (default <http://127.0.0.1:5173>).

```bash
npm run build
```

```bash
npm run preview
```

### Assets

Seven binary assets are served from `public/` and loaded automatically at boot:

| File | Purpose |
| --- | --- |
| `public/models/Idle.fbx` | Rigged character **and** its idle animation clip |
| `public/models/diffuse.png` | The character's colour map |
| `public/models/run.fbx` | Run cycle, blended against the idle by travel speed |
| `public/models/cast1.fbx` | Cast animation |
| `public/models/cast2.fbx` | Cast animation |
| `public/models/cast3.fbx` | Cast animation — the default for Frost Lance, Root Snare and Glacier Crown |
| `public/hdri/spruit_sunrise.hdr` | HDR probe used for image-based lighting and crystal reflections |

All five FBX files are Mixamo exports carrying a skinned mesh plus one animation stack. The
character comes from the idle file; every other file is loaded for its clip alone, and the duplicate
rig that arrives with each one is released the moment its `AnimationClip` has been taken. Clips bind
to the skeleton by bone name, which is the whole reason an animation authored in another file plays
here without retargeting.

`prepareClip` in `animation/CharacterController.js` is what makes a foreign export playable: it takes
the first stack that actually has tracks (some exports ship an empty `Take 001` beside the real one)
and drops the tracks naming bones this rig does not have — the run cycle arrives with thirty finger
tracks the character has no bones for.

Dropping a new clip in is otherwise a copy into `public/models`, and `npm run check` says whether it
took: it plays every clip on the real skeleton and measures how far the planted toe lands from where
the idle puts it. That is the failure worth catching, because the hips track is authored in absolute
centimetres and a clip from a differently proportioned character can quietly float or sink the whole
body.

The rig ships no material, so `diffuse.png` is loaded beside it and assigned as the colour map when
the imported materials are converted to PBR — an FBX that *does* carry an embedded texture keeps its
own, since that map is authored against its own UVs.

Every ability picks the clip it throws — `castAnim` in its settings block, a dropdown under **The
cast** in its editor folder. Out of the box slots 1, 5 and 6 — Frost Lance, Root Snare and Glacier
Crown — throw `cast3`, and the other three throw `cast1`. The clip is a one-shot laid over
the looping idle, with `character.castBlendIn` / `castBlendOut` as the two edges of that overlap.

The clips are Mixamo performances and run long for a game — `cast3` alone spends 1.8 of its 3.25
seconds winding up before the hand moves. `character.castSpeed` (**cast rate** in the editor) is the
rate they are thrown at, which pulls the wind-up and the recovery in together; the spell leaves on
the click regardless of where the clip has got to.

The HDR is loaded as image-based lighting and as the reflection source for the ice — it is never
shown as a visible sky. The stage keeps its flat dark backdrop.

---

## Controls

| Input | Action |
| --- | --- |
| **Q** (or **1**) | Arm Frost Lance — press again to put it away |
| **E** (or **2**) | Arm Storm Lance — press again to put it away |
| **R** (or **3**) | Arm Cinder Fall — press again to put it away |
| **F** (or **4**) | Arm Nova Beam — press again to put it away |
| **V** (or **5**) | Arm Voltaic Snare — the far cast, aimed with a circle |
| **X** (or **6**) | Arm Glacial Crown — the second far cast |
| **T** (or **7**) | Arm Ember Bolt |
| **Move the mouse** | Swing the aim arrow, or move the far-cast circle |
| **Left click** | Cast along the arrow, or drop the circle where it is |
| **Esc** / **right click** | Cancel an armed cast |
| **Right mouse + drag** | Swing the camera bearing — works with **fixed angle** on or off; a right *click* (under 6px of travel) still cancels an armed cast |
| **Scroll** | Zoom |
| **G** | Show/hide the VFX editor |
| **P** | Pause / resume — *the editor keeps applying* |
| **C** | Clear all active effects |
| **H** | Hide the controls panel |

`range` and `minRange` are per ability, so the indicator's reach changes with the slot you have
selected. Aiming closer than the selected ability's `minRange` tints it red and refuses the cast;
set `minRange` to 0 if you would rather cast at your own feet, which is what the Snare ships with —
a trap you cannot drop on yourself is missing half its uses. Cooldowns are per ability too, so
spending one slot never locks the other out.

The camera ships **fixed angle** on (`camera.fixed`): an isometric ARPG rig that sits on one bearing
— `fixedPolar` off vertical, `fixedYaw` around it — rather than an orbit you fly by hand. It is what
puts the whole footprint of a cast on screen, which is the point of an aim indicator drawn on the
floor. Both angles, and the toggle, are live in the **Camera** folder; switching it off hands the
right-drag orbit back, clamped by `minPolar` / `maxPolar` as before.

---

## Run mode

Open the URL with `#run` for the roguelike run: an arena where abilities face procedurally spawning enemies and gem pickups (`#run=quick` — see M5 below — skips the title screen this now opens on). The six-slot loadout, as configured out of the box, is:

| Slot | Key | Ability |
| --- | --- | --- |
| 1 | **LMB** | Ice |
| 2 | **RMB** | Fireball |
| 3 | **Q** | Thunder |
| 4 | **E** | Meteor |
| 5 | **R** | Beam |
| 6 | **T** | Glacier |

**Space** dodges; **Enter** restarts after victory or defeat. The loadout — which ability sits in each of the six slots — is rebindable in the editor's Run folder; changes apply from the next run.

A run drafts its build (M2): with `draft loadout` on (the default, togglable in the editor's Run folder), you start with slot 1 only and earn the rest. Each level-up freezes the whole world — enemies, spells, movement, VFX — and deals up to three cards: press **1/2/3** (or click) to take a new ability, a +25 % damage level for a seated one, or a generic passive (疾行 move speed, 淬体 max health, 凝神 cooldowns, 拾荒 experience, 施法回响 echo casts, 时来运转 rerolls). **4** declines the hand and heals 10 % of max health; 时来运转 adds a reroll button with per-hand charges. Levels 5/10/15 always offer a new ability while a slot is open. Upgrades live in a per-run modifier layer — the editor's numbers in `settings.js` are never written, so the next run and the sandbox always start factory-fresh.

The run rides five three-minute elemental tides (M3): a Fisher–Yates order dealt once per page load, each front leaning 70 % of its spawns toward the tide's own wuxing and closing with a toast and a 30-gem gold rain at your feet. Enemies come in three gaits — 涌兽 swarm in from the start, 吐息者 join at minute 1.5 and hold at 8 m to lob dodgeable red bolts, 磐兽 wade in from minute 3 and barely notice knockback. Two elites spawn per tide, at fixed points in its progress (40 %/75 %), scaled to 40× hp / 1.6× size / 1.5× damage, and drop a blue gem that flies in from anywhere on the field plus a shard locked to their element; picking up a shard opens a hand offering only that wuxing, or — if none exist yet — falls back to the level-up hand's skip-heal. Damage runs through the same wuxing cycle as the passives: an attack lands at 1.25× against the element it beats and 0.8× against the element that beats it. Death or victory opens a verdict screen: survival time, kills, level, the build taken, top three skills by damage dealt, and on death a line naming the killer and which element counters it.

**Shift**+1–6 (or **Shift**+click a loadout badge) arms that seat's autocast — it fires at the nearest enemy off cooldown for a 0.85× damage tax and marks the badge with a blue dot, sitting out while a card hand is open or after death; **Enter** clears it along with the rest of the run state on restart.

Wuxing depth (M4): every hit tags its target with a mark (印记) carrying the attack's wuxing for 8 s. Follow it with a hit of the wuxing that mark generates (相生) and it detonates for 1.5× the triggering hit's raw damage — 2.25× once 周天 resonance is live — firing one of five paired payoffs down the generating cycle: 金→水 凝露 slows the target, 水→木 滋养 heals you, 木→火 助燃 splashes damage around it, 火→土 烧结 drops a bonus gem, and 土→金 淬炼 arms your next metal cast to land quenched (dormant until an earth skill exists, M6). Each of the five 相克 matchups also brands the losing side with a timed debuff on top of the usual 1.25×/0.8× matchup swing: 水克火 熄灭 cuts contact and bolt damage 30 %, 土克水 淤塞 doubles the next slow that lands (capped at 90 %), 火克金 熔甲 raises incoming damage 25 %, and 金克木/木克土 断枝/破土 raise it 15 %.

Two or more equipped skills sharing a wuxing resonate (共鸣): 金 raises matchup advantage from 1.25× to 1.35×, 木 heals 1 hp per kill, 水 stretches slow duration ×1.5, 火 boosts burn-tick damage ×1.3 — 土's knockback bonus and 周天 (every wuxing represented at once, amplifying reaction damage a further ×1.5) both wait on an earth skill that doesn't exist yet (M6). Casting a skill within 4 s of the one that generates it (相生轮转) halves its cooldown and pops a toast. Once both parents reach level 4, a 相生 pair of seated skills can fuse into one gold seat, firing both spells together (each ×1.2 damage, growing to ×1.8 as the fused seat itself levels to 3) off one shared cooldown and freeing the seat its absorbed parent leaves behind — a composite-cast placeholder, both parents' own VFX firing side by side until M6 ships five dedicated fusion effects; two of the five 相生 pairs need an earth skill to ever ripen.

The HUD carries elapsed time and the tide banner, kills and level, and — only while something resonates — a `共鸣` line naming which wuxing and whether 周天 is up; M5 dresses the rest (health/mana, the skill bar, the arena itself) as its own paragraphs below.

M5 puts a title screen in front of the run: `#run` opens on a line of lore, five 本命 cards (one per wuxing — metal/wood/water/fire pickable, earth a disabled placeholder until M6 ships an earth skill), a character dropdown and a link back to the sandbox. Picking a card seats that element at loadout slot 1, sets it as your 禁咒 ultimate's home element, and starts the run; `#run=quick` skips the screen and drops straight into `settings.run.loadout` as configured, which is what the existing browser-verification passes still use. **Esc** opens a pause menu instead of cancelling a cast — three volume sliders (sfx/ui/music), a 中文/EN toggle that reflows every `t()`-driven string live, `reduceFlashes`/`performanceMode` checkboxes, a read-only build recap, and 继续/重开/回标题 — and is a full stop, the same freeze a level-up hand already used. `performanceMode` writes and restores a `settings.global` multiplier preset rather than touching any effect's own base numbers; `reduceFlashes` halves the big screen flashes and the low-health heartbeat.

Every wuxing carries a 禁咒: a field-wide ultimate charged by kills (+1) and sheng detonations (+5) up to `settings.ultimate.chargeMax`, fired on **F** once full — an early press just toasts and spends nothing. Each element's payoff is a full-arena call into the existing damage/slow API rather than a dedicated VFX class: 金 hits everything and then executes anything left under an absolute hp floor, 木 slows the field and heals you over four seconds, 水 freezes everyone solid, 火 lands three damage waves, 土 hits and stuns. A successful cast clears the charge, flashes the screen, shakes the camera and buys the same brief hitstop an elite kill or a sheng detonation already does. A mana pool sits behind the run's second glass bottle at 100, regenerating 4/s plus 1 per kill — full for the whole of M5, since no ability spends it yet.

Health and mana are two hand-blown glass bottles (camera-locked quads, an SDF silhouette and a wobbling liquid surface, no DOM and no texture) at the bottom corners — HP left, mana right. A hit sloshes the liquid and reddens the screen edge; under 30 % health the bottle's surface takes on a lub-dub heartbeat that quickens as hp drops, halved under `reduceFlashes`. The skill bar below is six glyph icons — no text, hover for the name — with a conic-gradient cooldown sweep, a ready pop on a long cooldown clearing, and a small dot reserved for anything that will cost mana once M6 ships a consumer; **F**'s own slot fills inward as the ultimate charges and glows once it is full. A full-width bar along the bottom edge carries xp.

The arena is dressed to match: a five-way ritual ring etched into the ground and five procedural crystal steles standing on its boundary, one per wuxing and tinted to match — the current tide's stele burns bright, the next one breathes a slow pulse as it warms up, and a light arc traces the boundary between them, replacing the M1 placeholder rim. Light, fog and drifting dust glide toward each tide's own palette over a 20-second cross-fade on a turn — 金 gold dust, 木 fireflies, 水 falling snow, 火 warm embers, 土 dry haze — read off `settings.tides.atmosphere` and multiplied onto the environment's already-updated runtime colours rather than overwriting them, so a sandbox session (which never constructs the class doing this) stays frame-for-frame untouched.

Killing anything throws off a burst of wuxing-tinted shard debris, doubled in size for an elite; a sheng detonation, an elite kill or a fired ultimate all buy the world a brief 0.85× hitstop; getting hit flashes the screen red and flickers the character, scaled to the hit's share of your health. Space still dodges, but the sorcerer rig (the default model) now plays an actual roll clip for it — the 3 m dash and the invulnerability window are spread across the animation instead of teleporting, capped at 0.35 s even where the clip itself runs longer — while the classic rig has no roll clip and keeps the old instant teleport. All of the above is damped under `reduceFlashes`.

Eleven vendored ZzFX voices (a single-function MIT synth) cover the five elemental casts, a plain hit, a sheng detonation, levelling up, getting hurt, dying and winning, scaled through the sfx/ui volume sliders and throttled to eight plays a frame — twelve for the five rare "big moment" sounds — so a packed fight never turns into static; the `AudioContext` unlocks on the title screen's first click, and the sandbox stays silent.

`index.html` checks for WebGL2 and a non-mobile viewport before `main.js` ever touches the canvas, swapping in a bilingual "this needs a desktop browser" page in place of a blank canvas or a stack trace; a GPU context lost mid-run raises the same overlay with a "click to reload" instead of freezing on a black screen.

To validate the game loop headless, run `npm run check:game` — forty-two blocks of logic tests including the mixed-horde stress gate (measures tick time at the 300-enemy spawn cap, spitter shots live; must stay under 2 ms/tick).

---

## Project layout

```
src/
  abilities/      Ability base class (the travelling front), IceAbility, ThunderAbility,
                  MeteorAbility, BeamAbility, SnareAbility, pooling manager
  animation/      FBX character loading, AnimationMixer, the per-ability cast clips,
                  the procedural cast lunge
  assets/         Procedural crystal and asteroid geometry, the bolt ribbon strip,
                  the beam tube and its shock discs
  config/         settings.js — the single source of truth for every parameter
  core/           App, Renderer, CameraRig, Time, Layers, shared frame uniforms
  effects/        Aim arrow, far-cast circle, ground decals, fissures, bursts,
                  light pool, shake, flash
  input/          InputManager (events) and AimController (both targeting shapes)
  loaders/        AssetLoader with a shared LoadingManager
  materials/      IceMaterial, LightningMaterial, MeteorMaterial,
                  VolumetricFireMaterial, BeamMaterial, SnareMaterial
  particles/      GPU particle system + engine and rate emitters
  postprocessing/ Composer pipeline, grade shader, distortion shader
  shaders/lib/    Shared GLSL: noise library, common helpers
  ui/             HUD, lil-gui editor, preset manager, styles
  utils/          Maths, colour cache, pooling, disposal, shader patching
  world/          Environment (stage lighting), floor, dust, contact shadows
  archive/        The retired four-element sandbox — see archive/README.md
```

---

## How it fits together

### Settings are the API

`src/config/settings.js` holds every tweakable value. Nothing else owns that state: shaders,
particle systems, lights and post passes *read* those objects every frame. That is what makes the
editor work with no rebuild — moving a slider changes the ice field that is already standing, the
next cast, the environment and the post stack at once. Preset loading deep-merges *into* the same
objects so every live binding stays valid.

```js
import { settings } from './config/settings.js';
settings.ice.height = 7;          // visible on the next frame, even mid-cast
settings.thunder.jitter = 1.2;    // re-kinks a bolt that is already in the air
settings.global.timeScale = 0.1;  // slow the whole cast to a crawl
```

Ability blocks are keyed by their id in `ELEMENTS`, and the shared systems that need to know
"which ability is the player holding" — the aim controller, the cooldowns, the HUD — look it up as
`settings[element]`. The four fields they rely on being present are `range`, `minRange`, `speed`
and `cooldown`; a far cast adds a fifth, `zoneRadius`. Everything else in a block is that ability's
own business.

### The rule that makes "edit while paused" work

A spike record in `IceAbility` stores **only what the dice decided**: a position *fraction* along
the line, a signed lateral *fraction*, and a handful of unitless jitters. Not one metre, radian or
second is captured when the cast starts. Every dimension is resolved against `settings.ice` inside
the update loop, which runs on a zero-length frame too.

So dragging `height` re-grows a field that is already standing; dragging `lean` re-tilts it;
dragging `clumping` re-packs it toward the centre line. The only values a record *does* capture
are timestamps — the moment its own eruption was triggered. Those are events, not dimensions.

The four *shape* controls (`facets`, `taper`, `roughness`, `bend`) cannot be expressed as a
per-instance transform, so they are baked into the geometry instead — and a six-sided crystal is
just 60 triangles, cheap enough to regenerate outright rather than approximate in a vertex shader.
`IceAbility#_syncGeometry` hashes those four values and rebuilds the three crystal meshes when the
hash changes, which is what keeps them live sliders rather than restart-required constants.

### Aiming

`AimController` raycasts the pointer onto the ground plane **every frame**, not only on mouse
move, so orbiting the camera with a cast armed swings the indicator under a stationary cursor. It
clamps the distance into `[minRange, range]`, tracks a 0..1 reveal envelope, and emits a single
`cast` event carrying an origin, a unit direction and a distance — which is exactly the signature
`Ability#spawn` takes. It decides nothing about what the cast does.

It runs on **real** time rather than the scaled simulation delta, so the indicator keeps animating
while the sandbox is paused.

There are two indicators and one controller. Which one is drawn comes from
`ELEMENT_META[element].cast` — `CastShape.LINE` or `CastShape.ZONE` — and that is the *only* thing
the two shapes disagree about. Arming, clamping, validating, revealing and firing are shared, and
both end in the same three-argument `cast` event, because from the targeting side a far cast is a
line cast you only care about the far end of. That is why zone targeting needed no change in
`Ability`, `AbilityManager` or `App`: `SnareAbility` reads its centre as `pointAt(1)` and works
outward from there.

### The far-cast circle

`ZoneIndicator` is the arrow's opposite number, and it is built out of the same two ideas: metres,
and no textures.

The **footprint** is one quad whose fragment shader remaps UV into metres from the target, so the
boundary stays 0.34 m thick whether the circle is 2 m or 8 m across. The band is deliberately the
heaviest mark on screen — it is the whole message — and it is split about the nominal radius by
`boundaryBias` rather than centred on it, so its *outer* lip stays honest about where the effect
ends. Inside there is a rim-weighted wash, contour rings travelling outward, warped filaments and a
reticle whose downrange arm is longer, because the quad carries the caster's yaw and that arm is
therefore the heading.

The **reach ring** at the caster is the bolt's ribbon strip bent into a circle: `(t, side)` in,
world position out. A quad big enough to hold a 20 m range would be 40 m across and shade a
screenful of discarded fragments for one thin line.

The circle **snaps out past its radius and settles back** when the cast is armed, and the trap does
the same thing when it lands. A circle that grows linearly reads as a UI element; one that
overshoots reads as something the caster did.

### The arrow is one SDF

`AimIndicator` is a single ground quad. Its fragment shader remaps UV into **metres measured from
the caster**, so every control in `settings.aim` is a real measurement — the shaft stays 0.42 m
wide whether the cast is 3 m or 15 m long.

The silhouette is a rounded union of a box (the shaft) and iq's exact triangle SDF (the head);
the cheap half-plane intersection leaves visible corner artefacts on a wedge this shallow. From
that one distance field the shader derives the outline, the rim-weighted interior wash, the
chevrons (a phase skewed by `|x|`, which turns flat bands into arrowheads pointing the way the
cast does), the frost noise and voronoi plates, the ring at the caster's feet, the range cap arc,
a six-fold frost rosette pinned to the impact point, and the sweep-out when the ability is armed.

### The ice

`materials/IceMaterial.js` patches a `MeshStandardMaterial` rather than replacing it, so the
crystals cast and receive the stage's real shadows and pick up the HDR probe. The stylisation is
injected on top:

- **Thickness tint** — a facet seen head-on has the longest path through the crystal, so it
  darkens toward `colorDeep`; grazing edges stay pale. This is the term that makes the field read
  as a solid you can see *into* rather than as blue plastic.
- **Internal fracture** — ridged noise sampled in **world** space, so the crack planes stay a fixed
  physical size whether a spike is ankle-high or three metres tall, and neighbouring crystals look
  quarried from the same block.
- **Feather frost and rime** — fbm sampled in **local** space (0..1 up the crystal), so the milky
  veining and the frost creeping up from the base follow each spike's own axis however it is
  scaled or leaned.
- **Glint** — a hard-thresholded high-frequency field scrolling in world space, biased toward
  grazing angles, which is where real ice catches.
- **Birth flash** — a per-instance attribute the ability drives from 1 to 0 over `birthFade`, so a
  crystal is lit from within for the moment it erupts.

Three `InstancedMesh`es share one material. Three rather than one because the *facets* differ, not
just the proportions — per-instance scaling alone cannot buy that silhouette variety, and three
draw calls is a cheap price.

### The lightning

`ThunderAbility` takes the "no dimensions on the CPU" rule further than the ice does: there is no
path object at all. The bolt is one `InstancedBufferGeometry` — a flat ladder of quads in
*parameter* space, where each vertex carries only `(t, side)`: how far along the bolt it is, and
which edge of the ribbon it is on. One instance is one filament. `materials/LightningMaterial.js`
turns that pair into a world position every frame, so a single strip serves a bolt of any length,
any shape and any width.

Three things stack to make the shape:

- **the axis** — a straight line from the hand to the impact point, bowed by `sag`. The only part
  that knows where the cast is pointing.
- **the fan** — a constant per-filament offset in the plane perpendicular to the axis, opening
  from `spreadNear` at the hand to `spread` at the target and rolling around the axis with
  `twist`. This is what separates one filament from the next.
- **the kinks** — octaves of *linearly* interpolated value noise. Linear on purpose: smoothstep
  would round the corners off, and the corners are the entire reason it reads as lightning rather
  than as a wobbly tube.

The ribbon is turned to face the camera by crossing the local tangent with the view vector, which
is why the bolt keeps its apparent thickness from any angle without ever being a screen-space
line. It is drawn twice — a wide soft halo underneath and the hot core on top — because drawing
the glow as real ribbon rather than leaving it to bloom is what keeps it *attached* to every kink.

Two clocks run the flicker. `restrike` snaps every filament onto a new shape N times a second,
and `crawl` slides the kinks continuously in between; together they stop a held bolt from looking
like a static ribbon. A cast captures exactly one number — a seed, so two casts do not draw the
identical bolt — and resolves every metre, radian and second against `settings.thunder` each
frame. That is why dragging `jitter` re-kinks a bolt that is already in the air.

The ground burns are worth a note as a thing *not* to do. The first version sampled the filament
field on `atan(y, x)`, which hands every radius along a given bearing the same value and draws
dead-straight spokes out of the centre — a firework, not a burn. Sampling the same noise in the
plane and warping the lookup is what lets the filaments meander and fork.

### The beam

The Nova Beam shares the bolt's rule — no dimensions on the CPU — and reaches the opposite look
with it. Where the bolt's whole charm is that its noise is *piecewise-linear* and keeps its
corners, every noise term in the beam is smooth, stretched hard along the flow and crawling
downrange. A beam that kinks is a bolt.

It is a real tube rather than a camera-facing ribbon, because a column this thick has to *have* a
cross-section: the silhouette must bow correctly when you orbit it, the far wall must add through
the near one, and the shock discs have to hug it. `createBeamTubeGeometry` is the ribbon strip one
dimension richer — every vertex carries `(t, a)`, how far along the barrel it is and how far around
— and `materials/BeamMaterial.js` turns that pair into a world position each frame.

That one tube is drawn three times, and the trick is in how the three are weighted:

- **halo** — widest, nothing but a rim term. The atmosphere the beam is shoving out of the way.
- **sheath** — rim-weighted, so it reads as *hollow* and its silhouette edges are its brightest part.
- **core** — narrow, and weighted the **opposite** way: brightest where the view ray runs down the
  barrel and its path through the tube is longest.

Rim-weighted outside, axis-weighted inside, both faces adding: that is a volume integral, cheaply,
and the inversion is the entire reason the middle reads as a solid rod of light instead of as a lit
pipe. Widen `coreWidth` or push `coreFill` up and the three layers collapse into one white tube —
the cyan sheath and the gold coils are only legible because the core leaves them room.

Two more instanced passes put structure on it. The **coils** are the bolt's ribbon strip bent into a
helix, camera-facing and warm on purpose — the colour split is what stops them dissolving into the
sheath. The **shock discs** are an instanced annulus whose phase is `fract(index / count + time ×
speed)`, so the train is a pure function of the clock and there is no queue on the CPU. Both place
themselves against the same `beamRadius()` the tube uses, which is why all five stay welded together
when the profile is dragged.

The beam is also the one ability with a **fourth beat**. The other three run travel → impact →
fade; this one puts a wind-up in front of that, and it needed nothing from the base class:
`advance()` simply refuses to let the front leave the hand until the orb is up to power, so `IMPACT`
becomes the burn and the phase machine is untouched. The far end therefore has an impact that keeps
happening — spray thrown back up the line, pressure shells shed off the burning point, dust and
shockwave rings pushed across the floor, all rate-throttled through the same fractional-rate emitter
the particles use so every rate is a live slider.

### The snare

The Voltaic Snare is the first ability built around a *point* instead of a line, and the thing that
holds it together is that `zoneRadius` is read in exactly one place per consumer and nowhere is it
copied: the indicator measures it out, the tendrils end on it, the rim arcs run along it, the field
burns it and the column's throat and flare are fractions of it. Drag it and all five move together,
mid-cast, with the clock stopped.

The whole cage — the whip that plants it, the pillar, the tendrils and the rim arcs — is **one
instanced ribbon strip**, the same one the bolt and the beam's coils are drawn on. A filament's
*role* is decided in the vertex shader by testing its instance index against four live counts, and
the role picks which parametric path it is threaded along:

- **leash** — a sagging line from the hand to the travelling tip, dropped onto the floor.
- **column** — a twisting climb whose radius opens from `throat` to `columnSpread`.
- **tendril** — a meander running outward, its veer a per-filament constant rather than noise, so
  it curves the way a discharge that has committed to a direction does.
- **rim** — an arc travelling around the boundary, hopping over it at mid-span.

Every offset then lives in a frame taken by finite difference off that path, which is what lets one
kink function serve a vertical pillar and a filament crawling flat across the floor. The two
ground-hugging roles damp the vertical component of that offset and clamp above the floor — a kink
with a free `y` buries half of every tendril and the effect reads as a broken dotted line. Setting
a count to zero retires the role outright, which is how the leash disappears on the frame the ring
takes over. Two draw calls cover all four roles, however many filaments are in the air.

The **field** is a quad rather than a pooled decal for one reason: a decal captures its radius when
it spawns, and this circle has to re-scale under `zoneRadius` while it is standing. Its veins are
sampled in the plane and domain warped — the same lesson the bolt's ground burns taught, and for
the same reason.

The one thing worth stealing for the next far cast is the **snap**: the ring opens on
`Easing.outCubic` multiplied by a bump that peaks late and dies at exactly 1, so it overshoots its
radius and pulls back onto it, and the pillar climbs on the same clock 1.7× slower. The ground goes
first, then the air breaks down over it.

### Adding another ability

1. Add a settings block in `config/settings.js` and an entry in `ELEMENTS` / `ELEMENT_META`.
2. Subclass `Ability` and implement `createShaders`, `createParticles`, `onTravel`, `onImpact`,
   `onFade`.
3. Register the class in `abilities/AbilityManager.js`.
4. Add an editor folder in `ui/Editor.js`, and a sigil in `ui/glyphs.js`.
5. Bind a key in `input/InputManager.js` — it emits `ability` with the 0-based slot index, which
   `App` maps through `ELEMENTS`.

To make it a **far cast** instead of a line cast, add two things and nothing else: `cast:
CastShape.ZONE` in its `ELEMENT_META` entry, and a `zoneRadius` in its settings block. The circle
indicator, the reach ring, the snap-out and the whole targeting loop come for free, and the ability
reads its centre as `pointAt(1)`.

Everything else — pooling, the travelling front, the local frame, lights, phases, per-ability
cooldowns, the aim reach and camera framing — is inherited or driven off `ELEMENTS`. The HUD
builds its slots from that array, so a new ability appears in the bar on its own.

`abilities/FireballAbility.js` is the shortest worked example: no mesh, no shader, no new geometry,
nothing but emission parameters and one flight path.

### Targets and damage

`world/TrainingDummies.js` is a ring of straw posts with hit points — the only thing in the project
that can be damaged, and the measuring stick the abilities are otherwise missing. Each post is three
primitives and a material of its own (the hit flash is per-target), takes a knock when it is hit,
tips over at zero and stands back up after `dummies.respawn`.

Both readouts are DOM rather than geometry. A health bar is a rectangle that has to stay legible at
every camera distance and never be occluded, which is what a projected `<div>` is good at and what a
sprite in the scene has to fight the renderer to achieve — and it keeps the feature in one file
rather than adding a texture atlas and a draw call to say "184". `TrainingDummies.update` projects
each target once per frame and writes one transform per readout; nothing in the CSS lays anything
out, so a hundred figures cost a hundred transforms and no reflow.

The hit test is two spheres. `damage(point, radius, amount)` falls off linearly to half at the rim,
so `radius` is the honest reach of a blast rather than a cliff, and `hits(point, radius)` is the
same overlap with no damage and no readouts — what a projectile asks every frame of its flight.

Only **Ember Bolt** is wired to it, and it is wired in two places: `hitStop` in `onTravel`, which
shortens the cast to the distance already flown so the burst lands *on* the target rather than on
the floor behind it, and one `damage()` call in `onImpact`. Its `damage` and `damageRadius` are
deliberately not scaled by any of the Global multipliers — turning the explosions up is a look, not
a buff, and a sandbox has to be able to answer "does this read as hard as it hits" with the two
separable. Pointing another ability at the dummies is those same two lines.

### Particles

`particles/ParticleSystem.js` is a GPU-simulated, instanced-quad system. Motion (velocity, gravity,
analytic drag, curl turbulence, vortex swirl), size-over-lifetime, the colour gradient and alpha
fade are all evaluated in the shader from per-instance attributes; the CPU only ever writes spawn
data, and only the slots that changed are uploaded. Particles live in a ring buffer, so spamming
the ability recycles slots instead of allocating. Silhouettes (soft, smoke, streak, leaf, chip,
ring) are procedural — there are no sprite textures anywhere in the project.

Frost Lance uses three systems: **mist** (non-additive, so the fog genuinely occludes and gives the
field depth), **shards** (lit chips under gravity) and **glitter** (additive, negative gravity — the
rising plume that is the signature of the reference frame).

Storm Lance uses four: **sparks** (velocity-stretched streaks under gravity), **motes** (the slow
ionised drift around the bolt), **smoke** (non-additive haze off the scorched floor) and **debris**
(lit chips). Its sparks are emitted from several points along the bolt each frame rather than one:
a beam sheds along its whole length, and a single origin makes every batch read as a starburst.

Nova Beam uses four as well, and works one of them twice: its **motes** are the intake spiralling
*into* the orb while it charges and the drift shed off the column once it is firing — the same glow,
thrown the other way. Its **sparks** are thrown radially off the barrel and then dragged downrange
by `sparkForward`, which is the read that says "pressure"; the bolt's fall instead, and that one
difference does a lot of the work of keeping the two abilities apart.

### Render pipeline

Per frame:

1. **Depth prepass** — the opaque world into a half-res packed-depth buffer. Every VFX shader
   samples it for soft intersections, so nothing cuts a hard line into the ground. The crystals sit
   on `LAYER.WORLD`, so mist and glitter fade softly against them.
2. **Distortion pass** — meshes on the distortion layer write screen-space UV offsets into a second
   half-res buffer. Nothing writes to it in the current build; the pass is kept because it is the
   hook a refraction effect would use.
3. **Composer** — scene → refraction warp → bloom → tone map (ACES) → grade.

The grade pass folds chromatic aberration, lift/gain/contrast/saturation/temperature, vignette,
film grain and the impact flash into one resample.

Shadows come from a single directional light whose orthographic shadow camera is re-centred on the
character each frame and fitted to a 52 m box at 4096² (~1.3 cm/texel). The `three/addons` CSM
module was tried first and removed: it replaces three's `lights_fragment_begin` chunk *globally*,
so any material not explicitly registered with it silently loses all directional lighting.

Contact shadows are a real render: the character's depth is captured from below into a 256²
target, blurred twice and projected onto the ground.

---

## Editor and presets

Press **G** for the panel. Folders: Presets, Global, Aim indicator, Far-cast circle, Frost Lance,
Storm Lance, Cinder Fall, Nova Beam, Voltaic Snare, Glacial Crown, Ember Bolt, Environment, Post
processing, Camera, Character. Every folder starts collapsed — there are enough controls here that one open section
pushes the rest off the screen.

- **Global** multipliers scale everything at once (speed, glow, noise, particles, lights, impact
  intensity, camera shake, time scale…).
- **Aim indicator** — the arrow's silhouette in metres, its outline and fill, the chevrons and
  frost, and the rings and rosette.
- **Far-cast circle** (40 controls) — the boundary band, the interior, the ticks, sweep and
  reticle, the reach ring, and the snap-out. Shared by every far cast, so it is filed with the
  targeting rather than with any one ability.
- **Frost Lance** (113 controls, 25 of them colours) — the cast, the footprint, the silhouette,
  the crystal itself, the eruption timing, the ice material, the frost on the ground,
  mist/chips/glitter, the impact and the dynamic light.
- **Storm Lance** (123 controls, 34 of them colours) — the cast, where the bolt leaves the hand,
  the bundle, one filament, the ribbon, flicker and restrike, the bolt's colour, the burns on the
  ground, sparks/motes/smoke/debris, the muzzle and impact, and the dynamic light.
- **Nova Beam** (176 controls) — the cast, where it leaves the hands, the column, the core/sheath/
  halo stack, the surface and its flow, the beam's colour, the coils, the shock discs, the charge
  and its intake, what the floor does, sparks/motes/steam/debris, release/impact/burn, and the two
  dynamic lights.
- **Voltaic Snare** (174 controls, 33 of them colours) — the cast and its footprint, the leash, the
  column, the tendrils, the rim arcs, the shared filament shape and flicker, the ribbon and its
  colour, the field on the floor, the burns, sparks/updraft/smoke/debris, throw/snap/hold, and the
  dynamic light.
- **Ember Bolt** (64 controls) — the cast, what it does, where it leaves the hand, the ball, what it
  sheds, where it lands, the light and the palette. The shortest ability folder in the panel, because
  the ability is nothing but emission parameters: `size`, `coreRate` and `coreLife` between them
  decide whether the head reads as a ball or as a streak, and `burstTurbulence` is what stops the
  impact reading as a solid orange sphere.
- **Training dummies** — how many targets, how far out they stand, their hit points and how long
  they stay down. `count` and `ringRadius` are read every frame by the system itself, so dragging
  either rebuilds or repositions the ring live.
- **Presets** save to `localStorage`, and can be duplicated, deleted, exported to JSON, imported
  from JSON, or reset to the shipped defaults.

Every ability exposes **every** colour it draws with, and none is derived from another: the crystal
palette, the bolt palette, the beam's four layers and its coils and discs, the ground marks, the
impact shells, the shockwave rings, the screen flashes, and a four-stop lifetime gradient
(`birth → early → late → death`) for each particle system. Tinting the fog without touching the ice,
or cooling the sparks to orange while the filaments stay blue, is a picker away.

Presets are plain snapshots of the settings tree, so an exported file is readable and editable by
hand.

Knobs worth knowing about, because they reshape their ability the most:

- `ice.heightCurve` — how late the ramp climbs; raise it and the field stays low until it explodes
  at the target. `ice.frontBias` below 1 crowds the crystals toward the impact point.
- `thunder.jitter` and `thunder.jitterScale` — how violently the bolt kinks, and how often.
  `thunder.strands` and `thunder.spread` set how wide the bundle reads, and `thunder.restrike`
  how hard it strobes. Those five carry the character of the effect.
- `beam.radius` and `beam.flare` — how heavy the column reads and how hard it opens out where it
  lands. `beam.charge` and `beam.lifetime` are the wind-up and the hold, which are what make this
  ability feel unlike the other three, and `beam.coreWidth` / `beam.coreFill` decide whether the
  layers stay separable or blow out to white.
- `snare.zoneRadius` — the one number the whole far cast is built on. It resizes the targeting
  circle, the tendrils, the rim arcs, the burnt field and the pillar's throat together, live.
  After that, `snare.snapTime` and `snare.height` carry the moment it opens, and `snare.tendrils` /
  `snare.rimArcs` / `snare.strands` decide how much of that footprint is actually lit.
- `zone.boundary` and `zone.snap` — how thick the far-cast circle's edge reads, and how hard it
  overshoots on the way out. Between them they decide whether the indicator feels like a UI overlay
  or like something the caster is doing.

---

## Performance notes

- Abilities, decals, bursts and particles are pooled, per type. Twelve casts in a row build at most
  **four** instances of an ability and then stop allocating.
- The whole crystal field is three draw calls regardless of crystal count; the cap is 288.
- A whole bolt is **two** draw calls regardless of filament count; the cap is 24 filaments at 72
  samples each. Nothing about the path touches the CPU, so `strands` is nearly free.
- A whole snare — leash, pillar, tendrils and rim arcs — is **two** draw calls plus one for the
  field, regardless of how many filaments are in it; the cap is 56 across the four roles. As with
  the bolt, none of the shape touches the CPU, so raising `tendrils` or `rimArcs` is nearly free.
  Its targeting circle is two more: one quad and one ring strip.
- A whole beam is **six** draw calls regardless of how many coils and discs are on it — three tube
  passes over one shared geometry, plus one instanced draw each for the coils, the discs and the
  charge orb. As with the bolt, none of the shape touches the CPU, so `coils` and `rings` are
  nearly free. It takes two of the six dynamic lights (the column and the caster's hands), so four
  concurrent beams would exhaust the pool; `LightPool.acquire()` returns null and every use of the
  handle is guarded.
- The six dynamic point lights are created at boot and parked at zero intensity rather than added
  and removed — changing the light count forces three to recompile every material.
- Shadow maps update exactly once per frame even though the scene is rendered several times.
- `renderer.compileAsync()` runs during boot so the first cast never stutters on shader compile.
- Pixel ratio is capped at 1.75; the depth and distortion buffers are half resolution.

Measured on a default cast: 32 draw calls idle, ~69 with a full ice field standing and ~49 with a
bolt in the air, ~1150 live particles. A snare standing with its cage, field and rim burns is ~45
draw calls and ~480 live particles, and arming its circle costs two. Four concurrent casts —
the pool's ceiling, whichever slots they came from — peaks at ~186 draw calls and five of the six
dynamic lights.

Live counters (FPS, live particles, instances, draw calls) are in the top-right of the HUD.

---

## The archive

`src/archive/` holds the previous incarnation of this project: a four-element bending sandbox
(fire, water, earth, air) cast along a freehand-drawn spline, plus a walk mode that let the avatar
ride the same stroke. None of it is imported by the live app, so Vite never bundles it.

It was retired because this build replaced path drawing with a linear skillshot, which removed the
input every one of those systems was built on. The raymarched flame and water surfaces in
particular are worth mining. See `src/archive/README.md` for what is in there and how to restore a
piece of it.

---

## Known rough edges

- Crystals are drawn with `transparent: true` and `depthWrite: true`. That is the right trade for
  near-opaque ice and it keeps the field from sorting through itself, but at low `ice.opacity` the
  sorting artefacts between overlapping spikes become visible.
- The eruption front is a straight line on a flat floor. Both assumptions are baked in — the ground
  is a single plane at y = 0, and the aim raycast targets that plane.
- The distortion pass runs with nothing writing to it. It costs a half-res clear per frame.
- The impact cluster is placed radially around the end point, so at very short cast distances it
  can overlap the band behind it more than it should.
- The far cast inherits the flat-floor assumption twice over: the circle is drawn on a single quad
  at `y = 0`, and the snare's tendrils and rim arcs are placed against that same plane. Neither
  would drape over a step.
- Both the targeting circle and the snare's field are additive, so the footprint brightens the
  floor rather than shading it. On a pale floor the boundary would need a non-additive pass under
  it to stay readable.

---

## Licence

Code is provided as-is for the purposes of this project. The bundled HDR probe and the character
FBX retain their original licences.
