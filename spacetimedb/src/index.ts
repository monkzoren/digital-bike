import { schema, table, t, SenderError, ScheduleAt, type ReducerCtx } from 'spacetimedb/server';
import { Identity } from 'spacetimedb';

// ---------------------------------------------------------------------------
// DIGITAL BIKE — server-authoritative downhill racing.
//
// The whole game lives in this file, the way Digital Tennis does: schema,
// reducers, and the 30 Hz `race_tick` that simulates every rider. Clients
// send held direction + button presses and render rows; nothing else.
//
// The one thing that MUST stay in lockstep with the client is the TRACK
// GENERATOR below (mirrored in client/src/track.ts). Only `courseId` and
// `seed` ever go on the wire — both sides rebuild the identical course from
// them, so a divergence means the rider you see is not the rider simulated.
// ---------------------------------------------------------------------------

// Simulation rate. Every tick-counted constant is derived through `ticks()`,
// so changing TICK_HZ rescales the game clock and keeps the feel identical.
// Mirrored as TICK_HZ in client/src/config.ts.
const TICK_HZ = 30;
const TICK_MICROS = BigInt(Math.round(1_000_000 / TICK_HZ));
const DT = 1 / TICK_HZ;
const ticks = (seconds: number) => Math.max(1, Math.round(seconds * TICK_HZ));

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

// ---------------------------------------------------------------------------
// Track generation — MIRRORED in client/src/track.ts. Keep in sync.
//
// A course is an array of fixed-length segments. Integrating each segment's
// curvature gives the heading; integrating the heading gives the centreline;
// integrating sin(pitch) gives the altitude. The module only ever needs the
// per-segment numbers (all O(1) lookups); the client needs the same numbers
// to build the mesh.
// ---------------------------------------------------------------------------
const SEG_LEN = 40; // metres per segment

// Biomes, in descent order down the mountain.
const BIO_ALPINE = 0;
const BIO_FOREST = 1;
const BIO_CANYON = 2;
const BIO_MUD = 3;
const BIO_DUNES = 4;
const BIO_VILLAGE = 5;

interface Biome {
  grip: number; // lateral hold (1 = tarmac)
  roll: number; // rolling resistance coefficient
  curv: number; // how twisty this biome gets (rad/m ceiling)
  width: number; // nominal half-width of the rideable corridor
  rough: number; // how much the surface shakes / bucks you
  kicker: number; // per-segment feature odds
  rocks: number;
  whoops: number;
}

// Mirrored in client/src/track.ts (BIOMES) — keep in sync.
const BIOMES: Biome[] = [
  // ALPINE — wide, fast, slidey snow above the treeline
  { grip: 0.72, roll: 0.10, curv: 0.0060, width: 15, rough: 0.35, kicker: 0.22, rocks: 0.06, whoops: 0.05 },
  // FOREST — tight pine singletrack, high grip, no room for mistakes
  { grip: 1.02, roll: 0.13, curv: 0.0135, width: 8, rough: 0.45, kicker: 0.10, rocks: 0.20, whoops: 0.08 },
  // CANYON — red rock rally road, big banked sweepers and drops
  { grip: 0.88, roll: 0.12, curv: 0.0085, width: 13, rough: 0.40, kicker: 0.20, rocks: 0.12, whoops: 0.06 },
  // MUD — rain-soaked switchbacks, the loosest surface on the mountain
  { grip: 0.62, roll: 0.20, curv: 0.0120, width: 10, rough: 0.55, kicker: 0.08, rocks: 0.10, whoops: 0.14 },
  // DUNES — desert sand, rollers and whoops, the sand drags at you
  { grip: 0.76, roll: 0.26, curv: 0.0070, width: 16, rough: 0.60, kicker: 0.16, rocks: 0.05, whoops: 0.26 },
  // VILLAGE — cobbles and tarmac, the flat-out run to the line
  { grip: 1.10, roll: 0.08, curv: 0.0095, width: 9, rough: 0.20, kicker: 0.12, rocks: 0.08, whoops: 0.04 },
];

// Segment features.
const F_NONE = 0;
const F_KICKER = 1; // a ramp: hop the lip for air
const F_WHOOPS = 2; // rollers that shake you and can buck you into the air
const F_ROCKS = 3; // point obstacles at featureArg lateral offset
const F_DROP = 4; // the ground falls away — free air, land it straight
const F_NARROW = 5; // a gate: the corridor pinches
const F_BOOST = 6; // a boost pad on the racing line

interface Segment {
  curv: number; // rad/m, + = left
  pitch: number; // downhill angle, radians (always > 0)
  halfWidth: number;
  biome: number;
  feature: number;
  featureArg: number; // rocks: lateral offset · kicker: ramp strength
}

// Courses — named, fixed biome plans. The geometry comes from the seed, so a
// course is recognisably itself every time but never memorised stride for
// stride. Mirrored in client/src/courses.ts — keep names/ids in sync.
interface Course {
  id: number;
  segs: number; // length in segments (× SEG_LEN metres)
  plan: number[]; // biomes, in order, each taking an equal share
  difficulty: number; // 0..2 — scales curvature and feature density
}
const COURSES: Course[] = [
  { id: 0, segs: 108, plan: [BIO_ALPINE, BIO_ALPINE, BIO_FOREST, BIO_FOREST, BIO_VILLAGE], difficulty: 0 },
  { id: 1, segs: 120, plan: [BIO_FOREST, BIO_CANYON, BIO_CANYON, BIO_MUD, BIO_VILLAGE], difficulty: 1 },
  { id: 2, segs: 132, plan: [BIO_ALPINE, BIO_MUD, BIO_MUD, BIO_FOREST, BIO_FOREST, BIO_VILLAGE], difficulty: 2 },
  { id: 3, segs: 126, plan: [BIO_CANYON, BIO_DUNES, BIO_DUNES, BIO_CANYON, BIO_VILLAGE], difficulty: 1 },
  { id: 4, segs: 150, plan: [BIO_ALPINE, BIO_FOREST, BIO_CANYON, BIO_MUD, BIO_DUNES, BIO_VILLAGE], difficulty: 2 },
];
const COURSE_COUNT = COURSES.length;

// mulberry32 — 32-bit integer PRNG. Identical output in every JS engine, so
// the client mirror generates a byte-identical course. Do not "improve" it.
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a whole course. Cheap enough to call per race on the server and once
// per race on the client (a few hundred segments of arithmetic).
function buildCourse(courseId: number, seed: number): Segment[] {
  const c = COURSES[courseId] ?? COURSES[0];
  const rng = makeRng(seed ^ (courseId * 0x9e3779b1));
  const segs: Segment[] = [];
  const diff = 0.8 + c.difficulty * 0.22;
  // Curvature is a random walk toward a target that is re-rolled every few
  // segments: that is what makes corners feel like corners instead of noise.
  let curv = 0;
  let curvTarget = 0;
  let hold = 0;
  let straightRun = 0;
  for (let i = 0; i < c.segs; i++) {
    const u = i / c.segs;
    const biome = c.plan[Math.min(c.plan.length - 1, Math.floor(u * c.plan.length))];
    const b = BIOMES[biome];
    if (hold <= 0) {
      const maxC = b.curv * diff;
      // After a long straight, force a real corner.
      const forced = straightRun > 4;
      const mag = (forced ? 0.45 + rng() * 0.55 : rng() * rng()) * maxC;
      const dir = rng() < 0.5 ? -1 : 1;
      curvTarget = mag * dir;
      hold = 2 + Math.floor(rng() * 4);
      straightRun = Math.abs(curvTarget) < b.curv * 0.2 ? straightRun + hold : 0;
    }
    hold--;
    curv = lerp(curv, curvTarget, 0.45);

    // Slope: steepest in the upper third, easing out to the valley floor.
    const steep = 0.30 - 0.16 * u;
    const pitch = clamp(steep + (rng() - 0.5) * 0.11, 0.05, 0.42);

    // Corridor: tighter in a corner, and pinched further by a NARROW gate.
    const halfWidth = b.width * (0.82 + rng() * 0.36) * (1 - Math.min(0.3, Math.abs(curv) / b.curv * 0.3));

    // Features. The first three segments (the gate) and the last two (the
    // run to the line) are always clean.
    let feature = F_NONE;
    let featureArg = 0;
    if (i > 2 && i < c.segs - 2) {
      const r = rng();
      const dens = 0.85 + c.difficulty * 0.2;
      if (r < b.kicker * dens) {
        feature = F_KICKER;
        featureArg = 0.7 + rng() * 0.75; // ramp strength
      } else if (r < (b.kicker + b.rocks) * dens) {
        feature = F_ROCKS;
        featureArg = (rng() * 2 - 1) * halfWidth * 0.75;
      } else if (r < (b.kicker + b.rocks + b.whoops) * dens) {
        feature = F_WHOOPS;
        featureArg = 0.6 + rng() * 0.7;
      } else if (r < (b.kicker + b.rocks + b.whoops) * dens + 0.05) {
        feature = F_DROP;
        featureArg = 0.8 + rng() * 0.9;
      } else if (r < (b.kicker + b.rocks + b.whoops) * dens + 0.09) {
        feature = F_NARROW;
        featureArg = 0.45 + rng() * 0.2;
      } else if (r < (b.kicker + b.rocks + b.whoops) * dens + 0.13) {
        feature = F_BOOST;
        featureArg = (rng() * 2 - 1) * halfWidth * 0.5;
      }
    }
    if (feature === F_NARROW) featureArg = clamp(featureArg, 0.4, 0.7);
    segs.push({ curv, pitch, halfWidth, biome, feature, featureArg });
  }
  return segs;
}

const courseLength = (courseId: number) => (COURSES[courseId] ?? COURSES[0]).segs * SEG_LEN;
const segAt = (segs: Segment[], s: number): Segment =>
  segs[clamp(Math.floor(s / SEG_LEN), 0, segs.length - 1)];

// Altitude of the centreline at distance s. Summed per segment, so it is the
// same number on both sides of the wire.
function altitudeAt(segs: Segment[], s: number): number {
  const idx = clamp(Math.floor(s / SEG_LEN), 0, segs.length - 1);
  let h = 0;
  for (let i = 0; i < idx; i++) h -= Math.sin(segs[i].pitch) * SEG_LEN;
  h -= Math.sin(segs[idx].pitch) * (s - idx * SEG_LEN);
  return h;
}

// ---------------------------------------------------------------------------
// Bike physics — arcade, tuned for "gravity is the engine".
// Mirrored (the display-relevant parts) in client/src/config.ts.
// ---------------------------------------------------------------------------
const G = 22; // arcade gravity (m/s²)
const PEDAL_ACCEL = 7.5; // holding forward: tuck + pedal
const BRAKE_ACCEL = 17;
const DRAG_TUCK = 0.0045; // holding forward: tucked, slippery
const DRAG_UPRIGHT = 0.0095; // sitting up: the air grabs you
const OFFTRACK_ROLL = 0.95; // rough ground outside the corridor
// Going off the racing line is NOT a crash: the berm scrubs your speed and
// noses you back onto the track, and only riding a long way out into the
// scenery actually puts you down. (A tighter margin here cost a competent
// test rider a crash every ten seconds.)
const CRASH_MARGIN = 14; // metres past the corridor before it is a crash
const BERM_PUSH = 0.75; // how hard the hillside noses you back on
const BASE_TOP = 40; // reference top speed (m/s) before stats
const GRIP_ACCEL = 1.15; // lateral g the tyres hold before they let go
const STEER_RATE = 3.2; // rad/s of yaw authority at walking pace
// How far the bike may sit across its direction of travel. This is the
// single most important handling number: the slip angle times the speed IS
// the rate you cross the track, so a generous value at speed means a rider
// holding the stick leaves the corridor in under a second.
const MAX_YAW = 0.62;
const YAW_DAMP = 2.6; // how hard the bike straightens itself out
const AIR_PITCH_RATE = 1.6; // rad/s of nose control in the air
// The bike comes back level on its own, so a rider who simply holds the
// throttle through a jump is not guaranteed to bury the nose and crash.
const AIR_LEVEL_RATE = 1.5;
const HOP_IMPULSE = 6.5;
const KICK_IMPULSE = 9.0;
const CRASH_TICKS = ticks(1.4);
const CRASH_SPEED_KEEP = 0.22;
const BOOST_MAX = 1000;
const BOOST_BURN = 430; // meter per second while boosting
const BOOST_ACCEL = 6;
const BOOST_TOP = 9; // extra top speed while boosting
const DRIFT_FILL = 260; // meter per second of full slip
const AIR_FILL = 95; // meter per second airborne
const LAND_PERFECT = 150; // meter for a clean landing (× seconds of air)
const TRICK_PAY = 130; // meter per landed trick, × rotations
const HOP_WINDOW = ticks(0.5); // how long a hop press stays armed
const PERFECT_HOP = ticks(0.2); // press this close to the lip for a perfect pop
const DRAFT_DIST = 14; // metres behind a rider where the air is free
const DRAFT_FILL = 180;

// Landing grade: how far the nose may be off the slope it lands on.
const LAND_OK = 0.55;
const LAND_BAD = 1.15;

// Tricks — held in the air with a direction. Each needs air time to land.
const TRICK_NONE = 0;
const TRICK_WHIP = 1; // stick left/right
const TRICK_FLIP = 2; // stick back
const TRICK_SUPER = 3; // stick forward
const TRICK_TAIL = 4; // hop + trick together
const TRICK_MIN_AIR = [0, ticks(0.45), ticks(0.85), ticks(0.6), ticks(0.7)];
const TRICK_RATE = [0, 5.2, 4.4, 2.6, 6.0]; // rotation units per second

