// ---------------------------------------------------------------------------
// The character rig — LIFTED VERBATIM from Digital Tennis's render.ts
// (textures, buildHair / buildBody, applyCharacter / applyPhysique,
// makePlayerRig, the pose library and the character-select previews).
//
// The roster is shared across the Digital games, so the same person has to
// look the same in all of them: change a body or a hair style HERE only by
// copying the change across from digital-tennis, never by diverging. The
// bike-specific posing (crouch, lean, whip, trick) lives in render.ts.
//
// Model space: +Y up, the rig faces +Z, arms hang along -Y.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { CHARACTERS, type Character, type HairStyle } from './characters';

const COLORS = {
  shorts: 0xf5f5f5,
  skin: 0xe8ae7e,
  hair: 0x3a2414,
  shoe: 0xffffff,
};

// The shared rig comes with the tennis racket in its hand. Games that are
// not tennis switch it off here rather than diverging buildBody — this is the
// ONLY intentional difference from the file this was lifted from.
let showProp = true;
export function setRigProp(on: boolean) {
  showProp = on;
}

const wrapAngle = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

// ---------------------------------------------------------------------------
type SwingKind = 'fore' | 'back' | 'over';

export interface Pose {
  twist: number; // upper body Y twist
  leanF: number; // forward lean
  leanS: number; // sideways lean
  thighL: number; calfL: number; thighR: number; calfR: number;
  shLx: number; shLz: number; elL: number;
  shRx: number; shRz: number; elR: number;
  yawOff: number; // extra facing rotation (turn toward ball)
  crouch: number; // root lowering for low balls / ready stance
}

export const POSE_KEYS = [
  'twist', 'leanF', 'leanS', 'thighL', 'calfL', 'thighR', 'calfR',
  'shLx', 'shLz', 'elL', 'shRx', 'shRz', 'elR', 'yawOff', 'crouch',
] as const;

// Rotation convention: arms hang along -Y; NEGATIVE X rotation swings the
// arm forward (+Z in model space), positive swings it behind the body.
export const ZERO_POSE: Pose = {
  twist: 0, leanF: 0, leanS: 0,
  thighL: 0, calfL: 0, thighR: 0, calfR: 0,
  shLx: -0.2, shLz: 0.1, elL: -0.45,
  shRx: -0.2, shRz: -0.1, elR: -0.45,
  yawOff: 0, crouch: 0,
};

export interface PlayerRig {
  root: THREE.Group;
  upper: THREE.Group;
  thighL: THREE.Group; calfL: THREE.Group;
  thighR: THREE.Group; calfR: THREE.Group;
  // The skeleton is permanent; the visible body meshes inside each joint are
  // rebuilt per character by buildBody (banana body, corgi body, ...).
  torsoGroup: THREE.Group; // physique: scaled wider with the power stat
  hipGroup: THREE.Group; // shorts/skirt/tail; physique: lifted with leg length
  shoulderL: THREE.Group; elbowL: THREE.Group;
  shoulderR: THREE.Group; elbowR: THREE.Group;
  torsoMat: THREE.MeshLambertMaterial;
  sleeveMatL: THREE.MeshLambertMaterial;
  sleeveMatR: THREE.MeshLambertMaterial;
  skinMat: THREE.MeshLambertMaterial;
  headMat: THREE.MeshLambertMaterial;
  hairMat: THREE.MeshLambertMaterial;
  accentMat: THREE.MeshLambertMaterial;
  hairGroup: THREE.Group;
  racket: THREE.Group; // hidden on watcher rigs — nobody heckles with a racket
  charKey: string; // look currently dressed on this rig (see charLookKey)
  head: THREE.Mesh;
  pose: Pose;
  yaw: number; // current facing (blended toward movement / ball)
  runSeed: number;
  runPhase: number; // stride cycle, advanced by ground distance (not time)
  prevPX: number; // last frame's render position — measures that distance
  prevPZ: number;
  // animation state
  swingStart: number; // -1 = not swinging
  swingKind: SwingKind;
  swingLow: boolean;
  swingStretch: boolean; // reach-to-hit: full-body lean, no dive
  swingPower: number; // 0..1 from the outgoing ball speed
  swingMs: number; // stroke duration (power hits whip faster)
  windupStart: number; // when the button went down (coil deepens while held)
  contactPoint: THREE.Vector3 | null; // frozen ball position at the hit event
  prevSwingTicks: number;
  readyT: number; // 0..1 anticipation coil — peaks at the PERFECT press moment
  glintArmed: boolean; // one racket glint per approach, re-armed between shots
  // dive/roll state
  diveStart: number; // -1 = not diving
  diveDir: number; // roll/spin direction sign
  diveKind: number; // 0 short hop, 1 full dive, 2 huge layout
  diveMs: number;
  diveYaw: number; // world heading of the leap (head-first direction)
  diveFromX: number; // where the leap started (render space)
  diveFromZ: number;
  diveLanded: boolean;
  prevLunge: number;
}

const DIVE_MS = 800; // matches the server's lunge recovery window

// Piecewise channel evaluator with smoothstep easing between keys.
export function ch(t: number, keys: [number, number][]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      const k = (t - t0) / (t1 - t0);
      const s = k * k * (3 - 2 * k);
      return v0 + (v1 - v0) * s;
    }
  }
  return keys[keys.length - 1][1];
}

export function blendAngle(current: number, target: number, rate: number, dt: number): number {
  return current + wrapAngle(target - current) * (1 - Math.exp(-rate * dt));
}

