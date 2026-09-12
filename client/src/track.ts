// ---------------------------------------------------------------------------
// The track generator — a MIRROR of the block of the same name in
// spacetimedb/src/index.ts. Keep the two in sync: only `courseId` and `seed`
// ever go on the wire, and both sides rebuild the identical course from them.
// A divergence here means the rider you see is not the rider the server is
// simulating.
// ---------------------------------------------------------------------------
export const SEG_LEN = 40; // metres per segment

export const BIO_ALPINE = 0;
export const BIO_FOREST = 1;
export const BIO_CANYON = 2;
export const BIO_MUD = 3;
export const BIO_DUNES = 4;
export const BIO_VILLAGE = 5;

export interface Biome {
  grip: number;
  roll: number;
  curv: number;
  width: number;
  rough: number;
  kicker: number;
  rocks: number;
  whoops: number;
  log: number;
  logx: number;
  puddle: number;
}

export const BIOMES: Biome[] = [
  { grip: 0.86, roll: 0.10, curv: 0.0060, width: 15, rough: 0.35, kicker: 0.20, rocks: 0.05, whoops: 0.05, log: 0.07, logx: 0.05, puddle: 0.02 },
  { grip: 1.06, roll: 0.13, curv: 0.0135, width: 9, rough: 0.45, kicker: 0.10, rocks: 0.13, whoops: 0.07, log: 0.16, logx: 0.12, puddle: 0.05 },
  { grip: 0.96, roll: 0.12, curv: 0.0085, width: 13, rough: 0.40, kicker: 0.18, rocks: 0.10, whoops: 0.06, log: 0.05, logx: 0.05, puddle: 0.03 },
  { grip: 0.74, roll: 0.20, curv: 0.0120, width: 10, rough: 0.55, kicker: 0.08, rocks: 0.08, whoops: 0.12, log: 0.10, logx: 0.09, puddle: 0.22 },
  { grip: 0.88, roll: 0.26, curv: 0.0070, width: 16, rough: 0.60, kicker: 0.16, rocks: 0.05, whoops: 0.22, log: 0.04, logx: 0.04, puddle: 0.02 },
  { grip: 1.18, roll: 0.08, curv: 0.0095, width: 9, rough: 0.20, kicker: 0.12, rocks: 0.06, whoops: 0.04, log: 0.06, logx: 0.06, puddle: 0.06 },
];

export const F_NONE = 0;
export const F_KICKER = 1;
export const F_WHOOPS = 2;
export const F_ROCKS = 3;
export const F_DROP = 4;
export const F_NARROW = 5;
export const F_BOOST = 6;
export const F_LOG = 7; // a felled trunk lying ALONG the track: ride it, grind it
export const F_LOGX = 8; // trunks lying ACROSS the track: hop them
export const F_PUDDLE = 9; // standing water / deep mud
export const F_BALES = 10; // bales lining the corridor

export interface Segment {
  curv: number;
  pitch: number;
  halfWidth: number;
  biome: number;
  feature: number;
  featureArg: number;
}

export interface CourseDef {
  id: number;
  segs: number;
  plan: number[];
  difficulty: number;
}