// Buttons (player.btn bitmask, written by set_input)
const BTN_HOP = 1;
const BTN_TRICK = 2;
const BTN_BOOST = 4;

// Visual event flags (player.fxKind) — one-shot cues the client animates.
const FX_NONE = 0;
const FX_CRASH = 1;
const FX_LAND_PERFECT = 2;
const FX_LAND_OK = 3;
const FX_TRICK = 4;
const FX_BOOSTPAD = 5;
const FX_KICKER = 6;
const FX_TICKS = ticks(0.6);

// ---------------------------------------------------------------------------
// Riders: character × bike. The characters are the Digital Tennis roster
// (client/src/characters.ts is a verbatim copy of that game's file); their
// BIKE stats live here because tennis stats say nothing about a downhill.
// Mirrored in client/src/bikes.ts — keep in sync.
// ---------------------------------------------------------------------------
interface RideStats {
  top: number; // top speed
  accel: number; // pedal + boost punch
  grip: number; // cornering hold
  air: number; // launch height + air control + trick rate
  weight: number; // > 1 = heavy: rolls better, turns worse, lands harder
}
const NEUTRAL: RideStats = { top: 1, accel: 1, grip: 1, air: 1, weight: 1 };

// Same order/ids as client/src/characters.ts CHARACTERS.
const CHAR_RIDE: RideStats[] = [
  { top: 1.06, accel: 1.04, grip: 0.94, air: 0.96, weight: 1.06 }, // BLAZE  — power
  { top: 0.98, accel: 0.98, grip: 1.08, air: 1.02, weight: 0.98 }, // VOLT   — technical
  { top: 1.02, accel: 1.10, grip: 1.02, air: 1.04, weight: 0.92 }, // KAI    — speed demon
  { top: 1.00, accel: 0.98, grip: 1.10, air: 0.96, weight: 1.00 }, // ROSA   — grip
  { top: 1.00, accel: 1.00, grip: 1.00, air: 1.00, weight: 1.00 }, // VIPER  — all-rounder
  { top: 0.96, accel: 1.00, grip: 0.98, air: 1.12, weight: 0.94 }, // LUNA   — trick artist
  { top: 0.94, accel: 1.02, grip: 0.88, air: 1.10, weight: 0.88 }, // PEELS  — slippery
  { top: 1.00, accel: 1.10, grip: 1.06, air: 0.92, weight: 0.86 }, // BISCUIT
  { top: 1.08, accel: 0.94, grip: 1.00, air: 0.94, weight: 1.14 }, // SERVO
  { top: 0.98, accel: 1.02, grip: 1.04, air: 1.06, weight: 0.90 }, // ZORP
  { top: 1.06, accel: 1.00, grip: 0.96, air: 1.02, weight: 1.04 }, // SMASHULA
  { top: 1.10, accel: 0.92, grip: 0.94, air: 0.92, weight: 1.18 }, // PLANK
  { top: 1.04, accel: 0.90, grip: 1.02, air: 0.90, weight: 1.24 }, // YETI
  { top: 0.92, accel: 0.96, grip: 1.12, air: 0.90, weight: 0.94 }, // GRANNY
  { top: 1.00, accel: 1.06, grip: 1.00, air: 1.08, weight: 0.96 }, // DISCO
  { top: 0.96, accel: 1.00, grip: 1.10, air: 1.00, weight: 0.98 }, // INKY
  { top: 0.98, accel: 0.98, grip: 1.06, air: 0.98, weight: 1.02 }, // PRICKLES
  { top: 0.96, accel: 1.04, grip: 0.98, air: 1.10, weight: 0.92 }, // MYSTO
];

// Bikes — a shape, not a tier. Mirrored in client/src/bikes.ts.
const BIKES: RideStats[] = [
  { top: 1.00, accel: 1.00, grip: 1.00, air: 1.00, weight: 1.00 }, // 0 TRAIL
  { top: 1.12, accel: 0.90, grip: 1.06, air: 0.94, weight: 1.16 }, // 1 DOWNHILL
  { top: 1.02, accel: 1.10, grip: 0.96, air: 1.10, weight: 0.96 }, // 2 DIRT
  { top: 0.88, accel: 1.14, grip: 0.94, air: 1.22, weight: 0.82 }, // 3 BMX
  { top: 0.92, accel: 0.96, grip: 1.18, air: 0.90, weight: 1.20 }, // 4 FAT
  { top: 1.06, accel: 1.02, grip: 0.86, air: 1.00, weight: 1.02 }, // 5 RALLY (drifter)
];
const BIKE_COUNT = BIKES.length;

function rideStats(characterId: number, bikeId: number): RideStats {
  const c = CHAR_RIDE[characterId] ?? NEUTRAL;
  const b = BIKES[bikeId] ?? NEUTRAL;
  return {
    top: c.top * b.top,
    accel: c.accel * b.accel,
    grip: c.grip * b.grip,
    air: c.air * b.air,
    weight: c.weight * b.weight,
  };
}

// ---------------------------------------------------------------------------
// Bot riders. One continuous skill dial (0..120) drives every knob, with
// EASY / NORMAL / HARD sitting on anchors — the same shape Digital Tennis
// uses, so the difficulty UI is identical.
// ---------------------------------------------------------------------------
const BOT_EASY = 40;
const BOT_NORMAL = 80;
const BOT_HARD = 120;
const BOT_SKILL_UNSET = 255; // lobby.botSkill: derive from botLevel
const BOT_LEVEL_SKILL = [BOT_EASY, BOT_NORMAL, BOT_HARD];

interface BotProfile {
  look: number; // how far down the track it reads corners (m)
  lineErr: number; // how far off the racing line it sits (m)
  brake: number; // willingness to brake for a corner it can't hold
  hopErr: number; // ticks of error on a kicker lip
  trick: number; // odds it goes for a trick off a jump
  boost: number; // how readily it spends the meter
  mistake: number; // per-second odds of a wobble
  throttle: number; // baseline commitment
}
function botProfileAt(rawSkill: number): BotProfile {
  const k = clamp(rawSkill, 0, BOT_HARD) / BOT_HARD; // 0 pushover .. 1 hard
  return {
    look: lerp(35, 130, k),
    lineErr: lerp(6.5, 0.6, k),
    brake: lerp(0.25, 1.0, k),
    hopErr: lerp(ticks(0.5), ticks(0.05), k),
    trick: lerp(0, 0.75, k),
    boost: lerp(0.1, 1, k),
    mistake: lerp(0.5, 0.01, k),
    throttle: lerp(0.55, 1, k),
  };
}
const BOT_NAMES = [
  'DUSTY', 'RIDGE', 'SCREE', 'GRAVEL', 'TIMBER', 'CINDER',
  'SLATE', 'BRAMBLE', 'FLINT', 'QUARRY', 'PINE', 'CAIRN',
];

// ---------------------------------------------------------------------------
// Progression. Mirrored in client/src/config.ts — keep in sync.
// ---------------------------------------------------------------------------
const MMR_START = 1000;
const LEVEL_BASE = 200;
const LEVEL_STEP = 100;
const LEVEL_MAX = 99;
const XP_FINISH = 40; // just for turning up and finishing
const XP_PER_BEATEN = 25; // per rider you finished ahead of
const XP_WIN = 60;
const XP_BOT_SCALE = 0.5; // bots on the grid halve the payout
const K_PLACEMENT = 48;
const K_EARLY = 32;
const K_SETTLED = 20;
const PLACEMENT_RACES = 10;
const SETTLED_RACES = 40;
const LOG_KEEP = 20; // race_log rows kept per account

const PROV_NONE = 0;
const PROV_ANON = 1;
const PROV_LINKED = 2;
const PROV_OTHER = 3;
// Set this to your own Firebase project id (see README). Accounts still work
// without it — players fall back to raw SpacetimeDB identities.
const FIREBASE_PROJECT = 'digital-tennis-4a9a2';
const FIREBASE_ISSUER = `https://securetoken.google.com/${FIREBASE_PROJECT}`;
// Tokens minted by the profile service (profiles/mint-token.mjs) and by the
// cross-game championship relay carry these issuers. Both are only mintable
// with the server's own signing key.
const PROFILE_SERVICE_ISSUER = 'digital-bike-profiles';
const RELAY_ISSUER = 'digital-championship-relay';

// Race end reasons (race_log.endedBy)
const END_FINISHED = 0;
const END_DNF = 1;
const END_QUIT = 2;

// ---------------------------------------------------------------------------
// Unlocks. Unlocked-ness is DERIVED from account counters on demand and never
// stored, so the whole persistence cost is the counters themselves.
// Mirrored in client/src/unlocks.ts — keep in sync.
// ---------------------------------------------------------------------------
const U_LEVEL = 0;
const U_RACES = 1;
const U_WINS = 2;
const U_PODIUMS = 3;
const U_BOT_WINS = 4;
const U_TRICKS = 5;
const U_TOPSPEED = 6;
const U_CUP_WINS = 7;
const U_COURSE_WIN = 8; // n = courseId: win a race on that course

interface UnlockCond { kind: number; n: number }
// Characters 0..5 are always available; the wacky dozen is earned.
const CHAR_UNLOCKS: (UnlockCond | null)[] = [
  null, null, null, null, null, null,
  { kind: U_RACES, n: 5 },        // 6  PEELS
  { kind: U_BOT_WINS, n: 3 },     // 7  BISCUIT
  { kind: U_LEVEL, n: 4 },        // 8  SERVO
  { kind: U_PODIUMS, n: 6 },      // 9  ZORP
  { kind: U_TRICKS, n: 25 },      // 10 SMASHULA
  { kind: U_WINS, n: 5 },         // 11 PLANK
  { kind: U_TOPSPEED, n: 150 },   // 12 YETI  (km/h)
  { kind: U_RACES, n: 25 },       // 13 GRANNY
  { kind: U_TRICKS, n: 60 },      // 14 DISCO
  { kind: U_LEVEL, n: 10 },       // 15 INKY
  { kind: U_COURSE_WIN, n: 3 },   // 16 PRICKLES
  { kind: U_CUP_WINS, n: 1 },     // 17 MYSTO
];
// Bikes: TRAIL is everyone's; the rest are earned.
const BIKE_UNLOCKS: (UnlockCond | null)[] = [
  null,
  { kind: U_RACES, n: 3 },        // 1 DOWNHILL
  { kind: U_PODIUMS, n: 3 },      // 2 DIRT
  { kind: U_TRICKS, n: 15 },      // 3 BMX
  { kind: U_LEVEL, n: 6 },        // 4 FAT
  { kind: U_WINS, n: 8 },         // 5 RALLY
];
// Courses: the first is everyone's home hill; the rest open with the miles.
const COURSE_UNLOCKS: (UnlockCond | null)[] = [
  null,
  { kind: U_RACES, n: 2 },
  { kind: U_WINS, n: 3 },
  { kind: U_PODIUMS, n: 8 },
  { kind: U_CUP_WINS, n: 1 },
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const M_RACE = 0; // a single course
const M_CUP = 1; // a series of courses, points per finish

const L_OPEN = 0;
const L_RUNNING = 1;
const L_FINISHED = 2;

const R_COUNTDOWN = 0; // gate is up: the clock holds, riders are pinned
const R_LIVE = 1;
const R_DONE = 2;

const CUP_STAGES = 3;
const CUP_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
const MAX_RIDERS = 8;

const Lobby = table(
  { name: 'lobby', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().unique(),
    hostId: t.identity(),
    mode: t.u8(), // 0 race · 1 cup
    status: t.u8(), // 0 open · 1 running · 2 finished
    vsBot: t.bool(), // free ride / time trial: started solo against the hill
    courseId: t.u8(),
    seed: t.u32(),
    stage: t.u8(), // cup: which leg is running (0-based)
    stages: t.u8(), // cup: how many legs
    botFill: t.bool(), // fill empty grid slots with bots
    botLevel: t.u8().default(1), // 0 easy · 1 normal · 2 hard
    botSkill: t.u8().default(255), // fine dial; 255 = derive from botLevel
    championName: t.string(),
    createdAt: t.timestamp(),
    isPublic: t.bool().default(false),
    // Custom rules — physics multipliers (1 = standard).
    gravityMul: t.f32().default(1),
    gripMul: t.f32().default(1),
    speedMul: t.f32().default(1),
    airMul: t.f32().default(1),
    // NOTE: new columns must be APPENDED — inserting mid-table breaks
    // SpacetimeDB's automatic migration.
    championshipLeg: t.u64().default(0n), // cross-game hub leg (0 = ordinary room)
  }
);

const Race = table(
  {
    name: 'race',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    stage: t.u8(),
    state: t.u8(), // R_*
    courseId: t.u8(),
    seed: t.u32(),
    length: t.f32(), // metres to the line
    startTicks: t.u16(), // gate countdown / cup intermission, ticks left
    elapsed: t.u32(), // ticks since the gate dropped
    finished: t.u8(), // how many riders are home
    riders: t.u8(),
    leaderName: t.string(),
    winnerName: t.string(),
    // The absolute deadline for the stragglers once the leader is home.
    cutoff: t.u32().default(0),
    // Reconnect: a rider dropped and the race is HALTED (see haltRace).
    haltUntil: t.u64().default(0n),
    haltName: t.string().default(''),
    haltedAt: t.u64().default(0n),
  }
);

const Player = table(
  {
    name: 'player',
    public: true,
    indexes: [
      { accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] },
      { accessor: 'byRace', algorithm: 'btree', columns: ['raceId'] },
    ],
  },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    lobbyId: t.u64(), // 0 = not in a room
    raceId: t.u64(), // 0 = not racing
    characterId: t.u8(),
    bikeId: t.u8(),
    // --- rider state, in TRACK SPACE ---
    s: t.f32(), // distance along the centreline — also the race position
    n: t.f32(), // lateral offset from the centreline
    v: t.f32(), // speed along the bike's heading
    yaw: t.f32(), // heading relative to the track tangent
    z: t.f32(), // world altitude
    vz: t.f32(),
    pitch: t.f32(), // nose angle (air control + landing grade)
    lean: t.f32(), // visual roll
    boost: t.u16(), // 0..BOOST_MAX
    boosting: t.bool(),
    airTicks: t.u16(),
    crashTicks: t.u8(),
    trickKind: t.u8(),
    trickSpin: t.f32(),
    slip: t.f32(), // 0..1 how sideways the bike is right now (drift smoke)
    // --- race bookkeeping ---
    place: t.u8(), // 0 = still racing, else finishing position
    finishTicks: t.u32(),
    cupPoints: t.u16(),
    // --- input ---
    dirX: t.i8(),
    dirY: t.i8(),
    btn: t.u8(), // BTN_* bitmask, held
    hopTicks: t.u8(), // a hop press stays armed this many ticks
    // --- presentation / room ---
    fxKind: t.u8(),
    fxTicks: t.u8(),
    online: t.bool(),
    isBot: t.bool(),
    spectator: t.bool(),
    ready: t.bool(),
    kicked: t.bool(),
    botSkill: t.u8().default(255),
    // Per-race accumulators, read once when the race pays out.
    topV: t.f32().default(0), // fastest speed reached this race (m/s)
    tricksDone: t.u16().default(0),
  }
);