export function capsule(r: number, len: number, mat: THREE.Material, pivotTop = true): THREE.Mesh {
  const geo = new THREE.CapsuleGeometry(r, len, 4, 10);
  geo.translate(0, pivotTop ? -(len / 2 + r) : 0, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}


// ---------------------------------------------------------------------------
// Character look: canvas-painted textures + per-character body dressing.
// Textures are drawn in near-white/grayscale where the material color tints
// them (shirt, ball) and in true color where they carry it (face).
// ---------------------------------------------------------------------------
const cssHex = (n: number) => '#' + n.toString(16).padStart(6, '0');

const faceTexCache = new Map<string, THREE.CanvasTexture>();

// Face painted onto the head sphere: eyes, brows, mouth, cheek shading.
// The sphere's forward (+Z, the rig's facing) is at u=0.25.
function makeFaceTexture(char: Character): THREE.CanvasTexture {
  const faceKey = `${char.face ?? 'human'}|${char.skin}|${char.eyes}`;
  const cached = faceTexCache.get(faceKey);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = cssHex(char.skin);
  g.fillRect(0, 0, c.width, c.height);
  // top light and jaw shadow so the head reads as a form, not a flat ball
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, 'rgba(255,255,255,0.13)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.18)');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // skin grain
  for (let n = 0; n < 900; n++) {
    const s = Math.sin(n * 91.7) * 43758.5453;
    const r = s - Math.floor(s);
    const s2 = Math.sin(n * 271.3) * 12543.21;
    const r2 = s2 - Math.floor(s2);
    g.fillStyle = r > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(80,40,20,0.03)';
    g.fillRect(r * c.width, r2 * c.height, 2, 2);
  }
  const cx = c.width * 0.25;
  const eyeY = 122;
  const face = char.face ?? 'human';

  if (face === 'robot') {
    // one dark visor band with two glowing LED eyes and a speaker mouth
    g.fillStyle = 'rgba(12,14,20,0.92)';
    g.beginPath();
    g.roundRect(cx - 62, eyeY - 19, 124, 38, 12);
    g.fill();
    for (const s of [-1, 1]) {
      g.fillStyle = char.eyes;
      g.shadowColor = char.eyes;
      g.shadowBlur = 10;
      g.beginPath();
      g.roundRect(cx + s * 30 - 9, eyeY - 8, 18, 16, 4);
      g.fill();
      g.shadowBlur = 0;
    }
    g.fillStyle = 'rgba(12,14,20,0.85)';
    for (const dx of [-12, -4, 4, 12]) g.fillRect(cx + dx - 2, 172, 4, 16);
    // panel seams + rivets
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 2;
    g.strokeRect(cx - 78, 60, 156, 150);
    g.fillStyle = 'rgba(0,0,0,0.4)';
    for (const [rx, ry] of [[-70, 68], [70, 68], [-70, 200], [70, 200]] as const) {
      g.beginPath();
      g.arc(cx + rx, ry, 3, 0, Math.PI * 2);
      g.fill();
    }
  } else if (face === 'toon') {
    // huge glossy cartoon eyes (alien / octopus / yeti), no whites, no brows
    for (const s of [-1, 1]) {
      const ex = cx + s * 32;
      g.fillStyle = '#101010';
      g.beginPath();
      g.ellipse(ex, eyeY, 16, 22, s * 0.15, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = char.eyes === '#0c0c0c' || char.eyes === '#101010' ? '#101010' : char.eyes;
      g.beginPath();
      g.ellipse(ex, eyeY + 3, 10, 14, s * 0.15, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.beginPath();
      g.arc(ex - s * 4, eyeY - 7, 4.2, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(ex + s * 3, eyeY + 8, 1.8, 0, Math.PI * 2);
      g.fill();
    }
    // tiny content mouth
    g.strokeStyle = 'rgba(30,20,20,0.8)';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - 8, 182);
    g.quadraticCurveTo(cx, 188, cx + 8, 182);
    g.stroke();
  } else if (face === 'snout') {
    // dog face: light muzzle patch, round eyes, big nose, happy open mouth
    g.fillStyle = 'rgba(255,250,238,0.9)';
    g.beginPath();
    g.ellipse(cx, 172, 46, 40, 0, 0, Math.PI * 2);
    g.fill();
    // blaze up the forehead
    g.beginPath();
    g.ellipse(cx, 100, 14, 42, 0, 0, Math.PI * 2);
    g.fill();
    for (const s of [-1, 1]) {
      const ex = cx + s * 33;
      g.fillStyle = '#181008';
      g.beginPath();
      g.arc(ex, eyeY - 6, 7.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(ex - s * 2, eyeY - 9, 2.4, 0, Math.PI * 2);
      g.fill();
    }
    // nose
    g.fillStyle = '#181210';
    g.beginPath();
    g.ellipse(cx, 156, 12, 9, 0, 0, Math.PI * 2);
    g.fill();
    // mouth: the classic dog "w" + tongue
    g.strokeStyle = 'rgba(40,24,14,0.85)';
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx, 158);
    g.lineTo(cx, 172);
    g.quadraticCurveTo(cx - 12, 184, cx - 22, 174);
    g.moveTo(cx, 172);
    g.quadraticCurveTo(cx + 12, 184, cx + 22, 174);
    g.stroke();
    g.fillStyle = '#e0656e';
    g.beginPath();
    g.ellipse(cx, 190, 9, 12, 0, 0, Math.PI);
    g.fill();
  } else {
    // human base (also under fangs / patch / specs accessories)
    for (const s of [-1, 1]) {
      const ex = cx + s * 30;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(ex, eyeY, 13, 8.5, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = char.eyes;
      g.beginPath();
      g.arc(ex + s * 1.5, eyeY, 5.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#101010';
      g.beginPath();
      g.arc(ex + s * 1.5, eyeY, 2.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(ex + s * 1.5 - 1.6, eyeY - 1.8, 1.3, 0, Math.PI * 2);
      g.fill();
      // upper lid crease
      g.strokeStyle = 'rgba(60,30,15,0.5)';
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(ex, eyeY, 13, 8.5, 0, Math.PI, Math.PI * 2);
      g.stroke();
      // brow in the hair color
      g.strokeStyle = cssHex(char.hair);
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(ex - s * 13, eyeY - 15);
      g.quadraticCurveTo(ex, eyeY - 22, ex + s * 13, eyeY - 16);
      g.stroke();
    }
    // cheek warmth
    g.fillStyle = 'rgba(220,90,70,0.10)';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + s * 42, 158, 14, 9, 0, 0, Math.PI * 2);
      g.fill();
    }
    if (face === 'fangs') {
      // open grin with two fangs — pale lips, red gleam in the smile
      g.fillStyle = 'rgba(60,10,20,0.9)';
      g.beginPath();
      g.moveTo(cx - 20, 178);
      g.quadraticCurveTo(cx, 196, cx + 20, 178);
      g.quadraticCurveTo(cx, 186, cx - 20, 178);
      g.fill();
      g.fillStyle = '#f4f6f8';
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(cx + s * 13 - 3, 180);
        g.lineTo(cx + s * 13 + 3, 180);
        g.lineTo(cx + s * 13, 192);
        g.closePath();
        g.fill();
      }
    } else {
      // mouth
      g.strokeStyle = 'rgba(120,50,40,0.85)';
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx - 16, 180);
      g.quadraticCurveTo(cx, 190, cx + 16, 180);
      g.stroke();
    }
    if (face === 'patch') {
      // eyepatch over the left eye, strap wrapping the head band
      g.strokeStyle = 'rgba(14,12,10,0.92)';
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(0, 118);
      g.lineTo(cx - 44, 108);
      g.moveTo(cx - 18, 104);
      g.lineTo(c.width * 0.75, 92);
      g.stroke();
      g.fillStyle = 'rgba(14,12,10,0.95)';
      g.beginPath();
      g.ellipse(cx - 30, eyeY, 17, 14, -0.12, 0, Math.PI * 2);
      g.fill();
    }
    if (face === 'specs') {
      // round granny glasses + chain hint
      g.strokeStyle = 'rgba(40,44,52,0.9)';
      g.lineWidth = 3.5;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.arc(cx + s * 30, eyeY, 17, 0, Math.PI * 2);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(cx - 13, eyeY - 3);
      g.quadraticCurveTo(cx, eyeY - 8, cx + 13, eyeY - 3);
      g.stroke();
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx - 47, eyeY + 4);
      g.quadraticCurveTo(cx - 62, eyeY + 26, cx - 70, eyeY + 20);
      g.moveTo(cx + 47, eyeY + 4);
      g.quadraticCurveTo(cx + 62, eyeY + 26, cx + 70, eyeY + 20);
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  faceTexCache.set(faceKey, tex);
  return tex;
}

const shirtTexCache = new Map<number, THREE.CanvasTexture>();

// Kit shirt for the torso lathe, drawn near-white so the material color
// tints it with the character color. u=0 is the front seam, u=0.5 the back
// (where the squad number goes); v=1 is the collar end.
export function makeShirtTexture(id: number): THREE.CanvasTexture {
  const cached = shirtTexCache.get(id);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e2e2e2';
  g.fillRect(0, 0, c.width, c.height);
  // lit from above: bright shoulders fading toward the hem
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, 'rgba(255,255,255,0.20)');
  grad.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // underarm / side shading at u=0.25 and u=0.75
  for (const ux of [0.25, 0.75]) {
    const gx = g.createLinearGradient((ux - 0.12) * c.width, 0, (ux + 0.12) * c.width, 0);
    gx.addColorStop(0, 'rgba(0,0,0,0)');
    gx.addColorStop(0.5, 'rgba(0,0,0,0.17)');
    gx.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gx;
    g.fillRect((ux - 0.12) * c.width, 0, 0.24 * c.width, c.height);
  }
  // fabric weave
  for (let n = 0; n < 1400; n++) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    const r = s - Math.floor(s);
    const s2 = Math.sin(n * 311.7) * 12543.21;
    const r2 = s2 - Math.floor(s2);
    g.fillStyle = r > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
    g.fillRect(r * c.width, r2 * c.height, 2, 1);
  }
  // wrinkle hints above the hem
  g.strokeStyle = 'rgba(0,0,0,0.07)';
  g.lineWidth = 3;
  for (const [wx, wy, ww] of [[60, 214, 90], [230, 226, 120], [400, 210, 80]] as const) {
    g.beginPath();
    g.moveTo(wx, wy);
    g.quadraticCurveTo(wx + ww / 2, wy + 8, wx + ww, wy - 2);
    g.stroke();
  }
  // collar band + front placket at the u=0 seam
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, 16);
  g.fillRect(0, 0, 7, 110);
  g.fillRect(c.width - 7, 0, 7, 110);
  // squad number on the back — dark, since the tint caps how bright white
  // can get and a light number would wash out against the kit color
  g.font = '900 92px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(15,15,25,0.62)';
  g.fillText(String(id === 255 ? 99 : id + 1), c.width * 0.5, 96);
  // hem shadow
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, c.height - 6, c.width, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  shirtTexCache.set(id, tex);
  return tex;
}

// Felt tennis ball with the classic curved seam, drawn near-white so the
// material color keeps providing the yellow (and screw-shot purple) tint.

// Human torso silhouette: waist → chest → shoulders, lathed and squashed
// front-to-back into an elliptical cross-section.
function makeTorsoGeometry(): THREE.BufferGeometry {
  const profile: [number, number][] = [
    [0.20, -0.10],
    [0.60, 0.02],
    [0.64, 0.38],
    [0.76, 0.88],
    [0.80, 1.28],
    [0.64, 1.56],
    [0.28, 1.72],
  ];
  const geo = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    20
  );
  geo.scale(1.08, 1, 0.66);
  return geo;
}

