// Integration harness: ride one course with a competent racing line and
// report the lap time, top speed and crash count. Use it to judge tuning
// changes — "does a rider who steers sensibly get down the hill cleanly?"
import { DbConnection } from './src/module_bindings/index.ts';
import {
  buildCourse, segmentAt, halfWidthAt, SEG_LEN,
  F_KICKER, F_ROCKS, F_LOGX, F_WHOOPS, F_LOG, F_PUDDLE, F_DROP, F_BALES,
} from './src/track.ts';

const conn = await new Promise((res, rej) => {
  const c = DbConnection.builder()
    .withUri('ws://127.0.0.1:3000').withDatabaseName('digital-bike')
    .onConnect(() => res(c)).onConnectError(e => rej(e)).build();
});
await new Promise(res => conn.subscriptionBuilder().onApplied(() => res()).subscribeToAllTables());
conn.reducers.setName({ name: 'LAPPER' });
conn.reducers.createPractice({ courseId: Number(process.argv[2] ?? 0), botLevel: 1, bots: 0 });

let course = null;
const MODE = process.argv[3] ?? 'drift'; // drift | nodrift | smart
const USE_DRIFT = MODE !== 'nodrift';
let driftUntil = 0; // smart mode: hold a committed slide this long
let crashes = 0; // real ones — on the floor, 1.4s gone
let bonks = 0; // knocks: slowed and spun, still riding
let grinds = 0;
let wasGrinding = false;
let wasCrashed = false;
let prev = null; // last sample, for working out what put us down
const causes = {};
const FEATURE_NAMES = {
  [F_KICKER]: 'kicker', [F_ROCKS]: 'rocks', [F_LOGX]: 'log-across',
  [F_WHOOPS]: 'whoops', [F_LOG]: 'log', [F_PUDDLE]: 'puddle',
  [F_DROP]: 'drop', [F_BALES]: 'bales',
};
let top = 0;
const timer = setInterval(() => {
  const me = conn.db.player.identity.find(conn.identity);
  const race = me && me.raceId ? conn.db.race.id.find(me.raceId) : null;
  if (!me || !race) return;
  if (!course) course = buildCourse(race.courseId, race.seed);
  top = Math.max(top, me.v);
  if (me.crashTicks > 0 && !wasCrashed) {
    // A crash starts at 42 ticks, a bonk at 10 — tell them apart.
    const real = me.crashTicks > 20;
    if (real) crashes++;
    else bonks++;
    // Blame something, using the sample just before it happened.
    const hw = halfWidthAt(course, me.s);
    const feat = segmentAt(course, me.s).feature;
    let why;
    if (prev && prev.airTicks > 3) why = 'landing';
    else if (Math.abs(me.n) > hw) why = 'off-track';
    else if (FEATURE_NAMES[feat]) why = FEATURE_NAMES[feat];
    else why = 'unknown';
    const key = (real ? 'CRASH ' : 'bonk ') + why;
    causes[key] = (causes[key] ?? 0) + 1;
  }
  wasCrashed = me.crashTicks > 0;
  prev = { airTicks: me.airTicks, n: me.n, s: me.s, v: me.v };
  if (me.grindTicks > 0 && !wasGrinding) grinds++;
  wasGrinding = me.grindTicks > 0;

  if (race.state === 1 && me.place === 0) {
    // Aim at the inside of the corner ahead, steer for that lateral target.
    const ahead = segmentAt(course, Math.min(course.length - 1, me.s + 45 + me.v * 1.2));
    const hw = halfWidthAt(course, me.s);
    let target = Math.sign(ahead.curv) * hw * 0.45;
    // Go round the rocks rather than through them.
    const rocks = segmentAt(course, Math.min(course.length - 1, me.s + 60));
    if (rocks.feature === F_ROCKS) {
      const side = rocks.featureArg > 0 ? -1 : 1;
      target = Math.max(-hw * 0.9, Math.min(hw * 0.9, rocks.featureArg + side * 5));
    }
    const err = target - (me.n + me.v * Math.sin(me.yaw) * 0.7);
    const steer = Math.max(-1, Math.min(1, err * 0.09 - me.yaw * 1.6));
    // Brake for a corner too tight to hold.
    const hold = Math.sqrt((0.8 * 1.15 * 22) / Math.max(0.0012, Math.abs(ahead.curv)));
    const throttle = me.v > hold ? -1 : 1;
    const nextIdx = Math.floor((me.s + me.v * 0.12) / SEG_LEN);
    const hop = course.segs[Math.min(course.segs.length - 1, nextIdx)]?.feature === F_KICKER;
    // Drift the corners that are too tight to take on grip alone, and let go
    // on the way out to cash the mini-turbo.
    let drift =
      USE_DRIFT && Math.abs(ahead.curv) > 0.008 && me.v > 22 && Math.abs(steer) > 0.4;
    if (MODE === 'smart') {
      const now = Date.now();
      // Commit only to corners worth it, and once committed HOLD long enough
      // to bank a second-tier turbo before letting go.
      if (now < driftUntil) drift = true;
      else if (Math.abs(ahead.curv) > 0.010 && me.v > 24 && Math.abs(steer) > 0.45) {
        driftUntil = now + 1300;
        drift = true;
      } else drift = false;
    }
    conn.reducers.setInput({
      dirX: Math.round(steer * 100), dirY: throttle,
      btn: (hop || drift ? 1 : 0) | (me.boost > 500 && Math.abs(ahead.curv) < 0.005 ? 4 : 0) | (me.airTicks > 8 ? 2 : 0),
    });
  }
  if (me.place > 0 || race.state === 2) {
    console.log(JSON.stringify({
      course: race.courseId, length: Math.round(race.length),
      timeSec: +(me.finishTicks / 30).toFixed(1),
      topKmh: Math.round(top * 3.6), crashes, bonks, drift: USE_DRIFT,
      tricks: me.tricksDone, place: me.place, grinds,
    }));
    console.log('causes:', JSON.stringify(causes));
    clearInterval(timer);
    process.exit(0);
  }
}, 100);
setTimeout(() => { console.log('TIMEOUT crashes=' + crashes); process.exit(1); }, 420000);
