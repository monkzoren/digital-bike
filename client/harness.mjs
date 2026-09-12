// Headless integration harness: connects a real websocket client, starts a
// practice race, rides it, and prints the rider state. Not part of the game.
import { DbConnection } from './src/module_bindings/index.ts';

const URI = 'ws://127.0.0.1:3000';
const DB = 'digital-bike';

const conn = await new Promise((resolve, reject) => {
  const c = DbConnection.builder()
    .withUri(URI)
    .withDatabaseName(DB)
    .onConnect(() => resolve(c))
    .onConnectError(e => reject(e))
    .build();
});
console.log('connected');
await new Promise(res => {
  conn.subscriptionBuilder().onApplied(() => res()).subscribeToAllTables();
});
console.log('subscribed');
const me = conn.identity.toHexString();
conn.reducers.setName({ name: 'TESTER' });
conn.reducers.createPractice({ courseId: 0, botLevel: 1, bots: 3 });
const btn = { HOP: 1, TRICK: 2, BOOST: 4 };
let t = 0;
const timer = setInterval(() => {
  t++;
  // ride: tuck, steer toward the racing line crudely, hop and boost often
  const race0 = [...conn.db.race.iter()][0];
  const mine = conn.db.player.identity.find(conn.identity);
  if (mine && race0 && race0.state === 1) {
    const steer = Math.round(Math.sin(t / 9) * 1);
    conn.reducers.setInput({ dirX: steer, dirY: 1, btn: (t % 20 === 0 ? btn.HOP : 0) | (mine.boost > 600 ? btn.BOOST : 0) | (mine.airTicks > 4 ? btn.TRICK : 0) });
  }
  if (t % 10 === 0) {
    const race = [...conn.db.race.iter()][0];
    const rows = [...conn.db.player.iter()].filter(p => !p.spectator);
    const line = rows
      .sort((a, b) => b.s - a.s)
      .map(p => `${p.name}${p.identity.toHexString() === me ? '*' : ''} s=${p.s.toFixed(0)} v=${(p.v * 3.6).toFixed(0)}km/h n=${p.n.toFixed(1)} air=${p.airTicks} crash=${p.crashTicks} boost=${p.boost} pl=${p.place}`)
      .join(' | ');
    console.log(`t=${t} race state=${race?.state} start=${race?.startTicks} el=${race?.elapsed} len=${race?.length?.toFixed(0)} :: ${line}`);
    if (race && race.state === 2) {
      console.log('RACE DONE winner=', race.winnerName);
      const logs = [...conn.db.myRaceLog.iter()];
      console.log('my log:', JSON.stringify(logs.map(l => ({ place: l.place, xp: l.xpGained, mmr: l.mmrAfter, top: l.topSpeed, tricks: l.tricks, t: l.timeTicks }))));
      clearInterval(timer);
      process.exit(0);
    }
  }
}, 100);
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 240000);
