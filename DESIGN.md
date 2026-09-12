# Digital Bike — design

**Race downhill from a mountain summit to the valley floor.** Arcade physics,
mountain-bike/dirt-bike feel, rally-style drifts, big air and tricks, through
a mountain that changes environment as you descend: alpine snow, pine forest,
red-rock canyon, mud, dunes, and the finish through a village.

Same foundation as **Digital Tennis**: SpacetimeDB is the whole backend, the
client is Vite + TypeScript + Three.js, the *people* are the same roster with
the same rig, and the shell around the game (name gate, accounts, lobbies by
code, ready-up/kick manners, graphics options, touch controls, the profiles
service) is the same in both games.

---

## 1. What carries over, and what does not

| Tennis thing | Bike |
|---|---|
| SpacetimeDB module, single `src/index.ts`, scheduled tick | **Same** — `race_tick` at 30 Hz, server-authoritative |
| `lobby` / `player` / `chat` / `account` / `match_log` / `session` tables | **Same shape**, race-flavoured columns |
| Lobby codes, join-by-link, public browser, ready-up, host kick | **Verbatim port** — lobby manners are shared across the Digital games |
| Firebase auth + `profiles/` SQLite mirror + `restore_account` | **Verbatim port** (issuer `digital-bike-profiles`) |
| `characters.ts` roster + rig (`buildBody`/`buildHair`/poses) | **Verbatim copy** — the same person must look the same in every Digital game. Bike-specific numbers live in a *separate* `BIKE_STATS` table keyed by character id, so the shared file stays byte-identical |
| Graphics panel, touch stick, gamepad, fullscreen, update-check | **Verbatim port** |
| Court geometry duplicated module↔client | Becomes **track generation** duplicated module↔client (§3) — the one piece that must stay in lockstep |
| Ball physics, tennis scoring, serve, doubles | **Gone** — replaced by bike physics and race placings |
| Tournament brackets | Becomes a **Cup**: 3 stages, points per finish, standings |
| Betting, spectator grounds, career season, VAR replays | **Not in v1.** They are tennis-shaped luxuries; the racing equivalents (ghosts, free-cam, a season) are noted in §9 as follow-ups rather than ported for the sake of parity |

The deliberate cut: tennis's 6 800-line `main.ts` carries a lot of surface
(betting books, the World Tour map, career-pro creator, doubles rotation) that
would have to be *redesigned*, not ported, to mean anything in a racer.
Building those badly costs more than leaving them out, so v1 ships the shell,
the roster, and a racer that is actually good, and the season sits on top later
using exactly the same account columns.

---

## 2. Game design

### The run
A course is a **point-to-point descent**, ~4–6 km, 2–4 minutes, no laps. Up to
**8 riders** on one course, empty slots optionally filled by bots. The field
starts on a gate line, a 3-2-1 drops, and the first rider to the valley wins.

### Controls (one stick, three buttons — the tennis input surface)
| Input | Action |
|---|---|
| Stick / WASD **up** | Tuck + pedal (accelerate, less drag) |
| Stick **down** | Brake (and, in the air, rotate nose up) |
| Stick **left/right** | Steer; held hard past the grip limit → **drift** |
| **HOP** (Space / J / A) | Bunny-hop. On a kicker lip, *timing sets the launch* |
| **TRICK** (K / Shift / B) | Hold in the air + a stick direction: whip, flip, superman, tailwhip |
| **BOOST** (L / Ctrl / X) | Spend the boost meter |

The tennis DNA is the **timing gate**: tennis made contact timing decide shot
quality; bike makes it decide the *hop off a lip*, the *holeshot* on the start
lights, and the *landing angle*. Same "press at the right instant, be rewarded"
loop, same `swingTicks`-style press window on the server.

### Handling: tight, not loose

The bike goes where you point it. The rider's steering is clamped to the turn
the tyres actually have left once the corner itself has taken its share, so it
can never ask for more grip than it has and **never slides around underneath
you**. A slide is something you ask for.

