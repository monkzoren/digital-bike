# Digital Bike

**Race downhill from a mountain summit to the valley floor.** Arcade physics
with a mountain-bike/dirt-bike feel, rally-style drifts, big air and tricks,
through a mountain that changes environment as you drop through it: alpine
snow, pine forest, red-rock canyon, mud, dunes, and a finish through a
village.

SpacetimeDB is the entire backend — rooms, matchmaking-by-code, the bot
riders, and the authoritative 30 Hz simulation all run inside a SpacetimeDB
module. The client is a Vite + TypeScript + Three.js renderer with a chase
camera. It is built on the **Digital Tennis** foundation: same architecture,
same characters, same UI language, same accounts.

```
client/  (Vite + TS, Three.js)            spacetimedb/  (TypeScript module)
┌──────────────────────────────┐         ┌─────────────────────────────────┐
│ send input:                  │ ──────► │ tables: lobby, race, player     │
│   set_input(dirX,dirY,btn)   │reducers │ reducers: create/join/leave,    │
│ render from subscriptions:   │         │   set_ready, start, rematch     │
│   lobby / race / player rows │ ◄────── │ race_tick (scheduled, 30 Hz):   │
│ + the SAME track generator   │  subs   │   bike physics, bots, features, │
│   rebuilt from (course,seed) │         │   placings, XP/MMR, cup points  │
└──────────────────────────────┘         └─────────────────────────────────┘
```

## The game

- **Server-authoritative.** Clients send a held direction and a button
  bitmask. The scheduled `race_tick` reducer simulates every rider — gravity
  down the slope, drag, grip and slip, jumps, tricks, landings, crashes,
  drafting, placings — so nobody can cheat their way down the hill.