// Rebuild the hair meshes for a character's style (parented to the head so
// ball-watching reads through the hair too).
function buildHair(grp: THREE.Group, mat: THREE.MeshLambertMaterial, style: HairStyle) {
  for (const child of [...grp.children]) {
    grp.remove(child);
    (child as THREE.Mesh).geometry?.dispose();
  }
  const add = (geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    m.castShadow = true;
    grp.add(m);
    return m;
  };
  // caps are tilted back so the hairline sits above the brows in front and
  // drops to the nape behind
  const cap = (r: number, cover: number, y: number, tilt = -0.35) =>
    add(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI * cover), 0, y, 0, tilt);
  switch (style) {
    case 'buzz':
      cap(0.615, 0.46, 0.05, -0.3);
      break;
    case 'spiky': {
      cap(0.63, 0.5, 0.04);
      const spike = () => new THREE.ConeGeometry(0.16, 0.45, 6);
      add(spike(), 0, 0.68, 0.05, -0.15, 0);
      add(spike(), 0.27, 0.58, 0.12, -0.25, -0.55);
      add(spike(), -0.27, 0.58, 0.12, -0.25, 0.55);
      add(spike(), 0.17, 0.6, -0.24, 0.6, -0.3);
      add(spike(), -0.17, 0.6, -0.24, 0.6, 0.3);
      break;
    }
    case 'ponytail': {
      cap(0.64, 0.55, 0.04, -0.4);
      add(new THREE.SphereGeometry(0.16, 10, 8), 0, 0.34, -0.52); // bun
      const tail = capsule(0.115, 0.5, mat); // pivot-top: hangs from the bun
      tail.position.set(0, 0.3, -0.56);
      tail.rotation.x = 0.55;
      grp.add(tail);
      break;
    }
    case 'bob':
      cap(0.65, 0.5, 0.03);
      // back + side shell leaving the face open (face is at phi=π/2)
      add(
        new THREE.SphereGeometry(0.65, 18, 12, Math.PI * 0.85, Math.PI * 1.3, 0, Math.PI * 0.68),
        0, 0.02, 0
      );
      break;
    // ---- wacky roster ---------------------------------------------------
    case 'peel': {
      // banana: a stem on top and four peel flaps curling out and down
      cap(0.63, 0.4, 0.05, -0.2);
      add(new THREE.CylinderGeometry(0.06, 0.09, 0.3, 8), 0, 0.72, 0);
      for (const a of [0.5, 2.1, -2.1, -0.5]) {
        add(
          new THREE.ConeGeometry(0.17, 0.52, 8),
          Math.sin(a) * 0.42, 0.5, Math.cos(a) * 0.42,
          Math.cos(a) * 1.25, -Math.sin(a) * 1.25
        );
      }
      break;
    }
    case 'corgi': {
      // fur cap + two big upright triangular ears
      cap(0.63, 0.42, 0.05, -0.25);
      add(new THREE.ConeGeometry(0.2, 0.46, 4), 0.34, 0.6, -0.02, -0.1, -0.35);
      add(new THREE.ConeGeometry(0.2, 0.46, 4), -0.34, 0.6, -0.02, -0.1, 0.35);
      break;
    }
    case 'antenna': {
      // robot: dome plate, boingy antenna, side bolts over the ears
      cap(0.62, 0.32, 0.1, -0.2);
      add(new THREE.CylinderGeometry(0.035, 0.035, 0.4, 6), 0, 0.78, 0);
      add(new THREE.SphereGeometry(0.08, 8, 8), 0, 1.0, 0);
      for (const s of [-1, 1]) {
        const bolt = add(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 8), s * 0.63, 0.02, 0);
        bolt.rotation.z = Math.PI / 2;
      }
      break;
    }
    case 'antennae': {
      // alien: two stalks with glowing-ish bobble tips
      for (const s of [-1, 1]) {
        add(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), s * 0.2, 0.72, 0, 0, -s * 0.45);
        add(new THREE.SphereGeometry(0.09, 8, 8), s * 0.36, 0.92, 0);
      }
      break;
    }
    case 'slick': {
      // slicked-back vampire do with a widow's peak on the forehead
      cap(0.62, 0.48, 0.05, -0.28);
      add(new THREE.ConeGeometry(0.13, 0.32, 3), 0, 0.36, 0.5, 2.7, 0);
      break;
    }
    case 'tricorn': {
      // pirate hat: wide brim + rounded crown, tipped back
      cap(0.62, 0.35, 0.06, -0.2);
      add(new THREE.CylinderGeometry(0.72, 0.72, 0.07, 18), 0, 0.34, 0, -0.12, 0);
      add(new THREE.SphereGeometry(0.52, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 0.34, 0, -0.12, 0);
      break;
    }
    case 'shag': {
      // yeti: oversized shaggy dome with tufts sticking out everywhere
      cap(0.68, 0.62, 0.0, -0.15);
      for (const [x, y, z] of [
        [0.4, 0.35, 0.3], [-0.4, 0.35, 0.3], [0.45, 0.3, -0.3],
        [-0.45, 0.3, -0.3], [0, 0.4, -0.45], [0, 0.66, 0.15],
      ] as const) {
        add(new THREE.SphereGeometry(0.16, 8, 6), x, y, z);
      }
      break;
    }
    case 'bun': {
      cap(0.63, 0.5, 0.04, -0.3);
      add(new THREE.SphereGeometry(0.19, 10, 8), 0, 0.62, -0.18);
      break;
    }
    case 'afro': {
      const fro = add(new THREE.SphereGeometry(0.62, 18, 14), 0, 0.34, -0.06);
      fro.scale.set(1.15, 1.0, 1.05);
      break;
    }
    case 'tentacles': {
      // octopus: mantle cap + tentacles hanging around the sides and back
      cap(0.64, 0.5, 0.03, -0.2);
      for (const a of [1.2, -1.2, 2.0, -2.0, 2.9, -2.9]) {
        const tent = capsule(0.09, 0.42, mat); // pivot-top: hangs like the ponytail
        tent.position.set(Math.sin(a) * 0.5, 0.28, Math.cos(a) * 0.5);
        tent.rotation.set(Math.cos(a) * 0.55, 0, -Math.sin(a) * 0.55);
        grp.add(tent);
      }
      break;
    }
    case 'flower': {
      // cactus: no hair, just the classic little flower on top
      add(new THREE.SphereGeometry(0.09, 8, 8), 0, 0.7, 0);
      for (const k of [0.4, 1.65, 2.9, 4.15, 5.4]) {
        add(new THREE.SphereGeometry(0.075, 8, 6), Math.sin(k) * 0.15, 0.72, Math.cos(k) * 0.15);
      }
      break;
    }
    case 'wizard': {
      // pointy hat with a brim, plus a long beard hanging under the chin
      add(new THREE.CylinderGeometry(0.78, 0.78, 0.06, 18), 0, 0.3, 0, -0.15, 0);
      add(new THREE.ConeGeometry(0.5, 0.95, 14), 0, 0.76, -0.05, -0.15, 0.06);
      add(new THREE.ConeGeometry(0.26, 0.62, 8), 0, -0.5, 0.3, Math.PI, 0);
      break;
    }
    default:
      cap(0.63, 0.52, 0.06);
  }
}

// One string per distinct LOOK. Roster characters key on their id alone;
// career pros share id 255 but differ per player (and per edit), so the key
// folds in every field the dressing below actually reads — colors, hair,
// face, body, and the physique-shaping stat pips.
export function charLookKey(char: Character): string {
  return [
    char.id, char.color, char.skin, char.hair, char.hairStyle,
    char.face ?? '', char.body ?? '',
    char.physique?.legs ?? 1, char.physique?.arms ?? 1, char.physique?.bulk ?? 1,
    char.stats.speed, char.stats.reach, char.stats.power,
  ].join('|');
}

// Dress a rig as a character: kit colors, skin tone, face, hair, body.
export function applyCharacter(rig: PlayerRig, char: Character) {
  const key = charLookKey(char);
  if (rig.charKey === key) return;
  rig.charKey = key;
  rig.torsoMat.color.setHex(char.color);
  rig.torsoMat.map = makeShirtTexture(char.id);
  rig.torsoMat.needsUpdate = true;
  rig.sleeveMatL.color.setHex(char.color);
  rig.sleeveMatR.color.setHex(char.color);
  rig.accentMat.color.setHex(char.color);
  rig.skinMat.color.setHex(char.skin);
  rig.headMat.map = makeFaceTexture(char);
  rig.headMat.needsUpdate = true;
  rig.hairMat.color.setHex(char.hair);
  buildBody(rig, char);
  buildHair(rig.hairGroup, rig.hairMat, char.hairStyle);
  applyPhysique(rig, char);
}