const Chat = table(
  {
    name: 'chat',
    public: true,
    indexes: [{ accessor: 'byLobby', algorithm: 'btree', columns: ['lobbyId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    senderName: t.string(),
    emote: t.bool(),
    text: t.string(),
    sentAt: t.timestamp(),
  }
);

// Per-identity chat rate limit (private — never subscribed).
const ChatGuard = table(
  { name: 'chat_guard' },
  {
    identity: t.identity().primaryKey(),
    lastAt: t.u64(), // micros since epoch — raw, so the arithmetic stays bigint
    burst: t.u8(),
    mutedUntil: t.u64(),
  }
);

const Account = table(
  {
    name: 'account',
    public: true,
    indexes: [{ accessor: 'byMmr', algorithm: 'btree', columns: ['mmr'] }],
  },
  {
    identity: t.identity().primaryKey(),
    uid: t.string(),
    provider: t.u8(),
    displayName: t.string(), // source of truth; player.name is the session copy
    characterId: t.u8(),
    bikeId: t.u8(),
    xp: t.u32(),
    level: t.u16(),
    mmr: t.u16(),
    peakMmr: t.u16(),
    ranked: t.u16(),
    rankedWins: t.u16(),
    casual: t.u16(),
    casualWins: t.u16(),
    streak: t.i16(),
    bestStreak: t.u16(),
    quits: t.u16(),
    createdAt: t.timestamp(),
    lastSeen: t.timestamp(),
    // Monotonic revision, bumped on every change worth persisting. The
    // profile service syncs on it in both directions.
    rev: t.u32().default(0),
    // Unlock counters — everything CHAR_UNLOCKS / BIKE_UNLOCKS read.
    races: t.u16().default(0),
    wins: t.u16().default(0),
    podiums: t.u16().default(0),
    botWins: t.u16().default(0),
    tricks: t.u32().default(0),
    topSpeed: t.u16().default(0), // km/h, personal best
    cupWins: t.u16().default(0),
    courseWins: t.u32().default(0), // bitmask: bit i = won a race on course i
    cupStage: t.u8().default(0),
    cupRound: t.u8().default(0),
  }
);

// One row per human per finished race. Powers the post-race reveal.
const RaceLog = table(
  {
    name: 'race_log',
    indexes: [{ accessor: 'byAccount', algorithm: 'btree', columns: ['identity'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity(),
    raceId: t.u64(),
    courseId: t.u8(),
    place: t.u8(),
    riders: t.u8(),
    timeTicks: t.u32(),
    ranked: t.bool(),
    mmrBefore: t.u16(),
    mmrAfter: t.u16(),
    xpBefore: t.u32(),
    xpGained: t.u32(),
    levelAfter: t.u16(),
    topSpeed: t.u16(),
    tricks: t.u16(),
    endedBy: t.u8(),
    playedAt: t.timestamp(),
  }
);

// One row per live websocket: presence is "has at least one session", never
// "the last disconnect wins" (two tabs share one identity).
const Session = table(
  {
    name: 'session',
    indexes: [{ accessor: 'byIdentity', algorithm: 'btree', columns: ['identity'] }],
  },
  {
    connectionId: t.connectionId().primaryKey(),
    identity: t.identity(),
    startedAt: t.timestamp(),
  }
);

// The finishing order of a championship room, written exactly once when the
// result is final. The cross-game relay carries it to the hub.
const LegResult = table(
  {
    name: 'leg_result',
    public: true,
    indexes: [{ accessor: 'byLeg', algorithm: 'btree', columns: ['legId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    legId: t.u64(),
    placings: t.array(t.identity()),
    names: t.array(t.string()),
    finishedAt: t.timestamp(),
  }
);

const TickTimer = table(
  { name: 'tick_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    raceId: t.u64(),
  }
);

// Fires once, when a halted race's grace window expires.
const GraceTimer = table(
  { name: 'grace_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    raceId: t.u64(),
  }
);

// Fires once, when a room whose humans have all gone dark should be torn down.
const ReapTimer = table(
  { name: 'reap_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    lobbyId: t.u64(),
  }
);

const spacetimedb = schema({
  lobby: Lobby,
  race: Race,
  player: Player,
  chat: Chat,
  chatGuard: ChatGuard,
  account: Account,
  raceLog: RaceLog,
  session: Session,
  legResult: LegResult,
  tickTimer: TickTimer,
  graceTimer: GraceTimer,
  reapTimer: ReapTimer,
});
export default spacetimedb;

type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;
type LobbyRow = typeof Lobby.rowType.type;
type RaceRow = typeof Race.rowType.type;
type PlayerRow = typeof Player.rowType.type;
type AccountRow = typeof Account.rowType.type;

// ---------------------------------------------------------------------------
// Course cache. buildCourse is a pure function of (courseId, seed), so caching
// it is invisible to the simulation — it is just not worth rebuilding 120
// segments thirty times a second.
// ---------------------------------------------------------------------------
interface CourseData {
  segs: Segment[];
  alt: number[]; // altitude at each segment start (metres, descending)
  length: number;
}
const courseCache = new Map<string, CourseData>();
function getCourse(courseId: number, seed: number): CourseData {
  const key = `${courseId}:${seed}`;
  const hit = courseCache.get(key);
  if (hit) return hit;
  const segs = buildCourse(courseId, seed);
  const alt: number[] = [];
  let h = 0;
  for (const sg of segs) {
    alt.push(h);
    h -= Math.sin(sg.pitch) * SEG_LEN;
  }
  const data: CourseData = { segs, alt, length: segs.length * SEG_LEN };
  if (courseCache.size > 24) courseCache.clear();
  courseCache.set(key, data);
  return data;
}

function groundAt(course: CourseData, s: number): number {
  const idx = clamp(Math.floor(s / SEG_LEN), 0, course.segs.length - 1);
  return course.alt[idx] - Math.sin(course.segs[idx].pitch) * (s - idx * SEG_LEN);
}

// Custom-rules physics resolved from the lobby (defaults = standard).
interface Phys { gravity: number; grip: number; speed: number; air: number }
function lobbyPhysics(lobby: LobbyRow | null | undefined): Phys {
  return {
    gravity: lobby?.gravityMul ?? 1,
    grip: lobby?.gripMul ?? 1,
    speed: lobby?.speedMul ?? 1,
    air: lobby?.airMul ?? 1,
  };
}
function lobbySkill(lobby: LobbyRow | null | undefined): number {
  const raw = lobby?.botSkill ?? BOT_SKILL_UNSET;
  if (raw !== BOT_SKILL_UNSET) return clamp(raw, 0, BOT_HARD);
  return BOT_LEVEL_SKILL[clamp(lobby?.botLevel ?? 1, 0, 2)];
}

// ---------------------------------------------------------------------------
// The rider simulation. One tick, one rider, pure arithmetic on the row.
//
// State is in TRACK SPACE: `s` along the centreline (which is also the race
// position), `n` across it, `z` in world altitude. That keeps collisions to a
// couple of comparisons and the standings to a sort.
// ---------------------------------------------------------------------------
interface Input {
  steer: number; // -1..1
  throttle: number; // -1 brake .. 1 tuck+pedal
  hop: boolean;
  trick: boolean;
  boost: boolean;
}

// The mutable working copy of a rider for one tick.
type Rider = {
  s: number; n: number; v: number; yaw: number; z: number; vz: number;
  pitch: number; lean: number; boost: number; boosting: boolean;
  airTicks: number; crashTicks: number; trickKind: number; trickSpin: number;
  slip: number; hopTicks: number; fxKind: number; fxTicks: number;
  tricks: number; // landed this tick (counted into the account)
};

function setFx(r: Rider, kind: number) {
  r.fxKind = kind;
  r.fxTicks = FX_TICKS;
}

// A crash costs time and speed, and puts you back on the track: left where
// you went off, a rider outside the corridor simply crashes again, forever.
function crash(r: Rider, half = 0) {
  r.crashTicks = CRASH_TICKS;
  if (half > 0) r.n = clamp(r.n, -half * 0.7, half * 0.7);
  r.v *= CRASH_SPEED_KEEP;
  r.boost = 0;
  r.yaw = 0;
  r.pitch = 0;
  r.vz = 0;
  r.trickKind = TRICK_NONE;
  r.trickSpin = 0;
  r.airTicks = 0;
  r.slip = 0;
  setFx(r, FX_CRASH);
}

function stepRider(
  r: Rider,
  course: CourseData,
  st: RideStats,
  phys: Phys,
  inp: Input,
  draft: boolean
) {
  const segs = course.segs;
  const idxBefore = clamp(Math.floor(r.s / SEG_LEN), 0, segs.length - 1);
  const seg = segs[idxBefore];
  const b = BIOMES[seg.biome];
  const gnd = groundAt(course, r.s);

  // Fading one-shot visual cues.
  if (r.fxTicks > 0 && --r.fxTicks === 0) r.fxKind = FX_NONE;

  // --- down, but not out -----------------------------------------------
  if (r.crashTicks > 0) {
    r.crashTicks--;
    r.v = Math.max(0, r.v - 14 * DT);
    r.s += r.v * DT;
    r.z = groundAt(course, r.s);
    r.lean = 0;
    return;
  }

  // Airborne is an explicit state, not a height comparison: the ground falls
  // away under a descending rider, so comparing z to it would relaunch them
  // every single tick.
  const grounded = r.airTicks === 0;
  const effHalf = seg.feature === F_NARROW ? seg.halfWidth * seg.featureArg : seg.halfWidth;
  const off = Math.max(0, Math.abs(r.n) - effHalf);
  const topSpeed = BASE_TOP * st.top * phys.speed + (r.boosting ? BOOST_TOP : 0);

  // --- boost meter -------------------------------------------------------
  if (inp.boost && r.boost > 0 && grounded) {
    r.boosting = true;
    r.boost = Math.max(0, r.boost - BOOST_BURN * DT);
    if (r.boost === 0) r.boosting = false;
  } else {
    r.boosting = false;
  }
  if (draft) r.boost = Math.min(BOOST_MAX, r.boost + DRAFT_FILL * DT);

  if (grounded) {
    r.z = gnd;
    r.vz = 0;
    // A trick that was still spinning when the wheels touched is not a trick.
    if (r.trickKind !== TRICK_NONE) r.trickKind = TRICK_NONE;
    r.trickSpin = 0;
    // The bike settles onto the slope it is standing on.
    r.pitch = lerp(r.pitch, -seg.pitch, 0.4);

    // --- longitudinal ---------------------------------------------------
    let a = G * phys.gravity * Math.sin(seg.pitch);
    if (inp.throttle > 0) a += PEDAL_ACCEL * st.accel * inp.throttle * Math.max(0, 1 - r.v / topSpeed);
    if (inp.throttle < 0) a += BRAKE_ACCEL * inp.throttle;
    if (r.boosting) a += BOOST_ACCEL * st.accel;
    const dragK = (inp.throttle > 0 ? DRAG_TUCK : DRAG_UPRIGHT) / (st.top * st.top) * (draft ? 0.72 : 1);
    a -= dragK * r.v * r.v;
    a -= (b.roll + off * OFFTRACK_ROLL * 0.26) * r.v * 0.9 / st.weight;

    // --- steering, grip and slip ----------------------------------------
    // Steering authority falls away with speed: full lock at a crawl, a
    // careful few degrees at 130 km/h.
    const speedFac = 1 / (1 + r.v / 9);
    const wantYaw = inp.steer * MAX_YAW * (0.18 + 0.82 * speedFac);
    const yawBefore = r.yaw;
    const rate = STEER_RATE * (0.3 + 0.7 * speedFac);
    r.yaw += clamp(wantYaw - r.yaw, -rate * DT, rate * DT);
    // Self-centring: a bike left alone straightens up.
    if (Math.abs(inp.steer) < 0.05) r.yaw -= r.yaw * YAW_DAMP * DT;

    // The tyres must generate the lateral acceleration of the path the rider
    // is asking for: their own rotation plus the corner the track is turning.
    const worldTurn = (r.yaw - yawBefore) / DT + seg.curv * r.v;
    const lat = r.v * worldTurn;
    const braking = inp.throttle < -0.2;
    const gripLimit =
      b.grip * st.grip * phys.grip * GRIP_ACCEL * G * (off > 0 ? 0.55 : 1) * (braking ? 0.78 : 1);
    let slide = 0;
    if (Math.abs(lat) > gripLimit) {
      const excess = Math.abs(lat) - gripLimit;
      r.slip = clamp(excess / (gripLimit + 1), 0, 1);
      // Understeer: the bike washes out toward the outside of the turn.
      slide = -Math.sign(lat) * Math.min(excess * 0.045, 5.5);
      a -= Math.min(excess * 0.09, 11);
      r.boost = Math.min(BOOST_MAX, r.boost + DRIFT_FILL * r.slip * DT);
    } else {
      r.slip = Math.max(0, r.slip - 3 * DT);
      a -= Math.abs(lat) * 0.06;
    }

    r.v = clamp(r.v + a * DT, 0, topSpeed * 1.15);

    // --- advance along and across the track ------------------------------
    const ds = r.v * Math.cos(r.yaw) * DT;
    r.s += ds;
    r.n += r.v * Math.sin(r.yaw) * DT + slide * DT;
    // Off the track the hillside rises, so it pushes you back down onto it.
    if (off > 0) r.n -= Math.sign(r.n) * Math.min(off * BERM_PUSH, 7) * DT;
    // Following the corner rotates the track under the rider.
    r.yaw -= seg.curv * ds;
    r.lean = lerp(r.lean, clamp(-lat / (G * 1.6), -0.85, 0.85), 0.25);

    // --- hop --------------------------------------------------------------
    if (r.hopTicks > 0) r.hopTicks--;
    if (inp.hop && r.hopTicks === 0) {
      r.hopTicks = HOP_WINDOW;
      // The bunny-hop itself: enough to clear a rock, not enough to trick off.
      r.vz = HOP_IMPULSE * 0.42 * st.air;
      r.airTicks = 1;
    }

    // The wheels stay on the hill.
    r.z = groundAt(course, r.s);

    // --- rough ground and whoops ------------------------------------------
    if (seg.feature === F_WHOOPS) {
      const bump = Math.sin(r.s * 0.85) * seg.featureArg;
      r.z += Math.abs(bump) * 0.25; // visual chatter
      r.v = Math.max(0, r.v - b.rough * 1.2 * DT);
      // Hit the rollers hard enough and they buck you into the air.
      if (r.v > 24 && bump > 0.8 && inp.throttle > -0.2) {
        r.vz = 3.4 * seg.featureArg * st.air;
        r.airTicks = 1;
      }
      // Flat out and sideways through whoops ends one way.
      if (r.v > 34 && Math.abs(r.yaw) > 0.55) crash(r, effHalf);
    }
  } else {
    // --- airborne ---------------------------------------------------------
    r.airTicks++;
    r.vz -= G * phys.gravity * DT;
    r.z += r.vz * DT;
    r.slip = 0;
    // Nose control: forward tips it down, back brings it up — over a
    // self-levelling bias toward the slope the rider is about to land on.
    const wantPitch = -segAt(segs, r.s + Math.max(12, r.v * 0.8)).pitch;
    r.pitch += (wantPitch - r.pitch) * Math.min(1, AIR_LEVEL_RATE * DT);
    r.pitch = clamp(r.pitch - inp.throttle * AIR_PITCH_RATE * st.air * DT, -0.9, 0.9);
    // Some steering authority in the air, but no grip and no turn.
    r.yaw += inp.steer * 0.9 * DT;
    r.lean = lerp(r.lean, inp.steer * 0.5, 0.12);
    const ds = r.v * Math.cos(r.yaw) * DT;
    r.s += ds;
    r.n += r.v * Math.sin(r.yaw) * DT;

    // --- tricks -----------------------------------------------------------
    if (inp.trick) {
      if (r.trickKind === TRICK_NONE && r.airTicks > 2) {
        if (inp.hop) r.trickKind = TRICK_TAIL;
        else if (inp.throttle < -0.4) r.trickKind = TRICK_FLIP;
        else if (inp.throttle > 0.4) r.trickKind = TRICK_SUPER;
        else r.trickKind = TRICK_WHIP;
      }
      if (r.trickKind !== TRICK_NONE) {
        r.trickSpin += TRICK_RATE[r.trickKind] * st.air * DT * 0.25;
      }
    }

    // --- landing ----------------------------------------------------------
    const land = groundAt(course, r.s);
    if (r.z <= land && r.vz <= 0) {
      const hang = r.airTicks / TICK_HZ; // seconds of air, for the payout
      const lseg = segAt(segs, r.s);
      r.z = land;
      r.vz = 0;
      let err = Math.abs(r.pitch + lseg.pitch) + Math.abs(r.yaw) * 0.55;
      // A trick pays only if it was finished before the wheels touched.
      if (r.trickKind !== TRICK_NONE) {
        const done = r.airTicks >= TRICK_MIN_AIR[r.trickKind] && r.trickSpin >= 0.55;
        if (done) {
          const rot = Math.max(1, Math.floor(r.trickSpin));
          r.boost = Math.min(BOOST_MAX, r.boost + TRICK_PAY * rot);
          r.tricks += 1;
          setFx(r, FX_TRICK);
        } else {
          err += 0.7; // bailed out of it — that is a bad landing
        }
        r.trickKind = TRICK_NONE;
        r.trickSpin = 0;
      }
      // Heavy bikes land heavy. A hop off a kerb is not a trophy: the payout
      // (and the punishment) scale with how long you were actually up there.
      const tol = 1 / st.weight;
      if (hang < 0.25) {
        // barely left the ground — no grade, no payout
        r.airTicks = 0;
        r.pitch = -lseg.pitch;
        return;
      }
      if (err * tol < LAND_OK) {
        r.boost = Math.min(BOOST_MAX, r.boost + LAND_PERFECT * Math.min(1.6, hang));
        if (r.fxKind !== FX_TRICK) setFx(r, FX_LAND_PERFECT);
      } else if (err * tol < LAND_BAD) {
        r.v *= 0.9;
        if (r.fxKind !== FX_TRICK) setFx(r, FX_LAND_OK);
      } else {
        crash(r, lseg.feature === F_NARROW ? lseg.halfWidth * lseg.featureArg : lseg.halfWidth);
        return;
      }
      r.airTicks = 0;
      r.pitch = -lseg.pitch;
    }
  }

  // --- feature entry -------------------------------------------------------
  const idxAfter = clamp(Math.floor(r.s / SEG_LEN), 0, segs.length - 1);
  if (idxAfter !== idxBefore) {
    const ns = segs[idxAfter];
    if (ns.feature === F_KICKER && r.airTicks === 0) {
      // Timing gate: a hop pressed close to the lip pops you much higher.
      // (This is the bike's version of tennis's contact timing.)
      const armed = r.hopTicks > 0;
      const perfect = armed && r.hopTicks > HOP_WINDOW - PERFECT_HOP;
      const mul = perfect ? 1.45 : armed ? 1.18 : 1.0;
      r.vz = KICK_IMPULSE * ns.featureArg * st.air * phys.air * mul * (0.55 + r.v / 34);
      r.hopTicks = 0;
      r.airTicks = 1;
      r.z += 0.2;
      if (perfect) r.boost = Math.min(BOOST_MAX, r.boost + 120);
      setFx(r, FX_KICKER);
    } else if (ns.feature === F_DROP && r.airTicks === 0) {
      r.vz = 2.2 * ns.featureArg * st.air * phys.air;
      r.airTicks = 1;
      r.z += 0.2;
    } else if (ns.feature === F_BOOST && Math.abs(r.n - ns.featureArg) < 3.2) {
      r.boost = Math.min(BOOST_MAX, r.boost + 320);
      setFx(r, FX_BOOSTPAD);
    } else if (ns.feature === F_ROCKS && r.airTicks === 0) {
      if (Math.abs(r.n - ns.featureArg) < 2.3) {
        crash(r, ns.halfWidth);
        return;
      }
    }
  }

  // --- the corridor --------------------------------------------------------
  const outSeg = segs[idxAfter];
  const outHalf = outSeg.feature === F_NARROW ? outSeg.halfWidth * outSeg.featureArg : outSeg.halfWidth;
  if (Math.abs(r.n) > outHalf + CRASH_MARGIN) {
    crash(r, outHalf);
  }
}

// ---------------------------------------------------------------------------
// Bot riders: the same physics, a different hand on the bars.
// ---------------------------------------------------------------------------
function botInput(r: Rider, course: CourseData, prof: BotProfile, st: RideStats, salt: number): Input {
  const segs = course.segs;
  const here = segAt(segs, r.s);
  // Read the track ahead: the sharpest corner inside the look-ahead window
  // decides both the line and whether to brake.
  let worst = 0;
  let worstAt = 0;
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const ahead = segAt(segs, r.s + (prof.look * i) / steps);
    if (Math.abs(ahead.curv) > Math.abs(worst)) {
      worst = ahead.curv;
      worstAt = (prof.look * i) / steps;
    }
  }
  // Racing line: sit toward the inside of the corner that is coming.
  const wobble = Math.sin((r.s + salt * 37) * 0.035) * prof.lineErr;
  let lineTarget = clamp(
    Math.sign(worst) * here.halfWidth * 0.55 + wobble,
    -here.halfWidth * 0.85,
    here.halfWidth * 0.85
  );
  // Rocks: a bot that rides straight through a boulder field looks broken.
  // Read one segment ahead and pick the wider side of the cluster; how far
  // ahead it looks (and therefore whether it gets out of the way in time) is
  // the skill dial again.
  const rockSeg = segAt(segs, r.s + Math.min(prof.look, 70));
  if (rockSeg.feature === F_ROCKS) {
    const side = rockSeg.featureArg > 0 ? -1 : 1;
    lineTarget = clamp(
      rockSeg.featureArg + side * (4 + prof.lineErr),
      -rockSeg.halfWidth * 0.9,
      rockSeg.halfWidth * 0.9
    );
  }
  // Steer toward the target lateral position, allowing for current drift.
  const err = lineTarget - (r.n + r.v * Math.sin(r.yaw) * 0.6);
  let steer = clamp(err * 0.12 - r.yaw * 1.1, -1, 1);
  // Brake when the corner ahead cannot be held at this speed.
  const holdable = Math.sqrt((BIOMES[here.biome].grip * st.grip * GRIP_ACCEL * G) / Math.max(0.0012, Math.abs(worst)));
  let throttle = prof.throttle;
  if (r.v > holdable && worstAt < prof.look * 0.6) throttle = -prof.brake;
  // Airborne: level the bike for the landing, or commit to a trick.
  const ahead = segAt(segs, r.s + 25);
  if (r.airTicks > 0) {
    const want = -ahead.pitch;
    throttle = clamp((r.pitch - want) * 2.2, -1, 1);
    steer = -r.yaw * 2;
  }
  const trick = r.airTicks > TRICK_MIN_AIR[TRICK_WHIP] && ((salt * 7 + Math.floor(r.s)) % 97) / 97 < prof.trick;
  // Hop the lip: the error shrinks with skill. A rock still in the way with
  // no room to go round is jumped instead.
  const nextIdx = Math.floor((r.s + r.v * (prof.hopErr / TICK_HZ)) / SEG_LEN);
  const next = segs[clamp(nextIdx, 0, segs.length - 1)];
  const mustJump =
    next.feature === F_ROCKS && Math.abs(r.n - next.featureArg) < 3 && prof.trick > 0.2;
  const hop = (next.feature === F_KICKER || mustJump) && r.airTicks === 0;
  const boost = r.boost > 320 && prof.boost > 0.3 && r.airTicks === 0 && Math.abs(worst) < 0.006;
  return { steer, throttle, hop, trick, boost };
}

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------
function getPlayer(ctx: Ctx): PlayerRow {
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) throw new SenderError('No player record; reconnect and try again');
  return player;
}

function lobbyPlayers(ctx: Ctx, lobbyId: bigint): PlayerRow[] {
  return [...ctx.db.player.byLobby.filter(lobbyId)];
}
function lobbyRiders(ctx: Ctx, lobbyId: bigint): PlayerRow[] {
  return lobbyPlayers(ctx, lobbyId).filter(p => !p.spectator);
}
function raceRiders(ctx: Ctx, raceId: bigint): PlayerRow[] {
  return [...ctx.db.player.byRace.filter(raceId)].filter(p => !p.spectator);
}
function lobbyRaces(ctx: Ctx, lobbyId: bigint): RaceRow[] {
  return [...ctx.db.race.byLobby.filter(lobbyId)];
}
function liveRace(ctx: Ctx, lobbyId: bigint): RaceRow | undefined {
  return lobbyRaces(ctx, lobbyId).find(r => r.state !== R_DONE);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateCode(ctx: Ctx): string {
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';
    const seed = Number(ctx.timestamp.microsSinceUnixEpoch % 1000000n) + attempt * 7919;
    const rng = makeRng(seed);
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)];
    if (!ctx.db.lobby.code.find(code)) return code;
  }
  throw new SenderError('Could not allocate a room code; try again');
}

function rollSeed(ctx: Ctx, salt: number): number {
  return (Number(ctx.timestamp.microsSinceUnixEpoch % 2147483647n) ^ (salt * 0x9e3779b1)) >>> 0;
}

function startTicking(ctx: Ctx, raceId: bigint) {
  deleteTickTimers(ctx, raceId); // never run two clocks on one race
  ctx.db.tickTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS), raceId });
}
function deleteTickTimers(ctx: Ctx, raceId: bigint) {
  for (const timer of ctx.db.tickTimer.iter()) {
    if (timer.raceId === raceId) ctx.db.tickTimer.scheduledId.delete(timer.scheduledId);
  }
}

// Put a rider on the gate line. Slots fan out across the track so nobody is
// buried behind anybody at the drop.
function gateRider(p: PlayerRow, slot: number, count: number, course: CourseData): PlayerRow {
  const spread = Math.min(course.segs[0].halfWidth * 0.7, 2.4 * Math.max(1, count - 1) / 2);
  const n = count <= 1 ? 0 : (slot / (count - 1) - 0.5) * 2 * spread;
  const s = 2 + (slot % 2) * 1.5;
  return {
    ...p,
    s, n, v: 0, yaw: 0,
    z: groundAt(course, s),
    vz: 0,
    pitch: -course.segs[0].pitch,
    lean: 0,
    boost: 0,
    boosting: false,
    airTicks: 0,
    crashTicks: 0,
    trickKind: 0,
    trickSpin: 0,
    slip: 0,
    place: 0,
    finishTicks: 0,
    dirX: 0, dirY: 0, btn: 0, hopTicks: 0,
    fxKind: 0, fxTicks: 0,
    ready: false,
    topV: 0,
    tricksDone: 0,
  };
}

// Open a race on a lobby: seat everyone, drop the gate after a countdown.
// `intermission` is the pause a cup takes between legs (the standings screen).
function openRace(ctx: Ctx, lobby: LobbyRow, intermission = false): RaceRow {
  const riders = lobbyRiders(ctx, lobby.id);
  const course = getCourse(lobby.courseId, lobby.seed);
  const race = ctx.db.race.insert({
    id: 0n,
    lobbyId: lobby.id,
    stage: lobby.stage,
    state: R_COUNTDOWN,
    courseId: lobby.courseId,
    seed: lobby.seed,
    length: course.length,
    startTicks: intermission ? ticks(12) : ticks(4),
    elapsed: 0,
    finished: 0,
    riders: riders.length,
    leaderName: '',
    winnerName: '',
    cutoff: 0,
    haltUntil: 0n,
    haltName: '',
    haltedAt: 0n,
  });
  riders.forEach((p, i) => {
    ctx.db.player.identity.update({ ...gateRider(p, i, riders.length, course), raceId: race.id });
  });
  // Spectators hold no slot but follow the room.
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    if (p.spectator) ctx.db.player.identity.update({ ...p, raceId: race.id, place: 0 });
  }
  startTicking(ctx, race.id);
  return race;
}

const botIdentity = (lobbyId: bigint, index = 0) =>
  new Identity(0xb1c_00000000_00000000_00000000n + (BigInt(index) << 64n) + lobbyId);

function insertBot(ctx: Ctx, lobby: LobbyRow, slot: number): PlayerRow {
  const rng = makeRng(rollSeed(ctx, slot * 131 + Number(lobby.id % 1000n)));
  const name = BOT_NAMES[slot % BOT_NAMES.length];
  // A bot identity is derived from the room + slot, so it is stable and
  // unique without any account behind it.
  const id = botIdentity(lobby.id, slot);
  const existing = ctx.db.player.identity.find(id);
  const row = {
    identity: id,
    name,
    lobbyId: lobby.id,
    raceId: 0n,
    characterId: Math.floor(rng() * CHAR_RIDE.length),
    bikeId: Math.floor(rng() * BIKE_COUNT),
    s: 0, n: 0, v: 0, yaw: 0, z: 0, vz: 0, pitch: 0, lean: 0,
    boost: 0, boosting: false, airTicks: 0, crashTicks: 0,
    trickKind: 0, trickSpin: 0, slip: 0,
    place: 0, finishTicks: 0, cupPoints: 0,
    dirX: 0, dirY: 0, btn: 0, hopTicks: 0,
    fxKind: 0, fxTicks: 0,
    online: true, isBot: true, spectator: false, ready: true, kicked: false,
    botSkill: clamp(Math.round(lobbySkill(lobby) + (rng() - 0.5) * 16), 0, BOT_HARD),
    topV: 0, tricksDone: 0,
  };
  return existing ? ctx.db.player.identity.update(row) : ctx.db.player.insert(row);
}

function fillWithBots(ctx: Ctx, lobby: LobbyRow, want: number) {
  const riders = lobbyRiders(ctx, lobby.id);
  for (let i = riders.length; i < Math.min(want, MAX_RIDERS); i++) insertBot(ctx, lobby, i);
}

function clearBots(ctx: Ctx, lobbyId: bigint) {
  for (const p of lobbyPlayers(ctx, lobbyId)) {
    if (p.isBot) ctx.db.player.identity.delete(p.identity);
  }
}

// ---------------------------------------------------------------------------
// Reconnect: a dropped rider HALTS the race instead of handing out a result.
// ---------------------------------------------------------------------------
const GRACE_RACE = 90_000_000n; // micros
const CLAIM_UNLOCK = 30_000_000n;

function hasSession(ctx: Ctx, id: Identity): boolean {
  for (const _ of ctx.db.session.byIdentity.filter(id)) return true;
  return false;
}
function deleteGraceTimers(ctx: Ctx, raceId: bigint) {
  for (const g of ctx.db.graceTimer.iter()) {
    if (g.raceId === raceId) ctx.db.graceTimer.scheduledId.delete(g.scheduledId);
  }
}
// Who, if anyone, this race is waiting on: a human rider who is offline and
// has not finished.
function missingRider(ctx: Ctx, raceId: bigint): PlayerRow | undefined {
  return raceRiders(ctx, raceId).find(p => !p.isBot && !p.online && p.place === 0);
}

function haltRace(ctx: Ctx, race: RaceRow, awayName: string) {
  if (race.haltUntil !== 0n) return;
  const now = ctx.timestamp.microsSinceUnixEpoch;
  deleteTickTimers(ctx, race.id); // a halted race costs one scheduled call, not 2700
  deleteGraceTimers(ctx, race.id);
  ctx.db.graceTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(now + GRACE_RACE),
    raceId: race.id,
  });
  ctx.db.race.id.update({ ...race, haltUntil: now + GRACE_RACE, haltedAt: now, haltName: awayName });
}