export const COURSE_DEFS: CourseDef[] = [
  { id: 0, segs: 108, plan: [BIO_ALPINE, BIO_ALPINE, BIO_FOREST, BIO_FOREST, BIO_VILLAGE], difficulty: 0 },
  { id: 1, segs: 120, plan: [BIO_FOREST, BIO_CANYON, BIO_CANYON, BIO_MUD, BIO_VILLAGE], difficulty: 1 },
  { id: 2, segs: 132, plan: [BIO_ALPINE, BIO_MUD, BIO_MUD, BIO_FOREST, BIO_FOREST, BIO_VILLAGE], difficulty: 2 },
  { id: 3, segs: 126, plan: [BIO_CANYON, BIO_DUNES, BIO_DUNES, BIO_CANYON, BIO_VILLAGE], difficulty: 1 },
  { id: 4, segs: 150, plan: [BIO_ALPINE, BIO_FOREST, BIO_CANYON, BIO_MUD, BIO_DUNES, BIO_VILLAGE], difficulty: 2 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

// mulberry32 — identical output in every JS engine. Do not "improve" it.
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSegments(courseId: number, seed: number): Segment[] {
  const c = COURSE_DEFS[courseId] ?? COURSE_DEFS[0];
  const rng = makeRng(seed ^ (courseId * 0x9e3779b1));
  const segs: Segment[] = [];
  const diff = 0.8 + c.difficulty * 0.22;
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
      const forced = straightRun > 4;
      const mag = (forced ? 0.45 + rng() * 0.55 : rng() * rng()) * maxC;
      const dir = rng() < 0.5 ? -1 : 1;
      curvTarget = mag * dir;
      hold = 2 + Math.floor(rng() * 4);
      straightRun = Math.abs(curvTarget) < b.curv * 0.2 ? straightRun + hold : 0;
    }
    hold--;
    curv = lerp(curv, curvTarget, 0.45);
    const steep = 0.30 - 0.16 * u;
    const pitch = clamp(steep + (rng() - 0.5) * 0.11, 0.05, 0.42);
    const halfWidth = b.width * (0.82 + rng() * 0.36) * (1 - Math.min(0.3, (Math.abs(curv) / b.curv) * 0.3));
    let feature = F_NONE;
    let featureArg = 0;
    if (i > 2 && i < c.segs - 2) {
      // One roll, walked through the biome's weights in a fixed order — the
      // module does exactly this, in exactly this order.
      const r = rng();
      const dens = 0.85 + c.difficulty * 0.2;
      let acc = 0;
      const take = (w: number) => {
        acc += w * dens;
        return r < acc;
      };
      if (take(b.kicker)) {
        feature = F_KICKER;
        featureArg = 0.7 + rng() * 0.75;
      } else if (take(b.rocks)) {
        feature = F_ROCKS;
        featureArg = (rng() * 2 - 1) * halfWidth * 0.75;
      } else if (take(b.whoops)) {
        feature = F_WHOOPS;
        featureArg = 0.6 + rng() * 0.7;
      } else if (take(b.log)) {
        feature = F_LOG;
        featureArg = (rng() * 2 - 1) * halfWidth * 0.55;
      } else if (take(b.logx)) {
        feature = F_LOGX;
        featureArg = 0.6 + rng() * 0.6;
      } else if (take(b.puddle)) {
        feature = F_PUDDLE;
        featureArg = (rng() * 2 - 1) * halfWidth * 0.5;
      } else if (take(0.05)) {
        feature = F_DROP;
        featureArg = 0.8 + rng() * 0.9;
      } else if (take(0.04)) {
        feature = F_NARROW;
        featureArg = 0.45 + rng() * 0.2;
      } else if (take(0.05)) {
        feature = F_BOOST;
        featureArg = (rng() * 2 - 1) * halfWidth * 0.5;
      } else if (take(0.05)) {
        feature = F_BALES;
        featureArg = 1;
      }
    }
    if (feature === F_NARROW) featureArg = clamp(featureArg, 0.4, 0.7);
    segs.push({ curv, pitch, halfWidth, biome, feature, featureArg });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// World space. The server never needs this — it lives in track space — but the
// renderer does: integrating curvature gives the heading, integrating that
// gives the centreline, and integrating sin(pitch) gives the altitude.
// ---------------------------------------------------------------------------
export interface CoursePoint {
  x: number;
  y: number; // altitude
  z: number;
  heading: number; // world heading of the tangent (radians)
  pitch: number;
  halfWidth: number;
  biome: number;
  feature: number;
  featureArg: number;
  curv: number;
}

export interface Course {
  id: number;
  seed: number;
  segs: Segment[];
  pts: CoursePoint[]; // one per segment start, plus a closing point
  length: number;
  alt: number[];
}

export function buildCourse(courseId: number, seed: number): Course {
  const segs = buildSegments(courseId, seed);
  const pts: CoursePoint[] = [];
  const alt: number[] = [];
  let x = 0;
  let z = 0;
  let y = 0;
  let heading = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    alt.push(y);
    pts.push({
      x, y, z,
      heading,
      pitch: s.pitch,
      halfWidth: s.halfWidth,
      biome: s.biome,
      feature: s.feature,
      featureArg: s.featureArg,
      curv: s.curv,
    });
    // Advance one segment: turn through the segment's curvature as we go.
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const d = SEG_LEN / steps;
      heading += s.curv * d;
      x += Math.cos(heading) * d * Math.cos(s.pitch);
      z += Math.sin(heading) * d * Math.cos(s.pitch);
      y -= Math.sin(s.pitch) * d;
    }
  }
  const last = segs[segs.length - 1];
  pts.push({
    x, y, z, heading,
    pitch: last.pitch,
    halfWidth: last.halfWidth,
    biome: last.biome,
    feature: F_NONE,
    featureArg: 0,
    curv: 0,
  });
  return { id: courseId, seed, segs, pts, length: segs.length * SEG_LEN, alt };
}

export const segIndexAt = (course: Course, s: number) =>
  clamp(Math.floor(s / SEG_LEN), 0, course.segs.length - 1);
export const segmentAt = (course: Course, s: number) => course.segs[segIndexAt(course, s)];

// Altitude of the centreline — must agree with groundAt() in the module.
export function groundAt(course: Course, s: number): number {
  const idx = segIndexAt(course, s);
  return course.alt[idx] - Math.sin(course.segs[idx].pitch) * (s - idx * SEG_LEN);
}

// The lateral axis: the tangent turned a quarter turn to the LEFT. The sign
// matters — the module moves a rider across the track with n += v·sin(yaw),
// so if this were the right-hand normal every corner would be mirrored
// against the simulation.
export function lateral(heading: number): { x: number; z: number } {
  return { x: -Math.sin(heading), z: Math.cos(heading) };
}

// World position of a point (s, n) on the track, for the renderer.
export function trackPoint(course: Course, s: number, n: number): { x: number; y: number; z: number; heading: number } {
  const idx = segIndexAt(course, s);
  const a = course.pts[idx];
  const bpt = course.pts[idx + 1] ?? a;
  const k = clamp((s - idx * SEG_LEN) / SEG_LEN, 0, 1);
  const heading = a.heading + (bpt.heading - a.heading) * k;
  const cx = a.x + (bpt.x - a.x) * k;
  const cz = a.z + (bpt.z - a.z) * k;
  const y = groundAt(course, s);
  const lat = lateral(heading);
  return { x: cx + lat.x * n, y, z: cz + lat.z * n, heading };
}

export function halfWidthAt(course: Course, s: number): number {
  const sg = segmentAt(course, s);
  return sg.feature === F_NARROW ? sg.halfWidth * sg.featureArg : sg.halfWidth;
}