// Body proportions mirror the stat sheet, so you can read an athlete at a
// glance: speed = longer legs, reach = longer arms (racket grows with
// them), power = broader torso and wider shoulders. Limbs get UNIFORM
// scales — their child joints rotate, and a non-uniform parent scale would
// shear a bent elbow/knee.
const HIP_Y = 2.25; // matches the thigh pivot height in makePlayerRig
export function applyPhysique(rig: PlayerRig, char: Character) {
  const s = char.stats;
  // per-character overrides on top of the stat-derived shape (corgi legs,
  // octopus arms, yeti bulk — see Character.physique)
  const o = char.physique;
  const legK = (1 + (s.speed - 3) * 0.05) * (o?.legs ?? 1); // 0.90 (VOLT) … 1.10 (KAI)
  const armK = (1 + (s.reach - 3) * 0.06) * (o?.arms ?? 1); // 0.88 (KAI/ROSA) … 1.12 (VOLT)
  const bulkK = (1 + (s.power - 3) * 0.05) * (o?.bulk ?? 1); // 0.90 (KAI) … 1.10 (BLAZE)

  // legs: scale the whole chain and raise the hips so the feet stay on
  // the floor — everything above rides up with them
  rig.thighL.scale.setScalar(legK);
  rig.thighR.scale.setScalar(legK);
  rig.thighL.position.y = HIP_Y * legK;
  rig.thighR.position.y = HIP_Y * legK;
  const lift = HIP_Y * (legK - 1);
  rig.hipGroup.position.y = lift;
  rig.upper.position.y = 2.62 + lift;

  // arms: longer AND proportionally beefier (uniform), racket included
  rig.shoulderL.scale.setScalar(armK);
  rig.shoulderR.scale.setScalar(armK);

  // torso: power broadens the chest and pushes the shoulders out
  rig.torsoGroup.scale.set(bulkK, 1, 1 + (bulkK - 1) * 0.6);
  rig.shoulderL.position.x = -0.98 * bulkK;
  rig.shoulderR.position.x = 0.98 * bulkK;
}

// ---------------------------------------------------------------------------
// Body builds: the skeleton (joint groups + racket) is permanent, and every
// visible mesh hangs off a joint inside a wrapper group marked as a body
// part. Swapping characters strips those wrappers and rebuilds them, so a
// banana, a corgi and a robot all animate through the exact same joints.
// ---------------------------------------------------------------------------

// Shared static materials — per-character colors live on the rig's own mats.
const SHORTS_MAT = new THREE.MeshLambertMaterial({ color: COLORS.shorts });
const SHOE_MAT = new THREE.MeshLambertMaterial({ color: COLORS.shoe });
const SOLE_MAT = new THREE.MeshLambertMaterial({ color: 0x50525a });
const WHITE_MAT = new THREE.MeshLambertMaterial({ color: 0xf0f2f4 });
const WOOD_MAT = new THREE.MeshLambertMaterial({ color: 0x7a4a26 });
const DARK_MAT = new THREE.MeshLambertMaterial({ color: 0x23252d });
const METAL_MAT = new THREE.MeshLambertMaterial({ color: 0xb8bcc4 });

function bodyPart(parent: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.userData.bodyPart = true;
  parent.add(g);
  return g;
}

function clearBodyParts(rig: PlayerRig) {
  const joints = [
    rig.torsoGroup, rig.hipGroup, rig.head,
    rig.thighL, rig.thighR, rig.calfL, rig.calfR,
    rig.shoulderL, rig.shoulderR, rig.elbowL, rig.elbowR,
  ];
  for (const joint of joints) {
    for (const child of [...joint.children]) {
      if (!child.userData.bodyPart) continue;
      child.traverse(o => (o as THREE.Mesh).geometry?.dispose());
      joint.remove(child);
    }
  }
}

function padd(
  g: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  g.add(m);
  return m;
}

interface LegOpts {
  r: number; len: number; calfR: number; calfLen: number; mat: THREE.Material;
  hem?: THREE.Material; // shorts hem over the thigh
  sock?: THREE.Material;
  foot?: 'shoe' | 'paw' | 'ball' | 'box' | 'none';
  footMat?: THREE.Material;
  flare?: THREE.Material; // bell-bottom cone over the calf
  curl?: boolean; // tentacle tip curling forward instead of a foot
}
function stdLeg(rig: PlayerRig, right: boolean, o: LegOpts) {
  const thigh = bodyPart(right ? rig.thighR : rig.thighL);
  const calf = bodyPart(right ? rig.calfR : rig.calfL);
  thigh.add(capsule(o.r, o.len, o.mat));
  if (o.hem) padd(thigh, new THREE.CylinderGeometry(o.r + 0.06, o.r + 0.1, 0.55, 12), o.hem, 0, -0.38, 0);
  calf.add(capsule(o.calfR, o.calfLen, o.mat));
  const footY = -(o.calfLen + o.calfR + 0.15);
  if (o.sock) padd(calf, new THREE.CylinderGeometry(o.calfR + 0.015, o.calfR + 0.025, 0.42, 10), o.sock, 0, footY + 0.18, 0);
  if (o.flare) padd(calf, new THREE.CylinderGeometry(o.calfR + 0.03, o.calfR + 0.3, 0.85, 12), o.flare, 0, -0.48, 0);
  if (o.curl) padd(calf, new THREE.CapsuleGeometry(o.calfR * 0.75, 0.3, 4, 8), o.mat, 0, footY + 0.1, 0.16, 1.15, 0, 0);
  const fm = o.footMat ?? SHOE_MAT;
  switch (o.foot ?? 'shoe') {
    case 'shoe': {
      const shoe = new THREE.Group();
      shoe.position.set(0, footY, 0.14);
      const up = padd(shoe, new THREE.SphereGeometry(0.32, 14, 10), fm);
      up.scale.set(0.82, 0.55, 1.55);
      padd(shoe, new THREE.BoxGeometry(0.55, 0.09, 0.44), rig.accentMat, 0, 0, 0.05);
      padd(shoe, new THREE.BoxGeometry(0.5, 0.09, 0.95), SOLE_MAT, 0, -0.1, 0);
      calf.add(shoe);
      break;
    }
    case 'paw': {
      const paw = padd(calf, new THREE.SphereGeometry(0.3, 12, 9), fm, 0, footY + 0.04, 0.12);
      paw.scale.set(0.9, 0.55, 1.35);
      break;
    }
    case 'ball': {
      const b = padd(calf, new THREE.SphereGeometry(0.32, 12, 9), fm, 0, footY + 0.04, 0.1);
      b.scale.set(1, 0.6, 1.5);
      break;
    }
    case 'box':
      padd(calf, new THREE.BoxGeometry(0.46, 0.24, 0.85), fm, 0, footY + 0.02, 0.14);
      break;
  }
}

interface ArmOpts {
  sleeve?: { r: number; len: number } | null; // null = bare (no kit sleeve)
  r: number; len: number; foreR: number; foreLen: number; mat: THREE.Material;
  wrist?: THREE.Material | null; // null = no wristband
  hand?: 'ball' | 'paw' | 'hook' | 'none';
  handR?: number; handMat?: THREE.Material;
  cuff?: THREE.Material; // wide flared sleeve cuff over the forearm (wizard)
}
function stdArm(rig: PlayerRig, right: boolean, o: ArmOpts) {
  const sh = bodyPart(right ? rig.shoulderR : rig.shoulderL);
  const el = bodyPart(right ? rig.elbowR : rig.elbowL);
  const sleeveMat = right ? rig.sleeveMatR : rig.sleeveMatL;
  if (o.sleeve !== null) {
    const s = o.sleeve ?? { r: 0.21, len: 0.28 };
    sh.add(capsule(s.r, s.len, sleeveMat));
  }
  const ua = capsule(o.r, o.len, o.mat);
  ua.position.y = -0.18;
  sh.add(ua);
  el.add(capsule(o.foreR, o.foreLen, o.mat));
  const handY = -(o.foreLen + o.foreR + 0.22);
  if (o.wrist !== null) {
    padd(el, new THREE.CylinderGeometry(o.foreR + 0.015, o.foreR + 0.015, 0.14, 10), o.wrist ?? SHOE_MAT, 0, handY + 0.14, 0);
  }
  if (o.cuff) padd(el, new THREE.CylinderGeometry(o.foreR + 0.02, o.foreR + 0.22, 0.55, 12), o.cuff, 0, -0.5, 0);
  const hm = o.handMat ?? o.mat;
  switch (o.hand ?? 'ball') {
    case 'ball':
      padd(el, new THREE.SphereGeometry(o.handR ?? 0.17, 10, 8), hm, 0, handY, 0);
      break;
    case 'paw': {
      const p = padd(el, new THREE.SphereGeometry(o.handR ?? 0.19, 10, 8), WHITE_MAT, 0, handY, 0);
      p.scale.set(0.9, 1.1, 0.9);
      break;
    }
    case 'hook':
      padd(el, new THREE.CylinderGeometry(0.17, 0.15, 0.22, 10), DARK_MAT, 0, handY + 0.05, 0);
      padd(el, new THREE.TorusGeometry(0.14, 0.04, 8, 14, Math.PI * 1.55), METAL_MAT, 0, handY - 0.2, 0, 0, Math.PI / 2, 0);
      break;
  }
}