function resumeRace(ctx: Ctx, race: RaceRow) {
  if (race.haltUntil === 0n) return;
  deleteGraceTimers(ctx, race.id);
  ctx.db.race.id.update({ ...race, haltUntil: 0n, haltedAt: 0n, haltName: '' });
  startTicking(ctx, race.id);
}

function syncPresence(ctx: Ctx, raceId: bigint) {
  const race = ctx.db.race.id.find(raceId);
  if (!race || race.state === R_DONE) return;
  const away = missingRider(ctx, raceId);
  if (away) haltRace(ctx, race, away.name);
  else resumeRace(ctx, race);
}

export const grace_expired = spacetimedb.reducer(
  { onSchedule: GraceTimer },
  { arg: GraceTimer.rowType },
  (ctx, { arg }) => {
    ctx.db.graceTimer.scheduledId.delete(arg.scheduledId);
    const race = ctx.db.race.id.find(arg.raceId);
    if (!race || race.state === R_DONE || race.haltUntil === 0n) return;
    // Time is up: whoever is still away is out of the race, and the rest ride on.
    for (const p of raceRiders(ctx, race.id)) {
      if (!p.isBot && !p.online && p.place === 0) {
        ctx.db.player.identity.update({ ...p, raceId: 0n, lobbyId: p.lobbyId });
        const acc = accountOf(ctx, p.identity);
        if (acc) {
          ctx.db.account.identity.update({ ...acc, quits: acc.quits + 1, rev: acc.rev + 1 });
        }
      }
    }
    const left = raceRiders(ctx, race.id);
    ctx.db.race.id.update({ ...race, haltUntil: 0n, haltedAt: 0n, haltName: '', riders: left.length });
    if (left.length === 0) finishRace(ctx, ctx.db.race.id.find(race.id)!);
    else startTicking(ctx, race.id);
  }
);

