# Digital Bike — project notes

Arcade downhill racing: from a mountain summit to the valley floor, through
snow, forest, canyon, mud, dunes and a village. See README.md for
architecture and run instructions. See DESIGN.md for the design and what was
deliberately left for later. Key facts:

- `spacetimedb/src/index.ts` — single-file module: schema + reducers + the
  30 Hz `race_tick` scheduled reducer (server-authoritative physics, bots,
  placings, progression).
- `client/` — Vite + TS + Three.js. `src/render.ts` builds the course mesh
  and draws riders; `src/main.ts` owns connection, input and UI state.
- After editing the module: `spacetime publish -y` then regenerate bindings:
  `spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path spacetimedb -y`
- `tools/check-track-sync.mts` PROVES the two track generators agree — run it
  (`cd client && npx tsx ../tools/check-track-sync.mts`) after touching
  either one.
- THE TRACK GENERATOR IS DUPLICATED, and it is the one thing that must stay
  in lockstep: the block at the top of `spacetimedb/src/index.ts` and
  `client/src/track.ts` must produce identical segments from the same
  `(courseId, seed)`. Only those two numbers go on the wire. A divergence
  means the rider you see is not the rider being simulated. The PRNG
  (mulberry32, 32-bit integer maths) is part of that contract — do not
  "improve" it.
- Riders live in TRACK SPACE on both sides: `s` along the centreline (which
  is also the race position), `n` across it, `z` as world altitude. The
  renderer converts with `trackPoint()`; the lateral axis is the LEFT normal
  (`lateral()`), and its sign has to match the module's `n += v·sin(yaw)` or
  every corner is mirrored.
- Handling is deliberately TIGHT: the rider's steering input is clamped to
  the turn the tyres actually have left once the corner has taken its share
  (`turnBudget`), so the bike never slides around underneath you. A slide is
  something you ASK for — hold HOP with the bars turned and you drift, which
  rotates `DRIFT_TURN`x tighter than grip allows and charges a mini-turbo you
  cash by releasing the button. Two numbers govern whether drifting is worth
  doing at all: `GRIP_ACCEL` (how tight a corner grip alone can take) and the
  `MINI_TURBO`/`DRIFT_SCRUB` pair. Both were set by MEASURING laps with
  `client/harness-lap.mjs` — with grip too high, drifting was slower than not
  bothering. Re-measure both `drift` and `nodrift` after touching them.
- An ordinary landing never crashes you, it costs speed; only a boulder at
  pace or a bailed trick puts you on the floor. Minor contacts `bonk`
  (slowed and spun, still riding) rather than crash. Measuring showed twelve
  of fourteen crashes per lap were landings, which is a racer that stops
  being a racer.
- Physics constants live in the module; `client/src/config.ts` mirrors only
  what the HUD needs. Bot difficulty rides one continuous skill dial (0..120
  — EASY 40 · NORMAL 80 · HARD 120; `lobby.botSkill` 255 = derive from
  `botLevel`), the same shape Digital Tennis uses.
- Character roster and rig are SHARED with digital-tennis (and digital-quiz):
  `client/src/characters.ts` is a VERBATIM copy of that game's file, and
  `client/src/rig.ts` is lifted from its `render.ts` (textures, `buildHair`/
  `buildBody`, `applyCharacter`/`applyPhysique`, `makePlayerRig`, the pose
  library, `initCharacterPreviews`). Change a character or the rig there and
  copy it across, or the same person stops looking the same in the two games.
  Bike-specific numbers deliberately live OUTSIDE that file, in
  `client/src/bikes.ts` (`CHAR_RIDE`), mirroring `CHAR_RIDE` in the module.
- Unlocks (riders, bikes, hills) are DERIVED from account counters on demand
  and never stored: the whole persistence cost is `races`/`wins`/`podiums`/
  `botWins`/`tricks`/`topSpeed`/`cupWins`/`courseWins` on `account`. The
  tables live in the module (`CHAR_UNLOCKS`/`BIKE_UNLOCKS`/`COURSE_UNLOCKS`)
  and are mirrored for display in `client/src/unlocks.ts` — keep in sync, and
  mirror any new account column in `profiles/store.mjs` COLUMNS and the
  `restore_account` args too.
- Progression is awarded in `finishRace`, which captures the roster BEFORE
  the places are released. Award after that and every race silently pays out
  nothing (the same trap Digital Tennis documents).
- `profiles/` is a separate service that mirrors `account` into SQLite and
  restores it after a wipe, so SpacetimeDB stays a disposable game engine. It
  syncs on `account.rev` — bump `rev` on ANY account write worth keeping, or
  the change never leaves the engine. `restore_account` is gated on the JWT
  issuer `digital-bike-profiles`, mintable only with the server's signing key.
- Firebase Auth is load-bearing, not cosmetic: the restore is keyed on
  `identity`, which is only stable across a wipe because it comes from the
  token's iss+sub. All the Digital games share ONE Firebase project, so an
  account is the same person in each of them.
- Lobby manners are SHARED with digital-tennis/-golf/-racing — keep them
  alike: `player.ready` + `set_ready` (a signal, not a gate: a race starts
  itself when the last rider readies up), host-only `kick_player` (sets
  `player.kicked` on the way out so the client can toast), and a host Start
  that works with seats still unready.
- Championship hook (digital-championship): `lobby.championshipLeg` marks a
  room the hub's relay opened via `create_championship_room` (gated on
  `RELAY_ISSUER`). The finishing order is written ONCE to `leg_result`
  (`recordLegResult`) — never write a second row for a leg.
- A scheduled reducer only runs while the module is awake, which means a
  CLI-only test (`spacetime call` + `spacetime sql`) will show a race frozen
  on the gate. Drive it from a real websocket client — `client/harness.mjs`
  is exactly that, and it is the fastest way to test physics changes.
- Two browser tabs are ONE player (shared Firebase/localStorage session). For
  local 2-player testing use two browser profiles, or `?seat=2` on the
  no-Firebase fallback path.
- Local server is `spacetime start`; DB name `digital-bike`.
- The module entrypoint may ONLY export SpacetimeDB constructs (reducers,
  schema default) — exporting plain constants breaks publish.