// Classic lathe torso + skin neck (worn by all the human-ish bodies).
function stdTorso(rig: PlayerRig) {
  const t = bodyPart(rig.torsoGroup);
  padd(t, makeTorsoGeometry(), rig.torsoMat);
  padd(t, new THREE.CylinderGeometry(0.2, 0.24, 0.34, 12), rig.skinMat, 0, 1.8, 0);
  return t;
}

function stdShorts(rig: PlayerRig, mat: THREE.Material = SHORTS_MAT) {
  const hp = bodyPart(rig.hipGroup);
  const shorts = padd(hp, new THREE.CylinderGeometry(0.66, 0.71, 0.8, 16), mat, 0, 2.28, 0);
  shorts.scale.set(1.1, 1, 0.76);
  const belt = padd(hp, new THREE.CylinderGeometry(0.7, 0.7, 0.14, 16), rig.accentMat, 0, 2.6, 0);
  belt.scale.set(1.1, 1, 0.76);
  return hp;
}

function humanHead(rig: PlayerRig, band = true) {
  const hd = bodyPart(rig.head);
  const nose = padd(hd, new THREE.SphereGeometry(0.085, 8, 8), rig.skinMat, 0, -0.04, 0.58);
  nose.scale.set(0.75, 1.1, 1);
  for (const s of [-1, 1]) {
    const ear = padd(hd, new THREE.SphereGeometry(0.11, 8, 8), rig.skinMat, s * 0.58, -0.02, -0.02);
    ear.scale.set(0.45, 0.9, 0.7);
  }
  if (band) padd(hd, new THREE.CylinderGeometry(0.645, 0.645, 0.13, 20), rig.accentMat, 0, 0.24, 0);
}

