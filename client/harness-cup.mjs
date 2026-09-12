// Integration harness: run a whole CUP (three hills, points, a champion)
// headlessly against a local server. Not part of the game.
import { DbConnection } from './src/module_bindings/index.ts';

const conn = await new Promise((res, rej) => {
  const c = DbConnection.builder()
    .withUri('ws://127.0.0.1:3000').withDatabaseName('digital-bike')
    .onConnect(() => res(c)).onConnectError(e => rej(e)).build();
});
await new Promise(res => conn.subscriptionBuilder().onApplied(() => res()).subscribeToAllTables());
conn.reducers.setName({ name: 'CUPPER' });
conn.reducers.createLobby({
  mode: 1, courseId: 0, isPublic: false, botFill: true, botLevel: 2, stages: 3,
  gravityMul: 1, gripMul: 1, speedMul: 1, airMul: 1,
});
setTimeout(() => conn.reducers.startMatch({}), 1200);

let lastStage = -1;
let t = 0;
const timer = setInterval(() => {
  t++;
  // MY room and MY race — a stale lobby from another session is not this test.
  const me = conn.db.player.identity.find(conn.identity);
  const lobby = me && me.lobbyId ? conn.db.lobby.id.find(me.lobbyId) : null;
  const race = me && me.raceId ? conn.db.race.id.find(me.raceId) : null;
  if (me && race && race.state === 1) {
    // Ride the racing line badly but consistently: full throttle, hop a lot.
    conn.reducers.setInput({ dirX: Math.sin(t / 7) > 0 ? 1 : -1, dirY: 1, btn: t % 9 === 0 ? 1 : 0 });
  }
  if (!lobby || !race) return;
  if (lobby.stage !== lastStage) {
    lastStage = lobby.stage;
    console.log(`--- STAGE ${lobby.stage + 1}/${lobby.stages} course=${race.courseId} seed=${race.seed}`);
  }
  if (t % 100 === 0) {
    const rs = [...conn.db.player.byRace.filter(race.id)].filter(p => !p.spectator);
    console.log(`t=${t} state=${race.state} el=${race.elapsed} fin=${race.finished}/${rs.length} :: ` +
      rs.sort((a, b) => b.s - a.s).map(p => `${p.name}:${p.s.toFixed(0)}m/${p.cupPoints}pts${p.place ? `(P${p.place})` : ''}`).join(' '));
  }
  if (lobby.status === 2) {
    console.log('CUP DONE — champion:', lobby.championName);
    const standings = [...conn.db.player.iter()].filter(p => !p.spectator).sort((a, b) => b.cupPoints - a.cupPoints);
    console.log(standings.map(p => `${p.name} ${p.cupPoints}`).join(' | '));
    const log = [...conn.db.myRaceLog.iter()];
    console.log('my logs:', JSON.stringify(log.map(l => ({ place: l.place, xp: l.xpGained, course: l.courseId }))));
    const acc = conn.db.account.identity.find(conn.identity);
    console.log('account:', JSON.stringify({ xp: acc?.xp, races: acc?.races, podiums: acc?.podiums, tricks: acc?.tricks, top: acc?.topSpeed, cupWins: acc?.cupWins }));
    clearInterval(timer);
    process.exit(0);
  }
}, 100);
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 1500000);