Steering is **analog** (a percentage on the wire, not a direction): a stick
gives shallow corrections directly, and on the keyboard the lock ramps in as
you hold, so a tap is a nudge and a hold is full lock.

### The drift

Hold **HOP** with the bars turned and the bike hangs the tail out: it rotates
far tighter than grip allows and charges a **mini-turbo** — blue, orange,
purple on the boost gauge — which you cash by **releasing the button**. The
drift ends on release, never on the stick crossing centre, so it is a
commitment rather than a twitch. Most of the slip angle is the tail hanging
out; only a fraction carries you across the track.

Two numbers decide whether drifting is worth doing: how tight a corner grip
alone can take (`GRIP_ACCEL`), and what the turbo pays against what the slide
costs. Measured over full laps: drifting the corners that want it is ~3 s a
lap faster than never drifting, and drifting *everything* is ~5 s slower than
that. The mechanic rewards judgement, which is the point.

### Speed economy
- Gravity does the work: steeper = faster. The course slope is the throttle.
- **Tuck** cuts drag; **brake** scrubs; cornering scrubs with the square of
  how much you are asking of the tyres.
- **Drift** scrubs more speed but rotates the bike far faster than grip allows
  and *fills the boost meter* — rally logic: give up speed now to buy it back.
- **Boost meter** (0–1000) fills from drift, clean landings, landed tricks and
  drafting; spending it raises both acceleration and top speed.
- **Knocks vs crashes.** Most contact **bonks** you — slowed, spun, still
  riding: trunks across the track, baled corners, a clipped boulder, an ugly
  landing. Only two things put you on the floor for ~1.4 s: a boulder taken at
  pace, and bailing out of a trick you committed to. Both are chosen. (Before
  this split, twelve of every fourteen crashes in a measured lap were ordinary
  landings — a racer that keeps stopping is not a racer.)

### Air and tricks
Kickers, drops and crests launch you. In the air there is no grip: you pick a
**pitch** with the stick and optionally hold TRICK + a direction for a rotation
that pays boost *only if you land it*. Landing is graded on how close your
pitch is to the slope you land on: perfect keeps all your speed and pays boost,
sloppy scrubs, bad crashes. Big air is a bet.

### Courses and environments
Six biomes, each with its own grip, roughness, visual kit and hazards:

### Track furniture

Kickers to time · whoops that buck you · gates that pinch · boost pads ·
boulders to read or hop · standing water that takes your grip · trunks lying
**across** the track to jump · trunks lying **along** it to **grind** (they
hold your line, push you along and pay boost) · baled corners you can throw
the bike at.

| # | Biome | Grip | Feel |
|---|---|---|---|
| 0 | ALPINE — snow above the treeline | low | fast, slidey, wide, huge cornices to jump |
| 1 | FOREST — pine singletrack | high | narrow, tight turns, trees punish drift |
| 2 | CANYON — red rock rally road | med | wide sweepers, banked, big drops |
| 3 | MUD — rain-soaked switchbacks | lowest | ruts, puddles, low visibility |
| 4 | DUNES — desert sand | med-low | rollers and whoops, sand drags you down |
| 5 | VILLAGE — the finish through town | highest | tarmac, cobbles, flat-out run-in |

A **course** (`courseId`) is a named, fixed biome plan + length + difficulty.
Its actual geometry comes from a `seed`, so *Alpine Descent* is recognisably
itself every time but a race can also be rolled fresh.

### Bikes
A second pick alongside the character, the way tennis picks a court: 6 bikes,
each a shape rather than a tier — **TRAIL** (balanced), **DOWNHILL** (fast,
heavy, poor accel), **DIRT** (accel + air), **BMX** (trick machine, low top
end), **FAT** (grip anywhere, slow), **RALLY** (drift specialist). Stats:
`top`, `accel`, `grip`, `air`, `weight`.

Final rider stats = **character × bike** (each a multiplier around 1.0), so a
heavy character on a heavy bike really is a runaway train.

