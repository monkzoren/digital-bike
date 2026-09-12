import * as THREE from 'three';
import {
  buildCourse, trackPoint, groundAt, segmentAt, halfWidthAt, lateral,
  SEG_LEN, F_KICKER, F_ROCKS, F_BOOST, F_NARROW, F_WHOOPS, F_DROP,
  type Course,
} from './track';
import { BIOME_LOOK } from './courses';
import { BIKES } from './bikes';
import { CHARACTERS, type Character } from './characters';
import {
  makePlayerRig, applyCharacter, applyPhysique, applyPose, ZERO_POSE,
  type PlayerRig, type Pose,
} from './rig';
import { getGraphics, onGraphicsChange, type GraphicsSettings } from './graphics';
import { FX_CRASH, FX_LAND_PERFECT, FX_TRICK, FX_BOOSTPAD, FX_KICKER } from './config';

// ---------------------------------------------------------------------------
// The downhill renderer (Three.js / WebGL).
//
// World space is metres and matches the track generator: x/z on the ground,
// y up. Every rider is given to us in TRACK space (s along the centreline, n
// across it, z as world altitude) exactly as the server simulates them, and
// trackPoint() puts that back into the world — so what is drawn is what the
// server has, never a second physics model.
//
// The chase camera rides behind the local rider on the same centreline, which
// is why cornering reads: the camera is turning with the hill, not with you.
// ---------------------------------------------------------------------------

export interface RenderRider {
  key: string;
  name: string;
  characterId: number;
  bikeId: number;
  s: number;
  n: number;
  v: number;
  yaw: number;
  z: number;
  pitch: number;
  lean: number;
  slip: number;
  airTicks: number;
  crashTicks: number;
  trickKind: number;
  trickSpin: number;
  boosting: boolean;
  place: number;
  isLocal: boolean;
  fxKind: number;
}

export interface Scene {
  courseId: number;
  seed: number;
  riders: RenderRider[];
  localKey: string;
  chase: boolean; // false = a static grid shot while the gate is up
  freeCam: number; // spectators: which rider to follow (index)
  now: number;
}

const MAX_RIGS = 8;
const M_PER_FOOT = 0.3048; // the shared rig is authored in feet
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const damp = (a: number, b: number, rate: number, dt: number) =>
  a + (b - a) * (1 - Math.exp(-rate * dt));

let renderer: THREE.WebGLRenderer;
let scene3: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let sun: THREE.DirectionalLight;
let hemi: THREE.HemisphereLight;
let hostCanvas: HTMLCanvasElement;
let gfx: GraphicsSettings = getGraphics();
let course: Course | null = null;
let courseKey = '';
let trackGroup: THREE.Group | null = null;
let lastFrame = 0;
let camS = 0;
let camN = 0;
let camHeight = 0;
let camRoll = 0;
let camFov = 60;
let shake = 0;

// ---------------------------------------------------------------------------
// Rider rigs — one pooled rig per grid slot, each with a bike under it.
// ---------------------------------------------------------------------------
interface BikeMesh {
  group: THREE.Group;
  frontWheel: THREE.Group;
  rearWheel: THREE.Group;
  fork: THREE.Group;
  frameMat: THREE.MeshLambertMaterial;
  bikeId: number;
}
interface RiderVis {
  group: THREE.Group; // world transform (position + heading)
  tilt: THREE.Group; // lean + pitch
  seat: THREE.Group; // lifts the rig onto the saddle
  rig: PlayerRig;
  bike: BikeMesh;
  key: string;
  charKey: string;
  spin: number; // wheel rotation
  lean: number;
  pitch: number;
  yaw: number;
  s: number;
  n: number;
  z: number;
  fxSeen: number;
  label: THREE.Object3D;
}
const riderVis: RiderVis[] = [];
const visByKey = new Map<string, RiderVis>();

const WHEEL_R = 0.34;