// Build a character's body onto the shared skeleton. Every case must dress
// all four limbs, the torso, and the hips — the skeleton starts bare.
export function buildBody(rig: PlayerRig, char: Character) {
  clearBodyParts(rig);
  rig.head.scale.set(0.94, 1.06, 0.97); // default skull; bodies may override
  const skin = rig.skinMat, kit = rig.torsoMat, acc = rig.accentMat, hair = rig.hairMat;
  const sides: boolean[] = [false, true];
  switch (char.body ?? 'athlete') {
    case 'banana': {
      // the body IS the banana: fat curved middle tapering toward the head,
      // with a kit-color sash so the team still reads
      const t = bodyPart(rig.torsoGroup);
      const mid = padd(t, new THREE.CapsuleGeometry(0.58, 1.0, 6, 14), skin, 0, 0.8, 0.04, 0.14, 0, 0);
      mid.scale.set(0.94, 1, 0.78);
      padd(t, new THREE.ConeGeometry(0.4, 0.7, 12), skin, 0, 1.75, -0.08, -0.22, 0, 0);
      const sash = padd(t, new THREE.CylinderGeometry(0.63, 0.69, 0.35, 14), kit, 0, 0.5, 0.05, 0.14, 0, 0);
      sash.scale.set(0.95, 1, 0.8);
      const hp = bodyPart(rig.hipGroup);
      const briefs = padd(hp, new THREE.CylinderGeometry(0.52, 0.56, 0.6, 14), kit, 0, 2.35, 0);
      briefs.scale.set(1, 1, 0.8);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.15, len: 0.78, calfR: 0.12, calfLen: 0.72, mat: skin, foot: 'ball', footMat: DARK_MAT });
        stdArm(rig, rt, { sleeve: null, r: 0.11, len: 0.55, foreR: 0.1, foreLen: 0.55, mat: skin, wrist: null, handR: 0.13 });
      }
      break;
    }
    case 'corgi': {
      const t = bodyPart(rig.torsoGroup);
      const fur = padd(t, new THREE.SphereGeometry(0.85, 16, 12), skin, 0, 0.8, 0);
      fur.scale.set(1.05, 1.1, 0.9);
      const chest = padd(t, new THREE.SphereGeometry(0.55, 14, 10), WHITE_MAT, 0, 0.6, 0.38);
      chest.scale.set(0.85, 1.0, 0.55);
      padd(t, new THREE.CylinderGeometry(0.24, 0.3, 0.4, 12), skin, 0, 1.75, 0);
      padd(t, new THREE.TorusGeometry(0.31, 0.07, 8, 16), acc, 0, 1.9, 0, Math.PI / 2, 0, 0); // collar
      const hp = bodyPart(rig.hipGroup);
      const rump = padd(hp, new THREE.SphereGeometry(0.6, 14, 10), skin, 0, 2.3, -0.05);
      rump.scale.set(1.05, 0.8, 0.9);
      const tail = padd(hp, new THREE.SphereGeometry(0.17, 10, 8), skin, 0, 2.5, -0.58);
      tail.scale.set(0.8, 0.8, 1.4);
      tail.rotation.x = -0.7;
      padd(hp, new THREE.SphereGeometry(0.1, 8, 6), WHITE_MAT, 0, 2.64, -0.76); // white tip
      const hd = bodyPart(rig.head);
      const muzzle = padd(hd, new THREE.SphereGeometry(0.3, 12, 9), WHITE_MAT, 0, -0.14, 0.42);
      muzzle.scale.set(0.85, 0.62, 0.95);
      padd(hd, new THREE.SphereGeometry(0.09, 8, 8), DARK_MAT, 0, -0.05, 0.66); // nose
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.22, len: 0.7, calfR: 0.18, calfLen: 0.62, mat: skin, foot: 'paw', footMat: WHITE_MAT });
        stdArm(rig, rt, { sleeve: null, r: 0.14, len: 0.5, foreR: 0.12, foreLen: 0.5, mat: skin, wrist: null, hand: 'paw' });
      }
      break;
    }
    case 'robot': {
      const t = bodyPart(rig.torsoGroup);
      padd(t, new THREE.BoxGeometry(1.2, 1.5, 0.72), skin, 0, 0.85, 0);
      padd(t, new THREE.BoxGeometry(0.72, 0.5, 0.1), kit, 0, 1.05, 0.38); // kit chest panel
      padd(t, new THREE.BoxGeometry(0.5, 0.26, 0.1), DARK_MAT, 0, 0.42, 0.38); // vent
      padd(t, new THREE.CylinderGeometry(0.16, 0.16, 0.4, 10), DARK_MAT, 0, 1.75, 0); // neck piston
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.BoxGeometry(1.0, 0.55, 0.62), DARK_MAT, 0, 2.32, 0);
      padd(hp, new THREE.BoxGeometry(1.04, 0.16, 0.66), acc, 0, 2.62, 0);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.16, len: 0.7, calfR: 0.13, calfLen: 0.64, mat: skin, foot: 'box', footMat: skin });
        stdArm(rig, rt, { sleeve: { r: 0.24, len: 0.16 }, r: 0.13, len: 0.55, foreR: 0.11, foreLen: 0.55, mat: skin, wrist: DARK_MAT, handR: 0.16, handMat: DARK_MAT });
      }
      break;
    }
    case 'alien': {
      rig.head.scale.set(1.22, 1.26, 1.16); // that famous cranium
      const t = bodyPart(rig.torsoGroup);
      padd(t, new THREE.CapsuleGeometry(0.34, 0.85, 6, 12), skin, 0, 0.85, 0);
      padd(t, new THREE.CylinderGeometry(0.42, 0.48, 0.7, 12), kit, 0, 0.8, 0); // tiny tank top
      padd(t, new THREE.CylinderGeometry(0.11, 0.14, 0.5, 10), skin, 0, 1.85, 0); // spindly neck
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.42, 0.46, 0.5, 12), kit, 0, 2.38, 0);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.11, len: 0.78, calfR: 0.09, calfLen: 0.7, mat: skin, foot: 'ball', footMat: skin });
        stdArm(rig, rt, { sleeve: null, r: 0.09, len: 0.58, foreR: 0.08, foreLen: 0.55, mat: skin, wrist: null, handR: 0.15 });
      }
      break;
    }
    case 'vampire': {
      const t = stdTorso(rig);
      // high collar + full-length cape (hair mat = jet black, double-sided)
      for (const s of [-1, 1]) {
        padd(t, new THREE.BoxGeometry(0.3, 0.44, 0.1), hair, s * 0.3, 1.72, -0.14, 0.18, 0, -s * 0.45);
      }
      padd(t, new THREE.CylinderGeometry(0.5, 1.45, 2.6, 14, 1, true, Math.PI / 2, Math.PI), hair, 0, 0.35, -0.12);
      stdShorts(rig, DARK_MAT);
      humanHead(rig, false);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.2, len: 0.75, calfR: 0.16, calfLen: 0.7, mat: hair, foot: 'shoe', footMat: DARK_MAT });
        stdArm(rig, rt, { sleeve: { r: 0.19, len: 0.45 }, r: 0.15, len: 0.5, foreR: 0.13, foreLen: 0.55, mat: hair, wrist: null, handR: 0.16, handMat: skin });
      }
      break;
    }
    case 'pirate': {
      const t = stdTorso(rig);
      padd(t, new THREE.CylinderGeometry(0.8, 1.05, 0.8, 14, 1, true), kit, 0, -0.25, 0); // coat skirt
      padd(t, new THREE.BoxGeometry(0.3, 0.22, 0.08), WHITE_MAT, 0, 0.08, 0.5); // buckle
      stdShorts(rig, DARK_MAT);
      humanHead(rig, false);
      // left leg in a boot; right leg ends in the peg
      stdLeg(rig, false, { r: 0.24, len: 0.75, calfR: 0.19, calfLen: 0.7, mat: skin, hem: DARK_MAT, sock: DARK_MAT, foot: 'shoe', footMat: DARK_MAT });
      const th = bodyPart(rig.thighR);
      th.add(capsule(0.24, 0.75, skin));
      padd(th, new THREE.CylinderGeometry(0.3, 0.34, 0.55, 12), DARK_MAT, 0, -0.38, 0);
      const cf = bodyPart(rig.calfR);
      padd(cf, new THREE.CylinderGeometry(0.1, 0.07, 0.95, 10), WOOD_MAT, 0, -0.5, 0);
      padd(cf, new THREE.CylinderGeometry(0.11, 0.11, 0.1, 10), WOOD_MAT, 0, -1.0, 0);
      stdArm(rig, false, { sleeve: { r: 0.2, len: 0.45 }, r: 0.16, len: 0.5, foreR: 0.14, foreLen: 0.5, mat: kit, wrist: null, hand: 'hook' });
      stdArm(rig, true, { sleeve: { r: 0.2, len: 0.45 }, r: 0.16, len: 0.5, foreR: 0.14, foreLen: 0.5, mat: kit, wrist: null, handR: 0.16, handMat: skin });
      break;
    }
    case 'yeti': {
      const t = bodyPart(rig.torsoGroup);
      const fur = padd(t, new THREE.SphereGeometry(0.95, 16, 12), skin, 0, 0.85, 0);
      fur.scale.set(1.1, 1.05, 0.85);
      const tank = padd(t, new THREE.CylinderGeometry(0.97, 1.02, 0.55, 16), kit, 0, 0.5, 0);
      tank.scale.set(1, 1, 0.85);
      padd(t, new THREE.CylinderGeometry(0.3, 0.36, 0.4, 12), skin, 0, 1.75, 0);
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.72, 0.78, 0.7, 14), skin, 0, 2.28, 0);
      padd(hp, new THREE.CylinderGeometry(0.76, 0.76, 0.14, 14), acc, 0, 2.6, 0);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.3, len: 0.62, calfR: 0.26, calfLen: 0.52, mat: skin, foot: 'ball', footMat: skin });
        stdArm(rig, rt, { sleeve: null, r: 0.24, len: 0.55, foreR: 0.2, foreLen: 0.55, mat: skin, wrist: acc, handR: 0.24 });
      }
      break;
    }
    case 'granny': {
      const t = stdTorso(rig);
      // string of pearls over the cardigan
      for (const a of [-0.9, -0.45, 0, 0.45, 0.9]) {
        padd(t, new THREE.SphereGeometry(0.055, 8, 6), WHITE_MAT, Math.sin(a) * 0.3, 1.62 - Math.cos(a) * 0.08, Math.cos(a) * 0.32);
      }
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.68, 1.05, 1.15, 16), kit, 0, 2.05, 0); // skirt
      padd(hp, new THREE.CylinderGeometry(0.7, 0.7, 0.14, 16), acc, 0, 2.62, 0);
      humanHead(rig, false);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.16, len: 0.72, calfR: 0.13, calfLen: 0.68, mat: skin, sock: WHITE_MAT, foot: 'shoe', footMat: DARK_MAT });
        stdArm(rig, rt, { sleeve: { r: 0.2, len: 0.4 }, r: 0.13, len: 0.5, foreR: 0.115, foreLen: 0.52, mat: skin, wrist: null, handR: 0.15 });
      }
      break;
    }
    case 'disco': {
      const t = stdTorso(rig);
      for (const s of [-1, 1]) {
        padd(t, new THREE.BoxGeometry(0.34, 0.16, 0.06), kit, s * 0.3, 1.62, 0.3, -0.2, 0, s * 0.55); // collar wings
      }
      padd(t, new THREE.TorusGeometry(0.24, 0.035, 8, 14), acc, 0, 1.42, 0.32, 1.25, 0, 0); // chain
      stdShorts(rig, kit);
      humanHead(rig, false);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.2, len: 0.72, calfR: 0.15, calfLen: 0.62, mat: kit, flare: kit, foot: 'shoe', footMat: WHITE_MAT });
        stdArm(rig, rt, { r: 0.17, len: 0.55, foreR: 0.15, foreLen: 0.55, mat: skin });
      }
      break;
    }
    case 'octopus': {
      const t = bodyPart(rig.torsoGroup);
      const mantle = padd(t, new THREE.CapsuleGeometry(0.55, 0.7, 6, 14), skin, 0, 0.9, 0);
      mantle.scale.set(1, 1.05, 0.9);
      padd(t, new THREE.CylinderGeometry(0.58, 0.64, 0.6, 14), kit, 0, 0.75, 0); // tank top
      // tentacle skirt hanging around the hips
      const hp = bodyPart(rig.hipGroup);
      for (const a of [0.45, -0.45, 1.25, -1.25, 2.1, -2.1, 2.9, -2.9]) {
        const tnt = capsule(0.12, 0.6, skin);
        tnt.position.set(Math.sin(a) * 0.45, 2.5, Math.cos(a) * 0.42);
        tnt.rotation.set(Math.cos(a) * 0.4, 0, -Math.sin(a) * 0.4);
        hp.add(tnt);
      }
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.16, len: 0.72, calfR: 0.13, calfLen: 0.62, mat: skin, foot: 'none', curl: true });
        stdArm(rig, rt, { sleeve: null, r: 0.13, len: 0.55, foreR: 0.1, foreLen: 0.55, mat: skin, wrist: acc, handR: 0.11 });
      }
      break;
    }
    case 'cactus': {
      const t = bodyPart(rig.torsoGroup);
      const barrel = padd(t, new THREE.CapsuleGeometry(0.6, 0.85, 6, 14), skin, 0, 0.8, 0);
      barrel.scale.set(1, 1, 0.85);
      for (const a of [0.5, 1.55, 2.6, -2.6, -1.55, -0.5]) { // ribs
        padd(t, new THREE.CapsuleGeometry(0.05, 1.0, 4, 8), skin, Math.sin(a) * 0.56, 1.35, Math.cos(a) * 0.48);
      }
      for (const [a, y] of [[0.3, 1.2], [-0.6, 0.9], [1.1, 0.6], [-1.4, 1.3], [2.4, 0.8], [-2.6, 1.15], [3.0, 1.35], [1.9, 1.05]] as const) {
        padd(t, new THREE.ConeGeometry(0.03, 0.16, 5), WHITE_MAT, Math.sin(a) * 0.6, y, Math.cos(a) * 0.52, Math.cos(a) * 1.4, 0, -Math.sin(a) * 1.4);
      }
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.62, 0.66, 0.6, 14), kit, 0, 2.34, 0);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.18, len: 0.68, calfR: 0.15, calfLen: 0.62, mat: skin, foot: 'shoe', footMat: WHITE_MAT });
        stdArm(rig, rt, { sleeve: null, r: 0.16, len: 0.5, foreR: 0.14, foreLen: 0.5, mat: skin, wrist: acc, handR: 0.14 });
      }
      break;
    }
    case 'wizard': {
      stdTorso(rig);
      const hp = bodyPart(rig.hipGroup);
      padd(hp, new THREE.CylinderGeometry(0.72, 1.2, 1.5, 16), kit, 0, 1.85, 0); // robe
      padd(hp, new THREE.TorusGeometry(0.72, 0.05, 8, 18), acc, 0, 2.58, 0, Math.PI / 2, 0, 0); // rope belt
      humanHead(rig, false);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.17, len: 0.72, calfR: 0.14, calfLen: 0.68, mat: DARK_MAT, foot: 'shoe', footMat: DARK_MAT });
        stdArm(rig, rt, { sleeve: { r: 0.2, len: 0.35 }, r: 0.14, len: 0.5, foreR: 0.12, foreLen: 0.5, mat: skin, wrist: null, handR: 0.15, cuff: kit });
      }
      break;
    }
    default: { // athlete — the classic pro build
      stdTorso(rig);
      stdShorts(rig);
      humanHead(rig);
      for (const rt of sides) {
        stdLeg(rig, rt, { r: 0.24, len: 0.75, calfR: 0.19, calfLen: 0.7, mat: skin, hem: SHORTS_MAT, sock: SHOE_MAT, foot: 'shoe' });
        stdArm(rig, rt, { r: 0.17, len: 0.55, foreR: 0.15, foreLen: 0.55, mat: skin });
      }
    }
  }
}

