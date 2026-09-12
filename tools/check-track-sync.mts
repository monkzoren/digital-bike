// The track generator lives TWICE — once in spacetimedb/src/index.ts (the
// authority) and once in client/src/track.ts (the renderer's mirror) — because
// only (courseId, seed) ever crosses the wire and both sides rebuild the hill
// from them. If they drift apart, the rider you see is not the rider the
// server is simulating, and nothing about that failure is obvious on screen.
//
// This proves they agree. Run it after touching either generator:
//   cd client && npx tsx ../tools/check-track-sync.ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const MODULE_SRC = join(ROOT, 'spacetimedb/src/index.ts');
const CLIENT_SRC = join(ROOT, 'client/src/track.ts');

// Lift the generator out of the module: everything from the geometry
// constants down to the end of buildCourse, plus the two helpers it uses.
const src = readFileSync(MODULE_SRC, 'utf8');
const start = src.indexOf('const SEG_LEN');
const end = src.indexOf('const courseLength');
if (start < 0 || end < 0) {
  console.error('could not find the generator block in the module — did it move?');
  process.exit(2);
}
const extracted =
  'const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));\n' +
  'const lerp = (a: number, b: number, k: number) => a + (b - a) * k;\n' +
  src.slice(start, end) +
  '\nexport { buildCourse as moduleBuildCourse, COURSES as MOD_COURSES };\n';

const dir = mkdtempSync(join(tmpdir(), 'tracksync-'));
const file = join(dir, 'modgen.ts');
writeFileSync(file, extracted);

const { moduleBuildCourse, MOD_COURSES } = await import(pathToFileURL(file).href);
const { buildSegments } = await import(pathToFileURL(CLIENT_SRC).href);

const SEEDS = [1, 7, 42, 1234567, 0xdeadbeef, 3884703746, 2702780668];
const KEYS = ['curv', 'pitch', 'halfWidth', 'biome', 'feature', 'featureArg'] as const;
let checked = 0;
let bad = 0;

for (let courseId = 0; courseId < MOD_COURSES.length; courseId++) {
  for (const seed of SEEDS) {
    const a = moduleBuildCourse(courseId, seed);
    const b = buildSegments(courseId, seed);
    if (a.length !== b.length) {
      console.error(`length mismatch: course ${courseId} seed ${seed}: ${a.length} vs ${b.length}`);
      bad++;
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      for (const k of KEYS) {
        checked++;
        if (a[i][k] !== b[i][k]) {
          if (bad < 8) {
            console.error(`course ${courseId} seed ${seed} segment ${i}: ${k} ${a[i][k]} vs ${b[i][k]}`);
          }
          bad++;
        }
      }
    }
  }
}

if (bad === 0) {
  console.log(`track generators IN SYNC — ${checked} fields identical (${MOD_COURSES.length} courses x ${SEEDS.length} seeds)`);
  process.exit(0);
}
console.error(`track generators OUT OF SYNC — ${bad} mismatched fields`);
process.exit(1);