function makeBike(bikeId: number): BikeMesh {
  const def = BIKES[bikeId] ?? BIKES[0];
  const group = new THREE.Group();
  const frameMat = new THREE.MeshLambertMaterial({ color: def.css });
  const darkMat = new THREE.MeshLambertMaterial({ color: def.accent });
  const tyreMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1e });
  const rimMat = new THREE.MeshLambertMaterial({ color: 0xc8ccd2 });

  const wheel = () => {
    const g = new THREE.Group();
    const tyre = new THREE.Mesh(
      new THREE.TorusGeometry(WHEEL_R, def.knobby ? 0.085 : 0.05, 6, 18),
      tyreMat
    );
    tyre.castShadow = true;
    g.add(tyre);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R * 0.72, 0.02, 4, 16), rimMat);
    g.add(rim);
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.02, WHEEL_R * 1.4, 0.02), rimMat);
      spoke.rotation.z = (i / 4) * Math.PI;
      g.add(spoke);
    }
    g.rotation.y = Math.PI / 2; // the wheel plane is the bike's plane
    return g;
  };

  const rearWheel = wheel();
  rearWheel.position.set(0, WHEEL_R, -0.52);
  group.add(rearWheel);

  const fork = new THREE.Group();
  fork.position.set(0, WHEEL_R + 0.42, 0.58);
  const frontWheel = wheel();
  frontWheel.position.set(0, -0.42, 0);
  fork.add(frontWheel);
  const forkLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.04, 0.72, 6), darkMat);
  forkLeg.position.y = -0.16;
  fork.add(forkLeg);
  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.62, 6), darkMat);
  bars.rotation.z = Math.PI / 2;
  bars.position.y = 0.2;
  fork.add(bars);
  group.add(fork);

  // Frame: a couple of tubes is enough at racing speed, and cheap ×8.
  const tube = (len: number, x: number, y: number, z: number, rx: number, rz = 0) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, len, 6), frameMat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  tube(1.12, 0, WHEEL_R + 0.46, 0.02, Math.PI / 2 - 0.22); // top tube
  tube(0.92, 0, WHEEL_R + 0.2, -0.1, Math.PI / 2 + 0.5); // down tube
  tube(0.66, 0, WHEEL_R + 0.24, -0.36, Math.PI / 2 - 0.55); // seat stay
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.34), darkMat);
  seat.position.set(0, WHEEL_R + 0.66, -0.26);
  group.add(seat);
  const cranks = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 10), darkMat);
  cranks.rotation.x = Math.PI / 2;
  cranks.position.set(0, WHEEL_R + 0.02, -0.06);
  group.add(cranks);

  return { group, frontWheel, rearWheel, fork, frameMat, bikeId };
}

function makeLabel(): THREE.Object3D {
  // Nameplates are DOM (main.ts positions them); this is just the anchor.
  const o = new THREE.Object3D();
  o.position.y = 2.2;
  return o;
}

function riderVisFor(key: string): RiderVis {
  const hit = visByKey.get(key);
  if (hit) return hit;
  if (riderVis.length >= MAX_RIGS) {
    // Recycle the least recently used slot (races are capped at MAX_RIDERS,
    // so this only happens when a rider leaves and another joins).
    const victim = riderVis[0];
    visByKey.delete(victim.key);
    victim.key = key;
    visByKey.set(key, victim);
    return victim;
  }
  const group = new THREE.Group();
  const tilt = new THREE.Group();
  group.add(tilt);
  const rig = makePlayerRig(riderVis.length, scene3);
  scene3.remove(rig.root); // the rig parents itself into a scene; we own it
  // The shared rig is authored in feet with its root on the ground, so it is
  // scaled to metres and lifted onto the saddle.
  const seat = new THREE.Group();
  seat.scale.setScalar(M_PER_FOOT);
  seat.position.set(0, 0.36, -0.16);
  seat.add(rig.root);
  tilt.add(seat);
  const bike = makeBike(0);
  tilt.add(bike.group);
  const label = makeLabel();
  group.add(label);
  scene3.add(group);
  const vis: RiderVis = {
    group, tilt, seat, rig, bike, key, charKey: '',
    spin: 0, lean: 0, pitch: 0, yaw: 0, s: 0, n: 0, z: 0, fxSeen: 0, label,
  };
  riderVis.push(vis);
  visByKey.set(key, vis);
  return vis;
}

function dressRider(vis: RiderVis, r: RenderRider) {
  const char: Character = CHARACTERS[r.characterId] ?? CHARACTERS[0];
  const key = `${r.characterId}|${r.bikeId}`;
  if (vis.charKey === key) return;
  vis.charKey = key;
  applyCharacter(vis.rig, char);
  applyPhysique(vis.rig, char);
  vis.rig.racket.visible = false; // nobody rides with a racket
  if (vis.bike.bikeId !== r.bikeId) {
    vis.tilt.remove(vis.bike.group);
    disposeTree(vis.bike.group);
    vis.bike = makeBike(r.bikeId);
    vis.tilt.add(vis.bike.group);
  }
}