export function makePlayerRig(side: number, intoScene: THREE.Scene): PlayerRig {
  // (see setRigProp — the racket is hidden for the non-tennis games)
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xe8ae7e });
  const headMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  // double-sided: capes and coat skirts are open shells built from this mat
  const hairMat = new THREE.MeshLambertMaterial({ color: 0x3a2414, side: THREE.DoubleSide });
  const torsoMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const sleeveMatL = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const sleeveMatR = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const accentMat = new THREE.MeshLambertMaterial({ color: 0xffffff });

  const root = new THREE.Group();

  // Bare skeleton: joint groups only — buildBody dresses them per character.
  const mkLeg = (x: number) => {
    const thigh = new THREE.Group();
    thigh.position.set(x, HIP_Y, 0);
    const calf = new THREE.Group();
    calf.position.set(0, -1.15, 0);
    thigh.add(calf);
    root.add(thigh);
    return { thigh, calf };
  };
  const legL = mkLeg(-0.42);
  const legR = mkLeg(0.42);

  const hipGroup = new THREE.Group();
  root.add(hipGroup);

  const upper = new THREE.Group();
  upper.position.y = 2.62;
  root.add(upper);

  const torsoGroup = new THREE.Group();
  upper.add(torsoGroup);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 18), headMat);
  head.position.y = 2.28;
  head.scale.set(0.94, 1.06, 0.97); // gentle oval — skull, not a ball
  head.castShadow = true;
  upper.add(head); // rotated at runtime to watch the ball

  const hairGroup = new THREE.Group();
  head.add(hairGroup);

  const mkArm = (x: number) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(x, 1.55, 0);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.95, 0);
    shoulder.add(elbow);
    upper.add(shoulder);
    return { shoulder, elbow };
  };
  const armL = mkArm(-0.98);
  const armR = mkArm(0.98);

  // racket in the right hand, extending along the forearm
  const racket = new THREE.Group();
  racket.position.set(0, -0.95, 0);
  racket.rotation.x = -0.35;
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8),
    new THREE.MeshLambertMaterial({ color: 0x444444 })
  );
  handle.position.y = -0.35;
  racket.add(handle);
  const rHead = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.06, 8, 22),
    new THREE.MeshLambertMaterial({ color: 0xd8d8e0 })
  );
  rHead.position.y = -1.15;
  rHead.castShadow = true;
  racket.add(rHead);
  const strings = new THREE.Mesh(
    new THREE.CircleGeometry(0.47, 22),
    new THREE.MeshLambertMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
  );
  strings.position.y = -1.15;
  racket.add(strings);
  armR.elbow.add(racket); // permanent — survives body rebuilds
  racket.visible = showProp; // see setRigProp

  root.rotation.order = 'YZX'; // yaw first, then dive-roll about the local Z
  intoScene.add(root);
  return {
    root,
    upper,
    thighL: legL.thigh, calfL: legL.calf,
    thighR: legR.thigh, calfR: legR.calf,
    torsoGroup, hipGroup,
    shoulderL: armL.shoulder, elbowL: armL.elbow,
    shoulderR: armR.shoulder, elbowR: armR.elbow,
    torsoMat, sleeveMatL, sleeveMatR,
    skinMat, headMat, hairMat, accentMat,
    hairGroup,
    racket,
    charKey: '',
    head,
    pose: { ...ZERO_POSE },
    yaw: side === 0 ? Math.PI : 0,
    runSeed: side * 2.7,
    runPhase: side * 2.7,
    prevPX: 0,
    prevPZ: 0,
    swingStart: -1,
    swingKind: 'fore',
    swingLow: false,
    swingStretch: false,
    swingPower: 0.5,
    swingMs: 520,
    windupStart: 0,
    contactPoint: null,
    prevSwingTicks: 0,
    readyT: 0,
    glintArmed: true,
    diveStart: -1,
    diveDir: 1,
    diveKind: 1,
    diveMs: 800,
    diveYaw: 0,
    diveFromX: 0,
    diveFromZ: 0,
    diveLanded: false,
    prevLunge: 0,
  };
}

let playerRigs: PlayerRig[] = [];

// Watcher rigs are pooled by identity: one appears the first frame a person
// is on the grounds and is dropped once they've been gone a while (they left
// the room, or walked onto court and became a player).
interface WatcherRig {
  rig: PlayerRig;
  lastSeen: number;
  emoteKind: number; // 0 = none
  emoteAt: number;
  actKind: number; // jump/wave in progress (-1 = none)
  actAt: number;
  prevActTicks: number;
}
const WATCHER_JUMP_MS = 750;
const WATCHER_WAVE_MS = 1100;
const watcherRigs = new Map<string, WatcherRig>();
const WATCHER_KEEP_MS = 20_000;
let nextWatcherSeed = 0;


export function standPose(now: number, seed: number): Pose {
  const sway = Math.sin(now / 900 + seed) * 0.03;
  return {
    ...ZERO_POSE,
    leanF: 0.04,
    leanS: sway,
    crouch: 0.02 + Math.sin(now / 1300 + seed) * 0.01,
    thighL: -0.05, calfL: 0.08, thighR: -0.05, calfR: 0.08,
    shLx: -0.15 + sway, shLz: 0.12, elL: -0.35,
    shRx: -0.15 - sway, shRz: -0.12, elR: -0.35,
  };
}

// Emote routines: a pose for time t (0..1 through the routine) plus a hop
// height, so the body sells the bubble.

export function applyPose(
  rig: PlayerRig,
  target: Pose,
  rate: number,
  dt: number,
  finalYaw: number,
  now: number
) {
  const a = 1 - Math.exp(-rate * dt);
  const p = rig.pose as any;
  for (const k of POSE_KEYS) p[k] += ((target as any)[k] - p[k]) * a;

  // breathing / micro-motion layer: nothing is ever perfectly still
  const b1 = Math.sin(now / 820 + rig.runSeed * 7) * 0.02;
  const b2 = Math.sin(now / 640 + rig.runSeed * 3) * 0.025;
  const b3 = Math.sin(now / 710 + rig.runSeed * 5 + 2) * 0.025;

  rig.upper.rotation.set(p.leanF + b1, p.twist, p.leanS);
  rig.thighL.rotation.x = p.thighL;
  rig.calfL.rotation.x = p.calfL;
  rig.thighR.rotation.x = p.thighR;
  rig.calfR.rotation.x = p.calfR;
  rig.shoulderL.rotation.set(p.shLx + b2, 0, p.shLz);
  rig.elbowL.rotation.x = p.elL;
  rig.shoulderR.rotation.set(p.shRx + b3, 0, p.shRz);
  rig.elbowR.rotation.x = p.elR;
  rig.root.rotation.y = finalYaw;
  rig.root.position.y = -p.crouch;
}