- **Controls:** stick/**WASD** up to tuck and pedal, down to brake (and in the
  air, to bring the nose up), left/right to steer — hold it past the grip
  limit and the bike **drifts**. **HOP** (Space/J/gamepad A) bunny-hops and,
  on a kicker lip, *times your launch*. **TRICK** (K/Shift/B) held in the air
  with a direction throws a whip, flip, superman or tailwhip. **BOOST**
  (L/Ctrl/X) spends the meter.
- **Timing is the skill.** Press HOP right on the lip of a kicker for a
  perfect pop (and a boost bonus); press the throttle exactly as the gate
  drops for a **holeshot** (early is a jump start, and it costs you). Land
  with the bike's nose matched to the slope and you keep all your speed —
  sloppy scrubs it, bad crashes.
- **The boost economy.** Drifting, clean landings, landed tricks, boost pads
  and drafting fill the meter; spending it raises acceleration and top speed.
  Crashing empties it. Every corner is "how close to the edge do I want to
  ride".
- **Six biomes, five hills.** Each biome has its own grip, rolling resistance,
  corridor width, hazards and look — snow is fast and slidey, forest is tight
  and high-grip, mud is the loosest surface on the mountain, dunes drag at
  you, the village is flat-out tarmac. A course is a named biome plan whose
  geometry is generated from a seed, so a hill is recognisably itself every
  time without ever being memorised stride for stride.
- **18 riders, 6 bikes.** The roster is the Digital Tennis roster — six pros
  and a wacky dozen, each with a fully unique 3D body, shown as a live
  animated render on the select screen — so your character is the same person
  in both games. Bikes are shapes rather than tiers: TRAIL, DOWNHILL, DIRT,
  BMX, FAT, RALLY. Your final stats are **character × bike**.
- **Modes:** **FREE RIDE** (solo or against bots), **QUICK RACE** (a room code,
  up to 8 riders, bots filling the empty slots), and **CUP** (three hills back
  to back, points `10-8-6-5-4-3-2-1` per finish, a champion on points).
- **Bot difficulty:** EASY / NORMAL / HARD, riding a continuous 0–120 skill
  dial. Easier bots read the track later, sit further off the racing line,
  brake worse, mistime their hops and make more mistakes.
- **Ready up, host Start, host kick** — the same lobby manners as the other
  Digital games. A race starts itself when the last rider readies up, and the
  host can start anyway so an AFK seat never holds a room hostage.
- **Accounts, XP and MMR:** everyone is signed in automatically (Firebase
  anonymous auth), so there is no wall in front of the game — but the identity
  is stable, which is what lets progress persist. Every race pays XP (half
  rate with bots on the grid); MMR is pairwise Elo across the field and only
  moves in an all-human race. **SIGN IN** links a guest account to Google,
  keeping the same identity and everything on it.
- **Unlocks:** riders, bikes and hills are earned — races finished, wins,
  podiums, tricks landed, a top speed, a cup. Locked cards stay browsable and
  show exactly what opens them, with live progress; the checks are enforced
  server-side.
- **Custom physics:** any room can tweak gravity, grip, speed and air.
- **Graphics options:** press **G** or the ⚙ button — render resolution,
  shadows, anti-aliasing, particles, boost trail, scenery, the film grade and
  an FPS limit, with a live FPS readout. **F** or ⛶ for fullscreen. Gamepads
  and touch controls (a floating stick plus HOP/TRICK/BOOST) are supported.

## Prerequisites

- Node.js 20+
- [SpacetimeDB CLI](https://spacetimedb.com/install)

## Run locally

```bash
# 1. Start the local SpacetimeDB server
spacetime start

# 2. Publish the module (from the repo root; uses spacetime.json)
spacetime publish -y

# 3. Regenerate client bindings after any module change
spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb -y

# 4. Run the client
cd client && npm install && npm run dev
```

Open http://localhost:5173 to ride. **Two players on one machine needs two
identities, and two tabs are not two identities** — a player is an account,
and both the Firebase session and the fallback token live in browser-wide
storage. Use two browser profiles (or one normal and one private window), or,
when running without Firebase, add `?seat=2` to the second tab.

### Testing the simulation without a browser

`client/harness.mjs` and `client/harness-cup.mjs` are headless websocket
clients that start a race (or a whole cup), ride it, and print the rider rows
every few ticks:

```bash
cd client && npx tsx harness.mjs
```

Use them rather than `spacetime call` + `spacetime sql`: **a scheduled reducer
only runs while the module is awake**, so a CLI-only test shows a race frozen
on the start gate and tells you nothing.

## Configuration

- `client/src/config.ts` reads `VITE_SPACETIMEDB_URI` and
  `VITE_DATABASE_NAME` (defaults: `ws://localhost:3000`, `digital-bike`).
- **Accounts are optional.** Set `FIREBASE_*` in `.env` (see `.env.example`)
  and `FIREBASE_PROJECT` in `spacetimedb/src/index.ts` to the same project id.
  All the Digital games share one project, so an account is the same person in
  each of them. The values are baked into the JS bundle at BUILD time, so the
  client must be rebuilt after setting them. Without them the game still
  works — sign-in is hidden and progress stays on a device-local identity.
- **The track generator is duplicated on purpose** — the block at the top of
  `spacetimedb/src/index.ts` and `client/src/track.ts` must produce identical
  segments from the same `(courseId, seed)`. Only those two numbers go on the
  wire; everything else is rebuilt on both sides. Keep them in sync.
- **SpacetimeDB is a disposable game engine.** Rooms, races and standings die
  with the room that owns them, and the database is expected to be wiped on a
  breaking schema change. The `profiles` service (see `profiles/README.md`)
  keeps player progression out of that blast radius: it mirrors the `account`
  table into a SQLite file on its own volume and seeds it back after a wipe,
  reconciling on a per-player `rev` counter. `spacetimedb/publish.sh` refuses
  to clear the database without `ALLOW_CLEAR=1`.

## Self-hosting with Docker Compose

```bash
git clone https://github.com/monkzoren/digital-bike.git
cd digital-bike
cp .env.example .env
docker compose up -d --build
```

Open `http://your-server:8080`. Four services come up: `spacetimedb` (the
server), `module-publisher` (builds and publishes the module, then idles),
`client` (nginx serving the built web client, which also proxies the game
socket at `/v1` so one domain serves everything), and `profiles` (the
progression mirror). This is the same stack as Digital Tennis — see that
repo's README for the Coolify walkthrough and the troubleshooting table,
which apply here unchanged.

## Design

`DESIGN.md` is the design document: what carries over from Digital Tennis and
what does not, the game design, the track generator contract, the physics
model, the schema, and what was deliberately left for later (ghosts,
spectating, a career season, betting on races).