// ---------------------------------------------------------------------------
// Empty rooms: a disconnected rider still occupies their lobby, so the "last
// human left" teardown never runs for a room where everyone dropped.
// ---------------------------------------------------------------------------
const REAP_AFTER = 120_000_000n;
function lobbyHasPresence(ctx: Ctx, lobbyId: bigint): boolean {
  return lobbyPlayers(ctx, lobbyId).some(p => !p.isBot && p.online);
}
function disarmReaper(ctx: Ctx, lobbyId: bigint) {
  for (const r of ctx.db.reapTimer.iter()) {
    if (r.lobbyId === lobbyId) ctx.db.reapTimer.scheduledId.delete(r.scheduledId);
  }
}
function armReaper(ctx: Ctx, lobbyId: bigint) {
  disarmReaper(ctx, lobbyId);
  ctx.db.reapTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + REAP_AFTER),
    lobbyId,
  });
}
export const reap_lobby = spacetimedb.reducer(
  { onSchedule: ReapTimer },
  { arg: ReapTimer.rowType },
  (ctx, { arg }) => {
    ctx.db.reapTimer.scheduledId.delete(arg.scheduledId);
    const lobby = ctx.db.lobby.id.find(arg.lobbyId);
    if (!lobby) return;
    if (lobbyHasPresence(ctx, arg.lobbyId)) return;
    destroyLobby(ctx, lobby);
  }
);

function destroyLobby(ctx: Ctx, lobby: LobbyRow) {
  for (const race of lobbyRaces(ctx, lobby.id)) {
    deleteTickTimers(ctx, race.id);
    deleteGraceTimers(ctx, race.id);
    ctx.db.race.id.delete(race.id);
  }
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    if (p.isBot) ctx.db.player.identity.delete(p.identity);
    else ctx.db.player.identity.update({ ...p, lobbyId: 0n, raceId: 0n, place: 0, cupPoints: 0, ready: false, spectator: false });
  }
  for (const c of ctx.db.chat.byLobby.filter(lobby.id)) ctx.db.chat.id.delete(c.id);
  disarmReaper(ctx, lobby.id);
  ctx.db.lobby.id.delete(lobby.id);
}

// ---------------------------------------------------------------------------
// Accounts: the persistent profile behind an identity.
// ---------------------------------------------------------------------------
function providerOf(ctx: Ctx): { provider: number; uid: string; name: string } {
  const jwt = ctx.senderAuth.jwt;
  if (!jwt) return { provider: PROV_NONE, uid: '', name: '' };
  if (jwt.issuer !== FIREBASE_ISSUER) return { provider: PROV_OTHER, uid: jwt.subject, name: '' };
  const fb = jwt.fullPayload['firebase'];
  const signIn = fb && typeof fb === 'object' && !Array.isArray(fb) ? fb['sign_in_provider'] : null;
  const claimed = jwt.fullPayload['name'];
  return {
    provider: signIn === 'anonymous' ? PROV_ANON : PROV_LINKED,
    uid: jwt.subject,
    name: typeof claimed === 'string' ? claimed.trim().slice(0, 16) : '',
  };
}

function ensureAccount(ctx: Ctx): AccountRow {
  const { provider, uid, name } = providerOf(ctx);
  const existing = ctx.db.account.identity.find(ctx.sender);
  if (existing) {
    // Linking a guest to Google keeps the uid, so only the provider moves.
    // lastSeen alone must NOT bump rev, or every reconnect churns the mirror.
    const moved = existing.provider !== provider || (!!uid && existing.uid !== uid);
    return ctx.db.account.identity.update({
      ...existing,
      uid: uid || existing.uid,
      provider,
      lastSeen: ctx.timestamp,
      rev: moved ? existing.rev + 1 : existing.rev,
    });
  }
  return ctx.db.account.insert({
    identity: ctx.sender,
    uid,
    provider,
    displayName: name,
    characterId: 0,
    bikeId: 0,
    xp: 0,
    level: 1,
    mmr: MMR_START,
    peakMmr: MMR_START,
    ranked: 0,
    rankedWins: 0,
    casual: 0,
    casualWins: 0,
    streak: 0,
    bestStreak: 0,
    quits: 0,
    createdAt: ctx.timestamp,
    lastSeen: ctx.timestamp,
    rev: 0,
    races: 0,
    wins: 0,
    podiums: 0,
    botWins: 0,
    tricks: 0,
    topSpeed: 0,
    cupWins: 0,
    courseWins: 0,
    cupStage: 0,
    cupRound: 0,
  });
}

function accountOf(ctx: Ctx, id: Identity): AccountRow | undefined {
  return ctx.db.account.identity.find(id) ?? undefined;
}