### Modes
- **FREE RIDE / TIME TRIAL** — solo (or with bots), clock only.
- **QUICK RACE** — a lobby code, up to 8 riders, bots fill the rest.
- **CUP** — 3 courses back to back, points `10-8-6-5-4-3-2-1`, running
  standings between stages, a champion at the end.

### Progression
Same account as tennis: XP every race (half rate with bots on the grid), MMR
by **pairwise Elo across the field** (only moves in all-human races), levels,
record. Unlocks are **derived from account counters, never stored**: races,
wins, podiums, tricks landed, top speed, cup wins — feeding character, bike
and course unlocks exactly like `CHAR_UNLOCKS` in tennis.

---

## 3. The track: the one thing that must stay in lockstep

Tennis duplicates court constants in two files. Bike duplicates a **generator**.

```
seed (u32) + courseId (u8)  ──►  mulberry32 PRNG  ──►  Segment[]
```

A course is an array of fixed-length segments (`SEG_LEN = 40 m`), each:

```ts
{ curv, pitch, halfWidth, biome, feature, featureArg }
```

- `curv` — curvature in rad/m; integrating it gives the heading, and
  integrating heading gives the centreline (x, y).
- `pitch` — downhill angle; integrating `sin(pitch)` gives altitude `h(s)`.
- `halfWidth` — the rideable corridor; past it is rough, past it + margin is a
  crash.
- `feature` — `NONE · KICKER · WHOOPS · ROCKS · DROP · NARROW · BOOSTPAD`.

The module needs only `slopeAt(s)`, `curvAt(s)`, `widthAt(s)`, `gripAt(s)` and
the feature at `s` — all O(1) array lookups. The client needs the same arrays
to build the mesh. **Both generate them from the seed with the same integer
PRNG and the same constants**: `spacetimedb/src/index.ts` is the source of
truth, `client/src/track.ts` mirrors it, and a mismatch means the rider you see
is not the rider the server simulates. This is the bike equivalent of "court
geometry constants are duplicated — keep in sync", and it is called out in
`CLAUDE.md` for exactly that reason.

Only `seed` and `courseId` ever go on the wire. No track data is transmitted.

---

## 4. Physics model (server, 30 Hz)

State per rider lives in **track space**, not world space — it keeps the maths
cheap, the collisions trivial, and the standings a single sort:

| Field | Meaning |
|---|---|
| `s` | distance along the centreline (m) — also the race position |
| `n` | lateral offset from the centreline (m) |
| `v` | speed along the bike's heading (m/s) |
| `yaw` | heading relative to the track tangent (rad) |
| `z`, `vz` | world altitude and vertical speed (airborne when `z > h(s,n)`) |
| `pitch` | bike nose angle (air control + landing grade) |
| `lean` | visual roll, driven by steer and lateral load |
| `boost` | 0–1000 meter |
| `crashTicks`, `airTicks`, `trickKind`, `trickSpin` | state machines |

Per tick:

1. **Longitudinal** `v += (G·sin(pitchTrack) + pedal − brake − drag(v) − roll(surface) − cornerScrub) · dt`
2. **Steering** `yaw` chases the stick, rate limited by speed; lateral demand is
   `v²·curv − v·yawRate`; demand over `grip·G` → **slip**, which scrubs speed
   and fills boost.
3. **Lateral** `n += v·sin(yaw)·dt` plus the slip push. Corridor checks:
   rough outside `halfWidth`, crash outside `halfWidth + CRASH_MARGIN`.
4. **Vertical** airborne: `vz -= G·dt`, `z += vz·dt`, land when `z ≤ h(s)`;
   grounded: `z = h(s)` and a kicker/drop/hop sets `vz`.
5. **Features** — kicker lips launch (with the hop-timing multiplier), whoops
   shake and can buck you, rocks are point collisions, boost pads pay boost.
6. **Landing grade** — `|pitch − slope|` picks perfect / ok / crash, and pays
   out any completed trick.
7. **Finish** — `s ≥ length` stamps the finish tick, assigns the next placing.