// ---------------------------------------------------------------------------
// Riding poses. The shared rig's Pose channels are authored for tennis; these
// are the bike equivalents — crouched over the bars, arms out front.
// ---------------------------------------------------------------------------
function ridePose(tuck: number, lean: number, crouch: number): Pose {
  return {
    ...ZERO_POSE,
    twist: lean * 0.25,
    leanF: 0.55 + tuck * 0.45,
    leanS: -lean * 0.3,
    thighL: -1.45, calfL: 1.5,
    thighR: -1.45, calfR: 1.5,
    shLx: -1.15 - tuck * 0.25, shLz: 0.28, elL: -0.35,
    shRx: -1.15 - tuck * 0.25, shRz: -0.28, elR: -0.35,
    yawOff: 0,
    crouch: 0.35 + crouch,
  };
}
function airPose(t: number, kind: number): Pose {
  const base = ridePose(0.2, 0, 0.1);
  if (kind === 1) {
    // WHIP: legs kicked out to one side
    return { ...base, thighL: -0.9, calfL: 0.7, thighR: -0.5, calfR: 0.4, twist: 0.5, leanS: 0.35 };
  }
  if (kind === 2) {
    // FLIP: tucked in a ball
    return { ...base, leanF: 1.1, thighL: -2.0, calfL: 2.2, thighR: -2.0, calfR: 2.2 };
  }
  if (kind === 3) {
    // SUPERMAN: legs straight out behind
    return { ...base, leanF: 1.25, thighL: 0.6, calfL: 0.1, thighR: 0.6, calfR: 0.1, shLx: -1.9, shRx: -1.9 };
  }
  if (kind === 4) {
    // TAILWHIP: one hand off, body twisted
    return { ...base, twist: -0.6, shLx: -0.2, shLz: 1.1, elL: -0.2, leanS: -0.3 };
  }
  return { ...base, leanF: 0.35 + Math.sin(t * 4) * 0.05, crouch: 0.2 };
}
function crashPose(t: number): Pose {
  return {
    ...ZERO_POSE,
    leanF: 1.3,
    leanS: Math.sin(t * 9) * 0.5,
    twist: Math.sin(t * 7) * 0.6,
    thighL: -1.9, calfL: 1.2, thighR: -0.6, calfR: 1.9,
    shLx: -2.2, shLz: 0.7, elL: -0.9,
    shRx: -1.4, shRz: -0.9, elR: -1.3,
    yawOff: 0,
    crouch: 1.1,
  };
}

// ---------------------------------------------------------------------------
// Track mesh. Built once per course: a ribbon of quads with the biome colour
// baked into the vertices, verges either side, and the features dressed as
// real objects (ramps, rocks, gates, pads) so you can read the hill ahead.
// ---------------------------------------------------------------------------
function disposeTree(obj: THREE.Object3D) {
  obj.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(x => x.dispose());
    else if (mat) mat.dispose();
  });
}

// The ground profile either side of the corridor: a low berm right at the
// edge, then the hillside climbing away. Without the berm the track is
// invisible — everything reads as one flat plain (it did, once).
const BERM_W = 3.5;
const BERM_H = 1.9;
const VERGE = 34; // how far past the berm the hillside is drawn
const VERGE_H = 17;