// ----- unlock evaluation (see CHAR_UNLOCKS / BIKE_UNLOCKS above) -----
function condMet(acc: AccountRow, cond: UnlockCond): boolean {
  switch (cond.kind) {
    case U_LEVEL: return acc.level >= cond.n;
    case U_RACES: return acc.races >= cond.n;
    case U_WINS: return acc.wins >= cond.n;
    case U_PODIUMS: return acc.podiums >= cond.n;
    case U_BOT_WINS: return acc.botWins >= cond.n;
    case U_TRICKS: return acc.tricks >= cond.n;
    case U_TOPSPEED: return acc.topSpeed >= cond.n;
    case U_CUP_WINS: return acc.cupWins >= cond.n;
    case U_COURSE_WIN: return (acc.courseWins & (1 << cond.n)) !== 0;
    default: return false;
  }
}
function gateOpen(acc: AccountRow | undefined, gates: (UnlockCond | null)[], id: number): boolean {
  const cond = gates[id];
  if (cond === undefined) return false; // no such thing
  if (cond === null) return true; // always available
  return !!acc && condMet(acc, cond);
}
const charUnlocked = (acc: AccountRow | undefined, id: number) => gateOpen(acc, CHAR_UNLOCKS, id);
const bikeUnlocked = (acc: AccountRow | undefined, id: number) => gateOpen(acc, BIKE_UNLOCKS, id);
const courseUnlocked = (acc: AccountRow | undefined, id: number) => gateOpen(acc, COURSE_UNLOCKS, id);

function totalXpFor(level: number): number {
  return ((level - 1) * (2 * LEVEL_BASE + LEVEL_STEP * (level - 2))) / 2;
}
function levelFor(xp: number): number {
  let lvl = 1;
  while (lvl < LEVEL_MAX && totalXpFor(lvl + 1) <= xp) lvl++;
  return lvl;
}
function kFactor(ranked: number): number {
  if (ranked < PLACEMENT_RACES) return K_PLACEMENT;
  if (ranked < SETTLED_RACES) return K_EARLY;
  return K_SETTLED;
}

// A race is ranked when it is a real field: two or more humans, no bots, not
// a free ride. Bots are filler, not opponents, and never move a rating.
function isRanked(lobby: LobbyRow | null | undefined, riders: PlayerRow[]): boolean {
  if (!lobby || lobby.vsBot) return false;
  const humans = riders.filter(p => !p.isBot);
  return humans.length >= 2 && humans.length === riders.length;
}

function pruneRaceLog(ctx: Ctx, id: Identity) {
  const rows = [...ctx.db.raceLog.byAccount.filter(id)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 0; i < rows.length - LOG_KEEP; i++) ctx.db.raceLog.id.delete(rows[i].id);
}

// Pay out a finished race. MUST be called with the roster still holding its
// raceId — the cleanup that zeroes it runs afterwards, and calling this after
// it would silently award nothing, on every race.
function awardProgression(ctx: Ctx, lobby: LobbyRow | null | undefined, race: RaceRow, riders: PlayerRow[]) {
  const field = riders.length;
  if (field === 0) return;
  const ranked = isRanked(lobby, riders);
  const hasBots = riders.some(p => p.isBot);
  const before = new Map<string, AccountRow | undefined>();
  for (const p of riders) before.set(p.identity.toHexString(), accountOf(ctx, p.identity));

  for (const p of riders) {
    if (p.isBot) continue;
    const acc = before.get(p.identity.toHexString());
    if (!acc) continue;
    const place = p.place || field;
    const won = place === 1;

    // XP: turning up, everyone you beat, and a bonus for the win.
    let xp = XP_FINISH + XP_PER_BEATEN * Math.max(0, field - place) + (won ? XP_WIN : 0);
    if (hasBots || lobby?.vsBot) xp = Math.round(xp * XP_BOT_SCALE);

    // MMR: pairwise Elo across the field, averaged.
    let mmrAfter = acc.mmr;
    if (ranked && field >= 2) {
      const k = kFactor(acc.ranked);
      let sum = 0;
      for (const o of riders) {
        if (o.identity.toHexString() === p.identity.toHexString()) continue;
        const theirs = before.get(o.identity.toHexString())?.mmr ?? MMR_START;
        const expected = 1 / (1 + Math.pow(10, (theirs - acc.mmr) / 400));
        const score = place < (o.place || field) ? 1 : 0;
        sum += score - expected;
      }
      const raw = (k * sum) / (field - 1);
      const delta = raw >= 0 ? Math.max(1, Math.round(raw)) : Math.min(-1, Math.round(raw));
      mmrAfter = clamp(acc.mmr + delta, 100, 4000);
    }

    const xpBefore = acc.xp;
    const xpAfter = acc.xp + xp;
    const level = levelFor(xpAfter);
    const topKmh = Math.round(p.topV * 3.6);
    const next: AccountRow = {
      ...acc,
      xp: xpAfter,
      level,
      mmr: mmrAfter,
      peakMmr: Math.max(acc.peakMmr, mmrAfter),
      ranked: ranked ? acc.ranked + 1 : acc.ranked,
      rankedWins: ranked && won ? acc.rankedWins + 1 : acc.rankedWins,
      casual: ranked ? acc.casual : acc.casual + 1,
      casualWins: !ranked && won ? acc.casualWins + 1 : acc.casualWins,
      streak: won ? Math.max(1, acc.streak + 1) : Math.min(-1, acc.streak - 1),
      bestStreak: won ? Math.max(acc.bestStreak, Math.max(1, acc.streak + 1)) : acc.bestStreak,
      races: acc.races + 1,
      wins: won ? acc.wins + 1 : acc.wins,
      podiums: place <= 3 ? acc.podiums + 1 : acc.podiums,
      botWins: won && hasBots ? acc.botWins + 1 : acc.botWins,
      tricks: acc.tricks + p.tricksDone,
      topSpeed: Math.max(acc.topSpeed, Math.min(65535, topKmh)),
      courseWins: won ? acc.courseWins | (1 << clamp(race.courseId, 0, 31)) : acc.courseWins,
      rev: acc.rev + 1,
    };
    ctx.db.account.identity.update(next);

    ctx.db.raceLog.insert({
      id: 0n,
      identity: p.identity,
      raceId: race.id,
      courseId: race.courseId,
      place,
      riders: field,
      timeTicks: p.finishTicks || race.elapsed,
      ranked,
      mmrBefore: acc.mmr,
      mmrAfter,
      xpBefore,
      xpGained: xp,
      levelAfter: level,
      topSpeed: Math.min(65535, topKmh),
      tricks: p.tricksDone,
      endedBy: p.finishTicks > 0 ? END_FINISHED : END_DNF,
      playedAt: ctx.timestamp,
    });
    pruneRaceLog(ctx, p.identity);
  }
}

// ---------------------------------------------------------------------------
// Cross-game championship: the finishing order, written exactly once.
// ---------------------------------------------------------------------------
function recordLegResult(ctx: Ctx, lobby: LobbyRow, order: PlayerRow[]) {
  if (lobby.championshipLeg === 0n) return;
  for (const _ of ctx.db.legResult.byLeg.filter(lobby.championshipLeg)) return; // already written
  ctx.db.legResult.insert({
    id: 0n,
    legId: lobby.championshipLeg,
    placings: order.map(p => p.identity),
    names: order.map(p => p.name),
    finishedAt: ctx.timestamp,
  });
}

// ---------------------------------------------------------------------------
// Finishing a race, and what a cup does next.
// ---------------------------------------------------------------------------
function finishRace(ctx: Ctx, race: RaceRow) {
  if (race.state === R_DONE) return;
  deleteTickTimers(ctx, race.id);
  deleteGraceTimers(ctx, race.id);
  const lobby = ctx.db.lobby.id.find(race.lobbyId);

  // Anyone still out on the hill is classified where they got to.
  const riders = raceRiders(ctx, race.id);
  const unplaced = riders.filter(p => p.place === 0).sort((a, b) => b.s - a.s);
  let next = riders.filter(p => p.place > 0).length;
  for (const p of unplaced) {
    next++;
    ctx.db.player.identity.update({ ...p, place: next, finishTicks: 0 });
  }
  const final = raceRiders(ctx, race.id).sort((a, b) => a.place - b.place);

  // Cup points, before the roster is released.
  if (lobby && lobby.mode === M_CUP) {
    for (const p of final) {
      const pts = CUP_POINTS[Math.min(CUP_POINTS.length - 1, Math.max(0, p.place - 1))] ?? 0;
      ctx.db.player.identity.update({ ...p, cupPoints: p.cupPoints + pts });
    }
  }

  awardProgression(ctx, lobby, race, final);

  const winner = final[0];
  ctx.db.race.id.update({
    ...race,
    state: R_DONE,
    winnerName: winner?.name ?? '',
    finished: final.length,
    haltUntil: 0n,
    haltName: '',
  });

  if (!lobby) return;

  if (lobby.mode === M_CUP && lobby.stage + 1 < lobby.stages) {
    // Another leg: roll a new course, show the standings, drop the gate again.
    const stage = lobby.stage + 1;
    const nextCourse = pickCupCourse(ctx, lobby, stage);
    const rolled = ctx.db.lobby.id.update({
      ...lobby,
      stage,
      courseId: nextCourse,
      seed: rollSeed(ctx, stage * 977),
    });
    openRace(ctx, rolled, true);
    return;
  }

  // The room is done. In a cup the champion is the points leader.
  let championName = winner?.name ?? '';
  if (lobby.mode === M_CUP) {
    const standings = [...lobbyRiders(ctx, lobby.id)].sort((a, b) => b.cupPoints - a.cupPoints);
    championName = standings[0]?.name ?? championName;
    const champ = standings[0];
    if (champ && !champ.isBot) {
      const acc = accountOf(ctx, champ.identity);
      if (acc) ctx.db.account.identity.update({ ...acc, cupWins: acc.cupWins + 1, rev: acc.rev + 1 });
    }
    recordLegResult(ctx, lobby, standings);
  } else {
    recordLegResult(ctx, lobby, final);
  }
  ctx.db.lobby.id.update({ ...lobby, status: L_FINISHED, championName });
}

// A cup runs different hills each leg, and only ones the host can ride.
function pickCupCourse(ctx: Ctx, lobby: LobbyRow, stage: number): number {
  const acc = accountOf(ctx, lobby.hostId);
  const open: number[] = [];
  for (let i = 0; i < COURSE_COUNT; i++) if (courseUnlocked(acc, i)) open.push(i);
  if (open.length === 0) return 0;
  const rng = makeRng(rollSeed(ctx, stage * 5171));
  const pick = open[Math.floor(rng() * open.length)];
  return pick === lobby.courseId && open.length > 1 ? open[(open.indexOf(pick) + 1) % open.length] : pick;
}