// --- pose library -----------------------------------------------------------
function readyPose(now: number, seed: number): Pose {
  const sway = Math.sin(now / 550 + seed) * 0.04;
  return {
    ...ZERO_POSE,
    leanF: 0.22,
    crouch: 0.22 + Math.sin(now / 275 + seed) * 0.03,
    thighL: -0.32, calfL: 0.5, thighR: -0.32, calfR: 0.5,
    // two-handed ready grip in front
    shLx: -0.85 + sway, shLz: 0.55, elL: -1.15,
    shRx: -0.85 + sway, shRz: -0.55, elR: -1.15,
  };
}

// Stride cadence: radians of run cycle per world unit of ground covered.
// One full cycle (two steps) then spans ~2π/0.85 ≈ 7.4 units — about what
// these legs actually cover at full extension, so the shoes grip instead
// of skating. The phase is fed from measured movement, not wall-clock time.
const RUN_STRIDE_RATE = 0.85;

export function runPose(phase: number, lean: number): Pose {
  const t = phase;
  const s = Math.sin(t);
  const c = Math.sin(t + Math.PI);
  return {
    ...ZERO_POSE,
    leanF: 0.3,
    leanS: lean * 0.12,
    twist: s * 0.14, // hips/shoulders counter-rotate with the stride
    crouch: 0.12 + Math.abs(Math.sin(t)) * 0.05,
    thighL: s * 1.0, calfL: Math.max(0, -s) * 1.15 + 0.15,
    thighR: c * 1.0, calfR: Math.max(0, -c) * 1.15 + 0.15,
    shLx: c * 0.7 - 0.25, shLz: 0.15, elL: -0.9,
    shRx: s * 0.7 - 0.25, shRz: -0.15, elR: -0.9,
  };
}

// Wound-up backswing, held while the swing button is "live".

// ---------------------------------------------------------------------------
// Character-select live previews: every card shows its character as a real
// animated 3D rig. One shared WebGL canvas is laid over the select screen
// and scissored into a viewport per card (18 separate canvases would blow
// through the browser's WebGL context limit); rects are re-read every frame
// so scrolling and hover transforms stay aligned, and every draw is
// scissored to the scroll panel so characters vanish at its edges. The loop
// self-throttles: while the select screen is hidden every slot rect is
// zero and the frame exits before touching the GPU.
// ---------------------------------------------------------------------------
interface PreviewSlot {
  scene: THREE.Scene;
  rig: PlayerRig;
  el: HTMLElement;
  seed: number;
  clip?: HTMLElement; // per-slot clip container (default: the select grid)
}
let previewRenderer: THREE.WebGLRenderer | null = null;
let previewCam: THREE.PerspectiveCamera | null = null;
let previewSlots: PreviewSlot[] = [];
// scroll container the characters are clipped to — without it they would
// keep drawing above/below the panel once their card scrolls out of it
let previewClip: HTMLElement | null = null;

export function initCharacterPreviews(
  canvas: HTMLCanvasElement,
  slots: { char: Character; el: HTMLElement }[],
  clipEl: HTMLElement
) {
  previewClip = clipEl;
  previewRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  previewCam = new THREE.PerspectiveCamera(40, 1, 0.5, 60);
  previewSlots = slots.map(({ char, el }, i) => {
    const scene = new THREE.Scene();
    const rig = makePlayerRig(0, scene);
    applyCharacter(rig, char);
    const sun = new THREE.DirectionalLight(0xfff2df, 2.4);
    sun.position.set(-3, 6, 5);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x39406b, 1.15));
    return { scene, rig, el, seed: i * 1.73 };
  });
  requestAnimationFrame(previewFrame);
}

// Add a preview slot after init — the career-pro card and the creator both
// show a look that changes at runtime. Returns an updater that re-dresses
// the slot's rig (applyCharacter no-ops when the look key is unchanged).
export function registerPreviewSlot(
  char: Character,
  el: HTMLElement,
  clip?: HTMLElement
): (next: Character) => void {
  const scene = new THREE.Scene();
  const rig = makePlayerRig(0, scene);
  applyCharacter(rig, char);
  const sun = new THREE.DirectionalLight(0xfff2df, 2.4);
  sun.position.set(-3, 6, 5);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x39406b, 1.15));
  previewSlots.push({ scene, rig, el, clip, seed: previewSlots.length * 1.73 });
  return next => applyCharacter(rig, next);
}

let previewDrew = false; // last frame put pixels on the canvas
let previewHadVisible = false;
let previewShownAt = 0; // when slots (re)appeared — drives the entrance fade

function previewFrame() {
  requestAnimationFrame(previewFrame);
  const now = performance.now();
  const r = previewRenderer!;
  const canvas = r.domElement;
  const canvasRect = canvas.getBoundingClientRect();
  const defaultClip = previewClip!.getBoundingClientRect();
  const clipOf = (s: PreviewSlot) =>
    s.clip ? s.clip.getBoundingClientRect() : defaultClip;

  // slots collapse to zero rects while their screen is display:none —
  // one final clear wipes the canvas, then frames become no-ops
  const visible = previewSlots.filter(s => {
    const rect = s.el.getBoundingClientRect();
    const clip = clipOf(s);
    return (
      rect.width > 0 &&
      rect.right > clip.left && rect.left < clip.right &&
      rect.bottom > clip.top && rect.top < clip.bottom
    );
  });
  if (visible.length === 0 && !previewDrew) {
    previewHadVisible = false;
    return;
  }

  // the cards stagger in over ~0.7s when the screen (re)opens; fade the
  // canvas alongside them so the characters don't pop in over empty cards
  if (visible.length > 0 && !previewHadVisible) previewShownAt = now;
  previewHadVisible = visible.length > 0;
  canvas.style.opacity = Math.min(1, Math.max(0, (now - previewShownAt - 100) / 450)).toFixed(3);

  const cw = canvas.clientWidth;
  const chh = canvas.clientHeight;
  if (cw === 0 || chh === 0) return;
  if (canvas.width !== Math.floor(cw * r.getPixelRatio()) || canvas.height !== Math.floor(chh * r.getPixelRatio())) {
    r.setSize(cw, chh, false);
  }

  // clear the whole canvas (transparent), then scissor per card
  r.setScissorTest(false);
  r.setClearColor(0x000000, 0);
  r.clear();
  r.setScissorTest(true);
  previewDrew = visible.length > 0;

  for (const s of visible) {
    const rect = s.el.getBoundingClientRect();
    const clip = clipOf(s);

    // idle life: slow showcase sway (mostly front-facing), breathing, and a
    // relaxed arm hang with a tiny sway — the game's pose system is not
    // running here, so the joints are posed directly
    const t = now / 1000 + s.seed;
    const rig = s.rig;
    rig.root.rotation.y = Math.sin(t * 0.55) * 0.65;
    rig.root.position.y = Math.sin(t * 2.0) * 0.035;
    rig.upper.rotation.x = 0.04 + Math.sin(t * 2.0) * 0.02;
    rig.shoulderL.rotation.set(-0.22 + Math.sin(t * 1.7) * 0.05, 0, 0.14);
    rig.elbowL.rotation.x = -0.5;
    rig.shoulderR.rotation.set(-0.3 + Math.sin(t * 1.7 + 1.2) * 0.05, 0, -0.16);
    rig.elbowR.rotation.x = -0.55;

    // viewport spans the full slot (so a half-scrolled character clips
    // rather than squashes); scissor is the slot ∩ scroll panel ∩ canvas
    const sx0 = Math.max(rect.left, clip.left, canvasRect.left);
    const sx1 = Math.min(rect.right, clip.right, canvasRect.right);
    const sy0 = Math.max(rect.top, clip.top, canvasRect.top);
    const sy1 = Math.min(rect.bottom, clip.bottom, canvasRect.bottom);
    if (sx1 <= sx0 || sy1 <= sy0) continue;
    const left = rect.left - canvasRect.left;
    const bottom = canvasRect.bottom - rect.bottom;
    r.setViewport(left, bottom, rect.width, rect.height);
    r.setScissor(sx0 - canvasRect.left, canvasRect.bottom - sy1, sx1 - sx0, sy1 - sy0);
    previewCam!.aspect = rect.width / rect.height;
    previewCam!.updateProjectionMatrix();
    // frames the full height range: GRANNY's shoes up to MYSTO's hat tip
    previewCam!.position.set(0, 3.3, 9.4);
    previewCam!.lookAt(0, 2.85, 0);
    r.render(s.scene, previewCam!);
  }
}