function buildTrack(c: Course): THREE.Group {
  const grp = new THREE.Group();
  const steps = 4; // sub-samples per segment — corners need the resolution
  const rows: { x: number; y: number; z: number; h: number; hw: number; biome: number }[] = [];
  const total = c.segs.length * steps;
  for (let i = 0; i <= total; i++) {
    const s = Math.min(c.length, (i / steps) * SEG_LEN);
    const p = trackPoint(c, s, 0);
    const sg = segmentAt(c, s);
    rows.push({ x: p.x, y: p.y, z: p.z, h: p.heading, hw: halfWidthAt(c, s), biome: sg.biome });
  }

  // --- the riding surface + the verges either side ------------------------
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const tmp = new THREE.Color();
  // Six lanes across: hillside · berm · corridor edge · centre · edge ·
  // berm · hillside. `kind` drives both the height and the colour, so the
  // rideable line is a channel you can read at 130 km/h.
  const lanes: { at: number; lift: number; kind: number }[] = [
    { at: -(1 + 0), lift: VERGE_H, kind: 2 },
    { at: -1, lift: BERM_H, kind: 1 },
    { at: -0.99, lift: 0, kind: 0 },
    { at: 0, lift: -0.12, kind: 0 },
    { at: 0.99, lift: 0, kind: 0 },
    { at: 1, lift: BERM_H, kind: 1 },
    { at: 1 + 0, lift: VERGE_H, kind: 2 },
  ];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const look = BIOME_LOOK[r.biome];
    const lat = lateral(r.h);
    const nx = lat.x;
    const nz = lat.z;
    for (let l = 0; l < lanes.length; l++) {
      const ln = lanes[l];
      const sgn = Math.sign(ln.at) || 1;
      const off =
        ln.kind === 2 ? sgn * (r.hw + BERM_W + VERGE)
        : ln.kind === 1 ? sgn * (r.hw + BERM_W)
        : ln.at * r.hw;
      const wob = ln.kind === 2 ? Math.sin(i * 0.31 + sgn) * 3.5 : 0;
      pos.push(r.x + nx * off, r.y + ln.lift + wob, r.z + nz * off);
      // The corridor is the packed, darker line; the hillside is untouched.
      tmp.setHex(
        ln.kind === 2 ? look.ground2
        : ln.kind === 1 ? look.ground
        : i % 2 === 0 ? look.track : look.track2
      );
      const k = ln.kind === 2 ? 0.86 : 1;
      col.push(tmp.r * k, tmp.g * k, tmp.b * k);
    }
  }
  const W = lanes.length;
  for (let i = 0; i < rows.length - 1; i++) {
    for (let l = 0; l < W - 1; l++) {
      const a = i * W + l;
      const b = a + 1;
      const cIdx = a + W;
      const d = cIdx + 1;
      idx.push(a, cIdx, b, b, cIdx, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const surface = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
  );
  surface.receiveShadow = true;
  grp.add(surface);

  // --- edge markers: you must be able to see where the track stops --------
  const edgeGeo = new THREE.BufferGeometry();
  const epos: number[] = [];
  for (const sgn of [-1, 1]) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const nx = lateral(r.h).x;
      const nz = lateral(r.h).z;
      epos.push(r.x + nx * r.hw * sgn, r.y + 0.1, r.z + nz * r.hw * sgn);
    }
  }
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(epos, 3));
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(edgeGeo),
    new THREE.LineBasicMaterial({ color: 0xffffff })
  );
  edges.visible = false; // the marker poles below read better than a line
  grp.add(edges);

  // Marker poles every other segment, alternating red/white like a piste.
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.09, 1.8, 5);
  const poleMats = [
    new THREE.MeshLambertMaterial({ color: 0xe03028 }),
    new THREE.MeshLambertMaterial({ color: 0xf4f4f4 }),
  ];
  const poleCount = Math.floor(rows.length / 2) * 2;
  const poles = [
    new THREE.InstancedMesh(poleGeo, poleMats[0], poleCount),
    new THREE.InstancedMesh(poleGeo, poleMats[1], poleCount),
  ];
  const dummy = new THREE.Object3D();
  let pc = [0, 0];
  for (let i = 0; i < rows.length; i += 2) {
    const r = rows[i];
    const nx = lateral(r.h).x;
    const nz = lateral(r.h).z;
    for (const sgn of [-1, 1]) {
      const which = ((i >> 1) + (sgn > 0 ? 1 : 0)) % 2;
      dummy.position.set(r.x + nx * r.hw * sgn, r.y + 0.9, r.z + nz * r.hw * sgn);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      poles[which].setMatrixAt(pc[which]++, dummy.matrix);
    }
  }
  poles.forEach((p, i) => {
    p.count = pc[i];
    p.instanceMatrix.needsUpdate = true;
    grp.add(p);
  });

  // --- biome props: trees, boulders, cacti, houses ------------------------
  if (gfx.detail) buildProps(c, rows, grp);

  // --- features -----------------------------------------------------------
  buildFeatures(c, grp);

  // --- the horizon --------------------------------------------------------
  // Without something out there the hillside just stops in mid-air. A ring of
  // big peaks around the course start, plus the fog, closes the world off.
  const peakMat = new THREE.MeshLambertMaterial({ color: 0x6a7c96 });
  const capMat = new THREE.MeshLambertMaterial({ color: 0xeef4fb });
  const mid = trackPoint(c, c.length * 0.45, 0);
  for (let i = 0; i < 14; i++) {
    const ang = (i / 14) * Math.PI * 2 + (c.seed % 100) / 100;
    const dist = 620 + ((i * 97) % 260);
    const h = 190 + ((i * 53) % 170);
    const peak = new THREE.Mesh(new THREE.ConeGeometry(h * 0.75, h, 5), peakMat);
    peak.position.set(mid.x + Math.cos(ang) * dist, mid.y + h / 2 - 60, mid.z + Math.sin(ang) * dist);
    grp.add(peak);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(h * 0.3, h * 0.34, 5), capMat);
    cap.position.set(peak.position.x, peak.position.y + h * 0.33, peak.position.z);
    grp.add(cap);
  }

  // --- the finish ---------------------------------------------------------
  const fin = trackPoint(c, c.length - 4, 0);
  const finHw = halfWidthAt(c, c.length - 4);
  const banner = new THREE.Group();
  const postMat = new THREE.MeshLambertMaterial({ color: 0x2a2a30 });
  for (const sgn of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 8, 6), postMat);
    post.position.set(lateral(fin.heading).x * finHw * sgn, 4, lateral(fin.heading).z * finHw * sgn);
    banner.add(post);
  }
  const cloth = new THREE.Mesh(
    new THREE.PlaneGeometry(finHw * 2, 2.4),
    new THREE.MeshLambertMaterial({ color: 0x111118, side: THREE.DoubleSide })
  );
  cloth.position.y = 7;
  cloth.rotation.y = Math.PI / 2 - fin.heading;
  banner.add(cloth);
  banner.position.set(fin.x, fin.y, fin.z);
  grp.add(banner);

  return grp;
}