// ---------------------------------------------------------------------------
// The tick: one scheduled reducer per live race, 30 Hz.
// ---------------------------------------------------------------------------
export const race_tick = spacetimedb.reducer(
  { onSchedule: TickTimer },
  { arg: TickTimer.rowType },
  (ctx, { arg }) => {
    console.log(`tick race=${arg.raceId}`);
    const race = ctx.db.race.id.find(arg.raceId);
    if (!race || race.state === R_DONE) {
      ctx.db.tickTimer.scheduledId.delete(arg.scheduledId);
      return;
    }
    // Halted: somebody dropped and the grace window is running. haltRace
    // already deleted this timer — this only catches one that outlived it.
    if (race.haltUntil !== 0n) {
      ctx.db.tickTimer.scheduledId.delete(arg.scheduledId);
      return;
    }
    const lobby = ctx.db.lobby.id.find(race.lobbyId);
    const phys = lobbyPhysics(lobby);
    const course = getCourse(race.courseId, race.seed);
    const riders = raceRiders(ctx, race.id);

    // --- the gate ----------------------------------------------------------
    if (race.state === R_COUNTDOWN) {
      const left = race.startTicks - 1;
      // The holeshot: the throttle pressed AS the gate drops is worth a shove;
      // stabbed at it early it is a jump start, and costs you. It is the
      // PRESS that is timed, not the holding — `hopTicks` remembers last
      // tick's state, so a rider who simply holds the throttle through the
      // countdown gets neither the shove nor the penalty.
      for (const p of riders) {
        if (p.isBot || p.crashTicks > 0) continue;
        const pressed = (p.btn & BTN_HOP) !== 0 || p.dirY > 0;
        const wasPressed = p.hopTicks > 0;
        let row = p;
        if (pressed && !wasPressed && p.boost === 0) {
          if (left <= ticks(0.35)) {
            row = { ...row, boost: 550, fxKind: FX_BOOSTPAD, fxTicks: FX_TICKS };
          } else if (left < ticks(2)) {
            row = { ...row, crashTicks: ticks(0.9), fxKind: FX_CRASH, fxTicks: FX_TICKS };
          }
        }
        if (pressed !== wasPressed || row !== p) {
          ctx.db.player.identity.update({ ...row, hopTicks: pressed ? 1 : 0 });
        }
      }
      if (left <= 0) {
        // Bots get their shove for free, scaled by how sharp they are.
        for (const p of raceRiders(ctx, race.id)) {
          if (!p.isBot) continue;
          const prof = botProfileAt(p.botSkill === BOT_SKILL_UNSET ? lobbySkill(lobby) : p.botSkill);
          ctx.db.player.identity.update({ ...p, boost: Math.round(550 * prof.throttle * prof.boost) });
        }
        ctx.db.race.id.update({ ...race, state: R_LIVE, startTicks: 0, elapsed: 0 });
      } else {
        ctx.db.race.id.update({ ...race, startTicks: left });
      }
      return;
    }

    // --- the race ----------------------------------------------------------
    const elapsed = race.elapsed + 1;
    let finished = race.finished;
    let leaderName = race.leaderName;
    let leaderS = -1;

    for (const p of riders) {
      if (p.place > 0) continue; // home already — the run-out is the client's

      const st = rideStats(p.characterId, p.bikeId);
      const r: Rider = {
        s: p.s, n: p.n, v: p.v, yaw: p.yaw, z: p.z, vz: p.vz,
        pitch: p.pitch, lean: p.lean, boost: p.boost, boosting: p.boosting,
        airTicks: p.airTicks, crashTicks: p.crashTicks,
        trickKind: p.trickKind, trickSpin: p.trickSpin, slip: p.slip,
        hopTicks: p.hopTicks, fxKind: p.fxKind, fxTicks: p.fxTicks, tricks: 0,
      };

      // Drafting: sitting in the hole another rider punches in the air.
      let draft = false;
      for (const o of riders) {
        if (o.identity.toHexString() === p.identity.toHexString()) continue;
        const gap = o.s - p.s;
        if (gap > 1 && gap < DRAFT_DIST && Math.abs(o.n - p.n) < 3.5 && r.airTicks === 0) {
          draft = true;
          break;
        }
      }

      const inp: Input = p.isBot
        ? botInput(
            r,
            course,
            botProfileAt(p.botSkill === BOT_SKILL_UNSET ? lobbySkill(lobby) : p.botSkill),
            st,
            p.characterId * 31 + p.bikeId * 7 + p.name.length
          )
        : {
            steer: clamp(p.dirX, -1, 1),
            throttle: clamp(p.dirY, -1, 1),
            hop: (p.btn & BTN_HOP) !== 0,
            trick: (p.btn & BTN_TRICK) !== 0,
            boost: (p.btn & BTN_BOOST) !== 0,
          };

      stepRider(r, course, st, phys, inp, draft);

      let place = p.place;
      let finishTicks = p.finishTicks;
      if (r.s >= race.length) {
        finished++;
        place = finished;
        finishTicks = elapsed;
        r.s = race.length;
      }
      if (r.s > leaderS) {
        leaderS = r.s;
        leaderName = p.name;
      }

      ctx.db.player.identity.update({
        ...p,
        s: r.s, n: r.n, v: r.v, yaw: r.yaw, z: r.z, vz: r.vz,
        pitch: r.pitch, lean: r.lean,
        boost: clamp(Math.round(r.boost), 0, BOOST_MAX),
        boosting: r.boosting,
        airTicks: Math.min(65535, r.airTicks),
        crashTicks: clamp(Math.round(r.crashTicks), 0, 255),
        trickKind: r.trickKind,
        trickSpin: r.trickSpin,
        slip: r.slip,
        hopTicks: clamp(Math.round(r.hopTicks), 0, 255),
        fxKind: r.fxKind,
        fxTicks: clamp(Math.round(r.fxTicks), 0, 255),
        place,
        finishTicks,
        topV: Math.max(p.topV, r.v),
        tricksDone: Math.min(65535, p.tricksDone + r.tricks),
      });
    }

    // --- is it over? -------------------------------------------------------
    // Once the winner is home the rest ride against a cutoff, so one rider
    // stuck in a bush never holds the room.
    let cutoff = race.cutoff;
    if (finished > 0 && cutoff === 0) cutoff = elapsed + ticks(45);
    const done = finished >= riders.length || (cutoff !== 0 && elapsed >= cutoff) || riders.length === 0;
    ctx.db.race.id.update({ ...race, elapsed, finished, leaderName, cutoff });
    if (done) finishRace(ctx, ctx.db.race.id.find(race.id)!);
  }
);

// ---------------------------------------------------------------------------
// Lobbies
// ---------------------------------------------------------------------------
function clampPhys(v: { gravityMul: number; gripMul: number; speedMul: number; airMul: number }) {
  return {
    gravityMul: clamp(v.gravityMul, 0.4, 2),
    gripMul: clamp(v.gripMul, 0.4, 2),
    speedMul: clamp(v.speedMul, 0.5, 2),
    airMul: clamp(v.airMul, 0.4, 3),
  };
}

function insertLobby(
  ctx: Ctx,
  opts: {
    mode: number; courseId: number; vsBot: boolean; isPublic: boolean;
    botLevel: number; botSkill: number; botFill: boolean; stages: number;
    gravityMul: number; gripMul: number; speedMul: number; airMul: number;
    championshipLeg?: bigint;
  }
): LobbyRow {
  const ph = clampPhys(opts);
  return ctx.db.lobby.insert({
    id: 0n,
    code: generateCode(ctx),
    hostId: ctx.sender,
    mode: opts.mode,
    status: L_OPEN,
    vsBot: opts.vsBot,
    courseId: clamp(opts.courseId, 0, COURSE_COUNT - 1),
    seed: rollSeed(ctx, 17),
    stage: 0,
    stages: clamp(opts.stages, 1, 8),
    botFill: opts.botFill,
    botLevel: clamp(opts.botLevel, 0, 2),
    botSkill: opts.botSkill,
    championName: '',
    createdAt: ctx.timestamp,
    isPublic: opts.isPublic,
    gravityMul: ph.gravityMul,
    gripMul: ph.gripMul,
    speedMul: ph.speedMul,
    airMul: ph.airMul,
    championshipLeg: opts.championshipLeg ?? 0n,
  });
}

function leaveCurrentLobby(ctx: Ctx, player: PlayerRow) {
  if (player.lobbyId === 0n) return;
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  const race = player.raceId !== 0n ? ctx.db.race.id.find(player.raceId) : undefined;
  ctx.db.player.identity.update({
    ...player,
    lobbyId: 0n, raceId: 0n, place: 0, cupPoints: 0,
    ready: false, spectator: false, s: 0, n: 0, v: 0, boost: 0,
  });
  if (!lobby) return;
  // Walking out of a live race is a DNF, not a pause.
  if (race && race.state !== R_DONE) {
    const left = raceRiders(ctx, race.id);
    if (left.length === 0) finishRace(ctx, race);
    else {
      ctx.db.race.id.update({ ...race, riders: left.length });
      syncPresence(ctx, race.id);
    }
  }
  const humans = lobbyPlayers(ctx, lobby.id).filter(p => !p.isBot);
  if (humans.length === 0) {
    destroyLobby(ctx, lobby);
    return;
  }
  // The host walking out hands the room to whoever is still in it.
  if (lobby.hostId.toHexString() === player.identity.toHexString()) {
    ctx.db.lobby.id.update({ ...lobby, hostId: humans[0].identity });
  }
}

export const create_lobby = spacetimedb.reducer(
  {
    mode: t.u8(), courseId: t.u8(), isPublic: t.bool(), botFill: t.bool(),
    botLevel: t.u8(), stages: t.u8(),
    gravityMul: t.f32(), gripMul: t.f32(), speedMul: t.f32(), airMul: t.f32(),
  },
  (ctx, a) => {
    const player = getPlayer(ctx);
    requireCourseUnlocked(ctx, a.courseId);
    leaveCurrentLobby(ctx, player);
    const lobby = insertLobby(ctx, {
      mode: a.mode === M_CUP ? M_CUP : M_RACE,
      courseId: a.courseId,
      vsBot: false,
      isPublic: a.isPublic,
      botLevel: a.botLevel,
      botSkill: BOT_SKILL_UNSET,
      botFill: a.botFill,
      stages: a.mode === M_CUP ? (a.stages || CUP_STAGES) : 1,
      gravityMul: a.gravityMul, gripMul: a.gripMul, speedMul: a.speedMul, airMul: a.airMul,
    });
    ctx.db.player.identity.update({
      ...ctx.db.player.identity.find(ctx.sender)!,
      lobbyId: lobby.id, raceId: 0n, place: 0, cupPoints: 0, ready: false, kicked: false, spectator: false,
    });
  }
);

// Free ride / time trial: straight onto the hill, alone or with bots.
export const create_practice = spacetimedb.reducer(
  { courseId: t.u8(), botLevel: t.u8(), bots: t.u8() },
  (ctx, { courseId, botLevel, bots }) => {
    const player = getPlayer(ctx);
    requireCourseUnlocked(ctx, courseId);
    leaveCurrentLobby(ctx, player);
    const lobby = insertLobby(ctx, {
      mode: M_RACE, courseId, vsBot: true, isPublic: false,
      botLevel, botSkill: BOT_SKILL_UNSET, botFill: bots > 0, stages: 1,
      gravityMul: 1, gripMul: 1, speedMul: 1, airMul: 1,
    });
    ctx.db.player.identity.update({
      ...ctx.db.player.identity.find(ctx.sender)!,
      lobbyId: lobby.id, raceId: 0n, place: 0, cupPoints: 0, ready: true, kicked: false, spectator: false,
    });
    if (bots > 0) fillWithBots(ctx, lobby, clamp(bots + 1, 2, MAX_RIDERS));
    ctx.db.lobby.id.update({ ...lobby, status: L_RUNNING });
    openRace(ctx, ctx.db.lobby.id.find(lobby.id)!);
  }
);

export const join_lobby = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const player = getPlayer(ctx);
  const lobby = ctx.db.lobby.code.find(code.trim().toUpperCase());
  if (!lobby) throw new SenderError('No room with that code');
  if (lobby.status === L_FINISHED) throw new SenderError('That race is over');
  if (player.lobbyId === lobby.id) return;
  leaveCurrentLobby(ctx, player);
  const riders = lobbyRiders(ctx, lobby.id);
  // A room that is already running, or already full, seats you in the stands.
  const spectator = lobby.status !== L_OPEN || riders.filter(p => !p.isBot).length >= MAX_RIDERS;
  const live = liveRace(ctx, lobby.id);
  ctx.db.player.identity.update({
    ...ctx.db.player.identity.find(ctx.sender)!,
    lobbyId: lobby.id,
    raceId: spectator && live ? live.id : 0n,
    place: 0, cupPoints: 0, ready: false, kicked: false, spectator,
  });
  disarmReaper(ctx, lobby.id);
  // A room the hub opened may be waiting for whoever walks in first.
  if (lobby.championshipLeg !== 0n && !ctx.db.player.identity.find(lobby.hostId)) {
    ctx.db.lobby.id.update({ ...lobby, hostId: ctx.sender });
  }
});

export const leave_lobby = spacetimedb.reducer(ctx => {
  leaveCurrentLobby(ctx, getPlayer(ctx));
});

export const set_ready = spacetimedb.reducer({ ready: t.bool() }, (ctx, { ready }) => {
  const player = getPlayer(ctx);
  if (player.lobbyId === 0n || player.spectator) return;
  ctx.db.player.identity.update({ ...player, ready });
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby || lobby.status !== L_OPEN) return;
  // A race starts itself the moment the last rider is ready — the host's
  // Start button is a shortcut past AFK seats, not the only way in.
  const riders = lobbyRiders(ctx, lobby.id).filter(p => !p.isBot);
  if (riders.length >= 2 && riders.every(p => p.ready)) startRace(ctx, lobby);
});

function startRace(ctx: Ctx, lobby: LobbyRow) {
  if (lobby.status !== L_OPEN) return;
  if (lobby.botFill) fillWithBots(ctx, lobby, MAX_RIDERS);
  const running = ctx.db.lobby.id.update({ ...lobby, status: L_RUNNING, stage: 0 });
  for (const p of lobbyRiders(ctx, lobby.id)) {
    ctx.db.player.identity.update({ ...p, cupPoints: 0 });
  }
  openRace(ctx, running);
}

export const start_match = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby) throw new SenderError('Not in a room');
  if (lobby.hostId.toHexString() !== ctx.sender.toHexString()) throw new SenderError('Only the host can start');
  const riders = lobbyRiders(ctx, lobby.id);
  if (riders.length < 1) throw new SenderError('Nobody on the grid');
  if (riders.length < 2 && !lobby.botFill) throw new SenderError('Needs another rider (or turn bot fill on)');
  startRace(ctx, lobby);
});

export const kick_player = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  const player = getPlayer(ctx);
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby || lobby.hostId.toHexString() !== ctx.sender.toHexString()) throw new SenderError('Only the host can do that');
  if (target.toHexString() === ctx.sender.toHexString()) return;
  const victim = ctx.db.player.identity.find(target);
  if (!victim || victim.lobbyId !== lobby.id) return;
  leaveCurrentLobby(ctx, victim);
  const after = ctx.db.player.identity.find(target);
  if (after) ctx.db.player.identity.update({ ...after, kicked: true });
});