All of it is pure arithmetic on the row — no allocation, no lookups beyond the
segment array — so eight riders at 30 Hz is eight row writes a tick, the same
order of wire cost as a tennis match.

### Bots
Bots run the identical physics; only the input differs. A bot reads the track a
fixed distance ahead, picks a racing line (apex-weighted `n` target), brakes
for corners it cannot hold, hops kickers with a skill-dependent timing error,
attempts tricks above a skill threshold, and makes occasional mistakes. One
continuous **skill dial 0–120** (EASY 40 · NORMAL 80 · HARD 120) scales
reaction distance, timing error, line quality and mistake rate — the same dial
tennis uses, so the difficulty UI ports unchanged.

---

## 5. Schema

```
lobby       code, hostId, mode(0 race · 1 cup), status, courseId, seed,
            botLevel/botSkill, laps?, isPublic, botFill, stage, stages,
            physics multipliers (gravityMul/gripMul/speedMul/airMul)
race        lobbyId, stage, state, startTicks, finishedMask, leaderId,
            elapsedTicks, courseId, seed
player      identity, name, lobbyId, raceId, characterId, bikeId,
            s, n, v, yaw, z, vz, pitch, lean, boost, crashTicks, airTicks,
            trickKind, trickSpin, place, finishTicks, dirX, dirY, btnMask,
            ready, kicked, spectator, online, isBot, cupPoints
account     …tennis columns… + races, wins, podiums, cupWins, tricksLanded,
            topSpeed, bestTimes (per course), cupStage/cupRound
chat / chat_guard / match_log / session / tick_timer / grace_timer / reap_timer
```

Everything else (halt-on-disconnect with a grace window, reap timers, the
`rev`-driven profile mirror) is the tennis mechanism unchanged.

---

## 6. Client

```
client/src/
  config.ts      URI, db name, tick rate, mirrored physics/progression constants
  track.ts       the generator mirror + world-space helpers for the renderer
  characters.ts  VERBATIM copy of the tennis roster (do not diverge)
  bikes.ts       bike roster + BIKE_STATS per character
  courses.ts     the named course table + biome presentation
  rig.ts         the tennis rig lifted out of render.ts (body/hair/poses)
  render.ts      Three.js: track mesh, biome dressing, rider-on-bike, chase cam
  main.ts        connection, screens, input, HUD
  auth.ts graphics.ts touch.ts update-check.ts   (verbatim)
```

**Camera**: chase cam behind and above the bike, pulled back with speed, rolled
with lean, snapping to a trailing look in the air — the racer equivalent of the
tennis TV camera.

**Rendering the track**: the centreline is converted to a ribbon mesh once per
race (a few thousand triangles), dressed per biome with instanced trees, rocks,
banners and gates, and lit with the same shadow/quality switches the tennis
graphics panel already drives. The rider is the tennis rig, posed on a bike
(crouch, lean, whip, trick poses) instead of holding a racket.

**Prediction**: rows arrive at 30 Hz; the client extrapolates `s`/`n`/`z` from
the last row exactly as tennis extrapolates the ball, so motion is smooth
without the client ever being authoritative.

---

## 7. Build & run

Identical to tennis:

```bash
spacetime start
spacetime publish -y
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb -y
cd client && npm install && npm run dev
```

`docker compose up -d --build` brings up spacetimedb + module-publisher +
client + profiles, same as tennis, on `digital-bike`.

---

## 8. Build order

1. Module: schema, track generator, physics, race flow, bots, progression.
2. Bindings + client shell (connection, name gate, account chip, menus).
3. Renderer: track mesh, biomes, rider-on-bike, chase cam.
4. HUD, results, cup standings, graphics/touch, polish.

## 9. Deliberately later

Ghost replays · spectator free-cam · a career season on the same account
columns · betting on races · split lines and shortcuts · weather · a
championship-hub relay leg (`lobby.championshipLeg`, the same trick tennis
uses) so the bike sits in the cross-game championship.