function buildProps(
  c: Course,
  rows: { x: number; y: number; z: number; h: number; hw: number; biome: number }[],
  grp: THREE.Group
) {
  // One instanced mesh per prop kind, scattered outside the corridor.
  const kinds: Record<string, { geo: THREE.BufferGeometry; mat: THREE.Material; items: THREE.Object3D[] }> = {};
  const dummy = new THREE.Object3D();
  const rng = (() => {
    let a = (c.seed ^ 0x5bf03635) >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  })();

  const geoFor = (kind: string, color: number) => {
    if (kinds[kind]) return kinds[kind];
    let geo: THREE.BufferGeometry;
    if (kind === 'pine') geo = new THREE.ConeGeometry(1.6, 7, 6);
    else if (kind === 'boulder') geo = new THREE.DodecahedronGeometry(1.9, 0);
    else if (kind === 'rock') geo = new THREE.DodecahedronGeometry(1.1, 0);
    else if (kind === 'cactus') geo = new THREE.CylinderGeometry(0.35, 0.45, 3.4, 6);
    else geo = new THREE.BoxGeometry(4, 3.4, 5);
    kinds[kind] = { geo, mat: new THREE.MeshLambertMaterial({ color }), items: [] };
    return kinds[kind];
  };

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const look = BIOME_LOOK[r.biome];
    if (look.props === 'none') continue;
    const density = look.props === 'pine' ? 3 : look.props === 'house' ? 1 : 2;
    for (let k = 0; k < density; k++) {
      if (rng() > 0.55) continue;
      const sgn = rng() < 0.5 ? -1 : 1;
      const off = (r.hw + BERM_W + 2 + rng() * VERGE * 0.7) * sgn;
      const nx = lateral(r.h).x;
      const nz = lateral(r.h).z;
      const bucket = geoFor(look.props === 'rock' ? 'rock' : look.props, look.propColor);
      dummy.position.set(r.x + nx * off, r.y + 2.4 + Math.abs(off) * 0.05, r.z + nz * off);
      const sc = 0.7 + rng() * 0.8;
      dummy.scale.setScalar(sc);
      dummy.rotation.set(0, rng() * Math.PI * 2, 0);
      if (look.props === 'pine') dummy.position.y += 3;
      dummy.updateMatrix();
      bucket.items.push(dummy.clone());
    }
  }
  for (const kind of Object.keys(kinds)) {
    const b = kinds[kind];
    if (b.items.length === 0) continue;
    const inst = new THREE.InstancedMesh(b.geo, b.mat, b.items.length);
    b.items.forEach((o, i) => {
      o.updateMatrix();
      inst.setMatrixAt(i, o.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = gfx.shadows > 0;
    grp.add(inst);
  }
}

// A ramp: flat on the ground at the back, rising to a lip at the front (+Z).
function wedgeGeometry(width: number, height: number, len: number): THREE.BufferGeometry {
  const w = width / 2;
  const geo = new THREE.BufferGeometry();
  const v = new Float32Array([
    // ride surface (back, on the ground) → (front, at the lip)
    -w, 0, -len / 2, w, 0, -len / 2, w, height, len / 2,
    -w, 0, -len / 2, w, height, len / 2, -w, height, len / 2,
    // the drop off the lip
    -w, height, len / 2, w, height, len / 2, w, 0, len / 2,
    -w, height, len / 2, w, 0, len / 2, -w, 0, len / 2,
    // sides
    -w, 0, -len / 2, -w, height, len / 2, -w, 0, len / 2,
    w, 0, -len / 2, w, 0, len / 2, w, height, len / 2,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildFeatures(c: Course, grp: THREE.Group) {
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x55504a });
  const padMat = new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.75 });
  const gateMat = new THREE.MeshLambertMaterial({ color: 0xe8b020 });
  for (let i = 0; i < c.segs.length; i++) {
    const sg = c.segs[i];
    if (sg.feature === 0) continue;
    const s = i * SEG_LEN;
    const p = trackPoint(c, s, 0);
    const nx = lateral(p.heading).x;
    const nz = lateral(p.heading).z;
    const hw = halfWidthAt(c, s);
    if (sg.feature === F_KICKER) {
      // A wedge across the track: the lip is what you time the hop on.
      const len = 6 * sg.featureArg;
      const h = 1.15 * sg.featureArg;
      const mat = new THREE.MeshLambertMaterial({ color: BIOME_LOOK[sg.biome].rock });
      const ramp = new THREE.Mesh(wedgeGeometry(Math.min(hw * 1.4, 18), h, len), mat);
      ramp.position.set(p.x, p.y, p.z);
      ramp.rotation.y = Math.PI / 2 - p.heading;
      ramp.castShadow = true;
      ramp.receiveShadow = true;
      grp.add(ramp);
    } else if (sg.feature === F_ROCKS) {
      for (let k = 0; k < 3; k++) {
        const off = sg.featureArg + (k - 1) * 0.9;
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.85 + k * 0.1, 0), rockMat);
        rock.position.set(p.x + nx * off, p.y + 0.5, p.z + nz * off);
        rock.castShadow = true;
        grp.add(rock);
      }
    } else if (sg.feature === F_BOOST) {
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 9), padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.rotation.z = Math.PI / 2 - p.heading;
      pad.position.set(p.x + nx * sg.featureArg, p.y + 0.08, p.z + nz * sg.featureArg);
      grp.add(pad);
    } else if (sg.feature === F_NARROW) {
      for (const sgn of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 4.5, 6), gateMat);
        post.position.set(p.x + nx * hw * sgn, p.y + 2.2, p.z + nz * hw * sgn);
        grp.add(post);
      }
    } else if (sg.feature === F_WHOOPS) {
      // Rollers, drawn as a run of low ridges so the chatter is visible.
      for (let k = 0; k < 5; k++) {
        const ws = s + k * (SEG_LEN / 5);
        const wp = trackPoint(c, ws, 0);
        const roll = new THREE.Mesh(
          new THREE.CylinderGeometry(0.5 * sg.featureArg, 0.5 * sg.featureArg, hw * 1.6, 6, 1, false, 0, Math.PI),
          new THREE.MeshLambertMaterial({ color: BIOME_LOOK[sg.biome].rock })
        );
        roll.rotation.z = Math.PI / 2;
        roll.rotation.y = -wp.heading;
        roll.position.set(wp.x, wp.y, wp.z);
        grp.add(roll);
      }
    } else if (sg.feature === F_DROP) {
      const lip = new THREE.Mesh(
        new THREE.BoxGeometry(hw * 2, 0.6, 1.4),
        new THREE.MeshLambertMaterial({ color: BIOME_LOOK[sg.biome].rock })
      );
      lip.position.set(p.x, p.y + 0.3, p.z);
      lip.rotation.y = Math.PI / 2 - p.heading;
      grp.add(lip);
    }
  }
}