export const set_lobby_settings = spacetimedb.reducer(
  {
    courseId: t.u8(), botLevel: t.u8(), botFill: t.bool(), stages: t.u8(), isPublic: t.bool(),
    gravityMul: t.f32(), gripMul: t.f32(), speedMul: t.f32(), airMul: t.f32(),
  },
  (ctx, a) => {
    const player = getPlayer(ctx);
    const lobby = ctx.db.lobby.id.find(player.lobbyId);
    if (!lobby) throw new SenderError('Not in a room');
    if (lobby.hostId.toHexString() !== ctx.sender.toHexString()) throw new SenderError('Only the host can do that');
    if (lobby.status !== L_OPEN) throw new SenderError('The race has already started');
    requireCourseUnlocked(ctx, a.courseId);
    const ph = clampPhys(a);
    ctx.db.lobby.id.update({
      ...lobby,
      courseId: clamp(a.courseId, 0, COURSE_COUNT - 1),
      botLevel: clamp(a.botLevel, 0, 2),
      botFill: a.botFill,
      stages: lobby.mode === M_CUP ? clamp(a.stages || CUP_STAGES, 1, 8) : 1,
      isPublic: a.isPublic,
      ...ph,
    });
  }
);

// Run the same room again: a fresh hill, everyone back on the gate.
export const rematch = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  const lobby = ctx.db.lobby.id.find(player.lobbyId);
  if (!lobby) throw new SenderError('Not in a room');
  if (lobby.hostId.toHexString() !== ctx.sender.toHexString()) throw new SenderError('Only the host can do that');
  for (const race of lobbyRaces(ctx, lobby.id)) {
    deleteTickTimers(ctx, race.id);
    deleteGraceTimers(ctx, race.id);
    ctx.db.race.id.delete(race.id);
  }
  for (const p of lobbyPlayers(ctx, lobby.id)) {
    ctx.db.player.identity.update({ ...p, raceId: 0n, place: 0, cupPoints: 0, ready: p.isBot, topV: 0, tricksDone: 0 });
  }
  const rolled = ctx.db.lobby.id.update({
    ...lobby,
    status: L_RUNNING,
    stage: 0,
    championName: '',
    seed: rollSeed(ctx, 4241),
  });
  openRace(ctx, rolled);
});

export const forfeit = spacetimedb.reducer(ctx => {
  const player = getPlayer(ctx);
  if (player.raceId === 0n) return;
  const acc = accountOf(ctx, ctx.sender);
  if (acc) ctx.db.account.identity.update({ ...acc, quits: acc.quits + 1, rev: acc.rev + 1 });
  leaveCurrentLobby(ctx, player);
});

// ---------------------------------------------------------------------------
// Identity, look and kit
// ---------------------------------------------------------------------------
function requireCourseUnlocked(ctx: Ctx, courseId: number) {
  const acc = accountOf(ctx, ctx.sender);
  if (!courseUnlocked(acc, clamp(courseId, 0, COURSE_COUNT - 1))) {
    throw new SenderError('That hill is still locked');
  }
}

export const set_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const clean = name.trim().slice(0, 16) || 'RIDER';
  const player = getPlayer(ctx);
  ctx.db.player.identity.update({ ...player, name: clean });
  const acc = accountOf(ctx, ctx.sender);
  if (acc && acc.displayName !== clean) {
    ctx.db.account.identity.update({ ...acc, displayName: clean, rev: acc.rev + 1 });
  }
});

export const set_character = spacetimedb.reducer(
  { characterId: t.u8(), bikeId: t.u8() },
  (ctx, { characterId, bikeId }) => {
    const player = getPlayer(ctx);
    const acc = accountOf(ctx, ctx.sender);
    const ch = clamp(characterId, 0, CHAR_RIDE.length - 1);
    const bk = clamp(bikeId, 0, BIKE_COUNT - 1);
    // Anyone already riding a character keeps it; a new pick is checked.
    if (ch !== player.characterId && !charUnlocked(acc, ch)) throw new SenderError('That rider is still locked');
    if (bk !== player.bikeId && !bikeUnlocked(acc, bk)) throw new SenderError('That bike is still locked');
    ctx.db.player.identity.update({ ...player, characterId: ch, bikeId: bk });
    if (acc && (acc.characterId !== ch || acc.bikeId !== bk)) {
      ctx.db.account.identity.update({ ...acc, characterId: ch, bikeId: bk, rev: acc.rev + 1 });
    }
  }
);

// ---------------------------------------------------------------------------
// Input. Clients send held direction + a button bitmask; nothing else.
// ---------------------------------------------------------------------------
export const set_input = spacetimedb.reducer(
  { dirX: t.i8(), dirY: t.i8(), btn: t.u8() },
  (ctx, { dirX, dirY, btn }) => {
    const player = ctx.db.player.identity.find(ctx.sender);
    if (!player) return;
    const x = clamp(dirX, -1, 1);
    const y = clamp(dirY, -1, 1);
    const b = btn & (BTN_HOP | BTN_TRICK | BTN_BOOST);
    if (player.dirX === x && player.dirY === y && player.btn === b) return; // no-op writes cost broadcast
    ctx.db.player.identity.update({ ...player, dirX: x, dirY: y, btn: b });
  }
);

// ---------------------------------------------------------------------------
// Chat + emotes
// ---------------------------------------------------------------------------
const CHAT_KEEP = 40;
const CHAT_GAP = 700_000n; // micros between messages
const CHAT_BURST = 5;
const MUTE_FOR = 15_000_000n;
const EMOTES = ['👍', '😂', '😱', '🤝', '🔥', '😤', '🙈', '🚀'];

function guardChat(ctx: Ctx, text: string) {
  if (text.length === 0 || text.length > 120) throw new SenderError('Message too long');
  const now = ctx.timestamp.microsSinceUnixEpoch;
  const g = ctx.db.chatGuard.identity.find(ctx.sender);
  if (!g) {
    ctx.db.chatGuard.insert({ identity: ctx.sender, lastAt: now, burst: 1, mutedUntil: 0n });
    return;
  }
  if (g.mutedUntil > now) throw new SenderError('Slow down');
  const gap = now - g.lastAt;
  const burst = gap < CHAT_GAP ? g.burst + 1 : 1;
  if (burst > CHAT_BURST) {
    ctx.db.chatGuard.identity.update({ ...g, lastAt: now, burst: 0, mutedUntil: now + MUTE_FOR });
    throw new SenderError('Slow down');
  }
  ctx.db.chatGuard.identity.update({ ...g, lastAt: now, burst });
}

function insertChat(ctx: Ctx, player: PlayerRow, emote: boolean, text: string) {
  if (player.lobbyId === 0n) return;
  ctx.db.chat.insert({
    id: 0n, lobbyId: player.lobbyId, senderName: player.name,
    emote, text, sentAt: ctx.timestamp,
  });
  const rows = [...ctx.db.chat.byLobby.filter(player.lobbyId)].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let i = 0; i < rows.length - CHAT_KEEP; i++) ctx.db.chat.id.delete(rows[i].id);
}

export const send_chat = spacetimedb.reducer({ text: t.string() }, (ctx, { text }) => {
  const clean = text.trim().slice(0, 120);
  guardChat(ctx, clean);
  insertChat(ctx, getPlayer(ctx), false, clean);
});

export const send_emote = spacetimedb.reducer({ index: t.u8() }, (ctx, { index }) => {
  guardChat(ctx, 'e');
  insertChat(ctx, getPlayer(ctx), true, EMOTES[clamp(index, 0, EMOTES.length - 1)]);
});

// ---------------------------------------------------------------------------
// Cross-game championship rooms (see the hub's relay).
// ---------------------------------------------------------------------------
function legOptions(settings: string): Record<string, unknown> {
  try {
    const o = JSON.parse(settings || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function legNum(o: Record<string, unknown>, key: string, def: number, lo: number, hi: number): number {
  const v = o[key];
  return typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : def;
}

export const create_championship_room = spacetimedb.reducer(
  { legId: t.u64(), settings: t.string() },
  (ctx, { legId, settings }) => {
    if (ctx.senderAuth.jwt?.issuer !== RELAY_ISSUER) throw new SenderError('Not authorized');
    const o = legOptions(settings);
    insertLobby(ctx, {
      mode: legNum(o, 'stages', 1, 1, 8) > 1 ? M_CUP : M_RACE,
      courseId: legNum(o, 'courseId', 0, 0, COURSE_COUNT - 1),
      vsBot: false,
      isPublic: false,
      botLevel: legNum(o, 'botLevel', 1, 0, 2),
      botSkill: BOT_SKILL_UNSET,
      botFill: true,
      stages: legNum(o, 'stages', 1, 1, 8),
      gravityMul: legNum(o, 'gravityMul', 1, 0.4, 2),
      gripMul: legNum(o, 'gripMul', 1, 0.4, 2),
      speedMul: legNum(o, 'speedMul', 1, 0.5, 2),
      airMul: legNum(o, 'airMul', 1, 0.4, 3),
      championshipLeg: legId,
    });
  }
);

// ---------------------------------------------------------------------------
// Profile service bridge. This database is the GAME ENGINE and is expected to
// be wiped; profiles/ mirrors the account table into SQLite and seeds it back
// afterwards. SpacetimeDB stays the authority that COMPUTES progression.
// ---------------------------------------------------------------------------
function requireProfileService(ctx: Ctx) {
  if (ctx.senderAuth.jwt?.issuer !== PROFILE_SERVICE_ISSUER) throw new SenderError('Not authorized');
}

export const restore_account = spacetimedb.reducer(
  {
    identity: t.identity(), uid: t.string(), provider: t.u8(), displayName: t.string(),
    characterId: t.u8(), bikeId: t.u8(), xp: t.u32(), level: t.u16(), mmr: t.u16(), peakMmr: t.u16(),
    ranked: t.u16(), rankedWins: t.u16(), casual: t.u16(), casualWins: t.u16(),
    streak: t.i16(), bestStreak: t.u16(), quits: t.u16(), rev: t.u32(),
    races: t.u16(), wins: t.u16(), podiums: t.u16(), botWins: t.u16(),
    tricks: t.u32(), topSpeed: t.u16(), cupWins: t.u16(), courseWins: t.u32(),
    cupStage: t.u8(), cupRound: t.u8(),
  },
  (ctx, a) => {
    requireProfileService(ctx);
    const existing = ctx.db.account.identity.find(a.identity);
    // Never roll a live database back with a stale copy.
    if (existing && existing.rev >= a.rev) return;
    const row = {
      identity: a.identity,
      uid: a.uid,
      provider: a.provider,
      displayName: a.displayName,
      characterId: a.characterId,
      bikeId: a.bikeId,
      xp: a.xp,
      level: a.level,
      mmr: a.mmr,
      peakMmr: a.peakMmr,
      ranked: a.ranked,
      rankedWins: a.rankedWins,
      casual: a.casual,
      casualWins: a.casualWins,
      streak: a.streak,
      bestStreak: a.bestStreak,
      quits: a.quits,
      createdAt: existing?.createdAt ?? ctx.timestamp,
      lastSeen: ctx.timestamp,
      rev: a.rev,
      races: a.races,
      wins: a.wins,
      podiums: a.podiums,
      botWins: a.botWins,
      tricks: a.tricks,
      topSpeed: a.topSpeed,
      cupWins: a.cupWins,
      courseWins: a.courseWins,
      cupStage: a.cupStage,
      cupRound: a.cupRound,
    };
    if (existing) ctx.db.account.identity.update(row);
    else ctx.db.account.insert(row);
  }
);

// A player's own results. Index lookup, never .iter() — a view that scans
// re-evaluates on any row change in the table.
export const my_race_log = spacetimedb.view(
  { name: 'my_race_log', public: true },
  t.array(RaceLog.rowType),
  ctx => [...ctx.db.raceLog.byAccount.filter(ctx.sender)]
);

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------
export const onConnect = spacetimedb.clientConnected(ctx => {
  const connId = ctx.connectionId;
  if (connId) {
    ctx.db.session.insert({ connectionId: connId, identity: ctx.sender, startedAt: ctx.timestamp });
  }
  const account = ensureAccount(ctx);
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (!existing) {
    ctx.db.player.insert({
      identity: ctx.sender,
      name: account.displayName,
      lobbyId: 0n,
      raceId: 0n,
      characterId: account.characterId,
      bikeId: account.bikeId,
      s: 0, n: 0, v: 0, yaw: 0, z: 0, vz: 0, pitch: 0, lean: 0,
      boost: 0, boosting: false, airTicks: 0, crashTicks: 0,
      trickKind: 0, trickSpin: 0, slip: 0,
      place: 0, finishTicks: 0, cupPoints: 0,
      dirX: 0, dirY: 0, btn: 0, hopTicks: 0,
      fxKind: 0, fxTicks: 0,
      online: true, isBot: false, spectator: false, ready: false, kicked: false,
      botSkill: BOT_SKILL_UNSET, topV: 0, tricksDone: 0,
    });
    return;
  }
  ctx.db.player.identity.update({
    ...existing,
    online: true,
    name: existing.name || account.displayName,
  });
  if (existing.lobbyId !== 0n) disarmReaper(ctx, existing.lobbyId);
  if (existing.raceId !== 0n) syncPresence(ctx, existing.raceId);
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const connId = ctx.connectionId;
  if (connId) ctx.db.session.connectionId.delete(connId);
  // Another tab still holds this identity — nothing has actually gone away.
  if (hasSession(ctx, ctx.sender)) return;
  const player = ctx.db.player.identity.find(ctx.sender);
  if (!player) return;
  // A direction held when the socket dropped must not keep riding.
  ctx.db.player.identity.update({ ...player, online: false, dirX: 0, dirY: 0, btn: 0 });
  if (player.raceId !== 0n) syncPresence(ctx, player.raceId);
  if (player.lobbyId !== 0n && !lobbyHasPresence(ctx, player.lobbyId)) armReaper(ctx, player.lobbyId);
});