function ensureCourse(courseId: number, seed: number) {
  const key = `${courseId}:${seed}`;
  if (key === courseKey && trackGroup) return;
  courseKey = key;
  course = buildCourse(courseId, seed);
  if (trackGroup) {
    scene3.remove(trackGroup);
    disposeTree(trackGroup);
  }
  trackGroup = buildTrack(course);
  scene3.add(trackGroup);
  // Start the camera on the gate so the first frame is not a lurch.
  camS = 0;
  camN = 0;
  camHeight = groundAt(course, 0) + 4;
}

// ---------------------------------------------------------------------------
// Particles: dust off the tyres, spray on a drift, an impact puff on a crash.
// ---------------------------------------------------------------------------
interface Puff {
  mesh: THREE.Mesh;
  life: number;
  max: number;
  vel: THREE.Vector3;
}
const puffs: Puff[] = [];
let puffPool: THREE.Mesh[] = [];
function puffMesh(): THREE.Mesh {
  const m = puffPool.pop();
  if (m) return m;
  return new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 5, 4),
    new THREE.MeshBasicMaterial({
      color: 0xd8cfc0, transparent: true, opacity: 0.45, depthWrite: false,
    })
  );
}
function spawnPuff(at: THREE.Vector3, color: number, spread: number, life = 0.6) {
  if (!gfx.particles || puffs.length > 90) return;
  const mesh = puffMesh();
  (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
  mesh.position.copy(at);
  mesh.visible = true;
  scene3.add(mesh);
  puffs.push({
    mesh,
    life,
    max: life,
    vel: new THREE.Vector3((Math.random() - 0.5) * spread, Math.random() * spread * 0.7, (Math.random() - 0.5) * spread),
  });
}
function updatePuffs(dt: number) {
  for (let i = puffs.length - 1; i >= 0; i--) {
    const p = puffs[i];
    p.life -= dt;
    if (p.life <= 0) {
      scene3.remove(p.mesh);
      puffPool.push(p.mesh);
      puffs.splice(i, 1);
      continue;
    }
    p.mesh.position.addScaledVector(p.vel, dt);
    p.vel.y -= 3 * dt;
    const k = p.life / p.max;
    (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.45 * k;
    p.mesh.scale.setScalar(0.8 + (1 - k) * 1.1);
  }
}

export function addShake(strength: number) {
  shake = Math.min(1.2, shake + strength);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function initRenderer(canvas: HTMLCanvasElement) {
  hostCanvas = canvas;
  buildScene();
  onGraphicsChange(applyGraphics);
}

function buildScene() {
  renderer = new THREE.WebGLRenderer({
    canvas: hostCanvas,
    antialias: gfx.antialias,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * gfx.resolution);
  renderer.shadowMap.enabled = gfx.shadows > 0;
  renderer.shadowMap.type = gfx.shadows > 1 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  if (gfx.grade) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
  }

  scene3 = new THREE.Scene();
  scene3.background = new THREE.Color(0x9cc6ee);
  scene3.fog = new THREE.Fog(0xcfe0f0, 90, 460);

  camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 900);

  sun = new THREE.DirectionalLight(0xfff3e2, 2.1);
  sun.position.set(-60, 120, 40);
  sun.castShadow = gfx.shadows > 0;
  const size = gfx.shadows > 1 ? 2048 : 1024;
  sun.shadow.mapSize.set(size, size);
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.camera.far = 400;
  scene3.add(sun);
  scene3.add(sun.target);

  hemi = new THREE.HemisphereLight(0xbcd8f0, 0x4a4436, 1.0);
  scene3.add(hemi);
}

function applyGraphics(next: GraphicsSettings, prev: GraphicsSettings) {
  gfx = next;
  if (next.antialias !== prev.antialias) {
    // MSAA is baked into the context: rebuild everything.
    const keepCourse = courseKey;
    disposeScene();
    buildScene();
    courseKey = '';
    riderVis.length = 0;
    visByKey.clear();
    if (course && keepCourse) ensureCourse(course.id, course.seed);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * next.resolution);
  renderer.shadowMap.enabled = next.shadows > 0;
  sun.castShadow = next.shadows > 0;
  const size = next.shadows > 1 ? 2048 : 1024;
  sun.shadow.mapSize.set(size, size);
  renderer.toneMapping = next.grade ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  if (next.detail !== prev.detail && course) {
    const c = course;
    courseKey = '';
    ensureCourse(c.id, c.seed);
  }
}

function disposeScene() {
  if (trackGroup) disposeTree(trackGroup);
  trackGroup = null;
  scene3.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
  renderer.dispose();
}

function resizeToDisplay() {
  const w = hostCanvas.clientWidth;
  const h = hostCanvas.clientHeight;
  if (w === 0 || h === 0) return;
  const need = hostCanvas.width !== Math.floor(w * renderer.getPixelRatio());
  if (need) renderer.setSize(w, h, false);
  if (camera.aspect !== w / h) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

export function canvasCssSize() {
  return { w: hostCanvas.clientWidth, h: hostCanvas.clientHeight };
}

// Screen position of a rider's head, for DOM nameplates.
export function riderScreenPos(key: string): { x: number; y: number } | null {
  const vis = visByKey.get(key);
  if (!vis) return null;
  const v = new THREE.Vector3();
  vis.label.getWorldPosition(v);
  v.project(camera);
  if (v.z > 1) return null;
  const { w, h } = canvasCssSize();
  return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------
export function drawScene(scene: Scene) {
  if (!renderer) return;
  resizeToDisplay();
  const now = scene.now;
  const dt = lastFrame === 0 ? 1 / 60 : Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  ensureCourse(scene.courseId, scene.seed);
  const c = course!;

  const seen = new Set<string>();
  let follow: RenderRider | null = null;
  for (const r of scene.riders) {
    seen.add(r.key);
    const vis = riderVisFor(r.key);
    dressRider(vis, r);
    if (r.isLocal) follow = r;

    // Smooth the server's 30 Hz rows into the display frame rate. Only the
    // presentation is interpolated — the authority is still the row.
    vis.s = damp(vis.s || r.s, r.s, 18, dt);
    vis.n = damp(vis.n, r.n, 14, dt);
    vis.z = damp(vis.z || r.z, r.z, 16, dt);
    vis.yaw = damp(vis.yaw, r.yaw, 12, dt);
    vis.lean = damp(vis.lean, r.lean, 10, dt);
    vis.pitch = damp(vis.pitch, r.pitch, 10, dt);

    const p = trackPoint(c, vis.s, vis.n);
    vis.group.position.set(p.x, vis.z, p.z);
    // The rig and bike face +Z in model space; the track tangent at heading h
    // is (cos h, sin h) in world (x, z), which is PI/2 - h about Y.
    vis.group.rotation.y = Math.PI / 2 - (p.heading + vis.yaw);

    const crashing = r.crashTicks > 0;
    const airborne = r.airTicks > 0;
    vis.tilt.rotation.z = crashing ? Math.sin(now / 70) * 0.8 : vis.lean;
    vis.tilt.rotation.x = crashing ? 0.5 : -vis.pitch;

    // Trick rotation spins the whole bike + rider.
    if (airborne && r.trickKind > 0) {
      const spin = r.trickSpin * Math.PI * 2;
      if (r.trickKind === 2) vis.tilt.rotation.x = -vis.pitch - spin;
      else vis.tilt.rotation.z = vis.lean + spin;
    }

    // Wheels turn with real ground speed; the fork steers with the yaw.
    vis.spin += (r.v / WHEEL_R) * dt;
    vis.bike.frontWheel.rotation.x = vis.spin;
    vis.bike.rearWheel.rotation.x = vis.spin;
    vis.bike.fork.rotation.y = clamp(r.yaw * 0.8, -0.6, 0.6);
    vis.bike.group.visible = !crashing || Math.floor(now / 90) % 2 === 0;

    // Pose
    const tuck = clamp(r.v / 30, 0, 1);
    const pose = crashing
      ? crashPose(now / 1000)
      : airborne
        ? airPose(now / 1000, r.trickKind)
        : ridePose(tuck, vis.lean, r.slip * 0.2);
    // The rider faces forward inside the bike group, so the rig's own yaw is
    // always zero — the group carries the heading.
    applyPose(vis.rig, pose, 14, dt, 0, now);

    // Dust: tyres always kick a little, a drift kicks a lot.
    if (!airborne && r.v > 4) {
      const look = BIOME_LOOK[segmentAt(c, r.s).biome];
      const rate = 0.05 + r.slip * 0.35;
      if (Math.random() < rate) {
        spawnPuff(
          new THREE.Vector3(p.x, vis.z + 0.2, p.z),
          look.ground2,
          1.2 + r.slip * 5,
          0.45 + r.slip * 0.5
        );
      }
    }

    // One-shot cues from the server.
    if (r.fxKind !== vis.fxSeen) {
      vis.fxSeen = r.fxKind;
      const at = new THREE.Vector3(p.x, vis.z + 0.4, p.z);
      if (r.fxKind === FX_CRASH) {
        for (let i = 0; i < 6; i++) spawnPuff(at, 0xb8a890, 4.5, 0.55);
        if (r.isLocal) addShake(0.9);
      } else if (r.fxKind === FX_LAND_PERFECT || r.fxKind === FX_KICKER) {
        for (let i = 0; i < 3; i++) spawnPuff(at, 0xe8e0d0, 2.4, 0.35);
        if (r.isLocal && r.fxKind === FX_LAND_PERFECT) addShake(0.25);
      } else if (r.fxKind === FX_BOOSTPAD || r.fxKind === FX_TRICK) {
        for (let i = 0; i < 5; i++) spawnPuff(at, 0x35e0ff, 3, 0.45);
      }
    }
    // Boosting leaves a trail.
    if (r.boosting && gfx.trail && Math.random() < 0.5) {
      spawnPuff(new THREE.Vector3(p.x, vis.z + 0.5, p.z), 0x35c8ff, 1.5, 0.4);
    }
  }

  // Park rigs nobody is using this frame well below the hill.
  for (const vis of riderVis) {
    if (!seen.has(vis.key)) vis.group.position.y = -9999;
  }

  // --- camera -------------------------------------------------------------
  const target = follow ?? scene.riders[scene.freeCam] ?? scene.riders[0];
  if (target) {
    const back = scene.chase ? 8.5 + Math.min(4.5, target.v * 0.14) : 11;
    const height = scene.chase ? 4.4 + Math.min(2.0, target.v * 0.04) : 5.5;
    camS = damp(camS, Math.max(0, target.s - back), 9, dt);
    camN = damp(camN, target.n * 0.55, 5, dt);
    const cp = trackPoint(c, camS, camN);
    const groundY = groundAt(c, camS);
    camHeight = damp(camHeight, Math.max(target.z, groundY) + height, 7, dt);
    camera.position.set(cp.x, camHeight, cp.z);
    // Look at the hill the rider is dropping into, not at their head: on a
    // descent the ground ahead falls away, and aiming at rider height fills
    // the screen with sky.
    const ahead = trackPoint(c, Math.min(c.length, target.s + 26), target.n * 0.5);
    const lookY = Math.min(target.z + 1.2, ahead.y + 3.4);
    camera.up.set(Math.sin(camRoll) * 0.5, 1, 0);
    camera.lookAt(ahead.x, lookY, ahead.z);
    camRoll = damp(camRoll, -target.lean * 0.35 - target.yaw * 0.12, 6, dt);
    camera.rotation.z += camRoll;
    const wantFov = 52 + Math.min(14, target.v * 0.35) + (target.boosting ? 6 : 0);
    camFov = damp(camFov, wantFov, 5, dt);
    if (Math.abs(camera.fov - camFov) > 0.05) {
      camera.fov = camFov;
      camera.updateProjectionMatrix();
    }
    // The sun follows the action so shadows stay inside the shadow camera.
    sun.position.set(cp.x - 60, camHeight + 90, cp.z + 40);
    sun.target.position.set(cp.x, groundY, cp.z);
    sun.target.updateMatrixWorld();

    // Biome-driven sky and fog: the mountain changes as you drop through it.
    const look = BIOME_LOOK[segmentAt(c, target.s).biome];
    const skyCol = (scene3.background as THREE.Color) ?? new THREE.Color();
    skyCol.lerp(new THREE.Color(look.sky), 1 - Math.exp(-dt * 1.5));
    scene3.background = skyCol;
    if (scene3.fog instanceof THREE.Fog) {
      scene3.fog.color.lerp(new THREE.Color(look.fog), 1 - Math.exp(-dt * 1.5));
    }
  }

  if (shake > 0) {
    camera.position.x += (Math.random() - 0.5) * shake * 1.2;
    camera.position.y += (Math.random() - 0.5) * shake * 1.2;
    shake = Math.max(0, shake - dt * 2.2);
  }

  updatePuffs(dt);
  renderer.render(scene3, camera);
}

// The renderer is also the character-select preview host (the rig file owns
// the actual slot machinery — it is shared with the other Digital games).
export { initCharacterPreviews, registerPreviewSlot } from './rig';
