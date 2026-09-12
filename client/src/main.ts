import './update-check';
import { DbConnection } from './module_bindings';
import type { Identity } from 'spacetimedb';
import {
  SPACETIMEDB_URI, DATABASE_NAME, TICK_HZ, BOOST_MAX, MAX_RIDERS,
  BTN_HOP, BTN_TRICK, BTN_BOOST, TRICK_NAMES,
  M_RACE, M_CUP, L_OPEN, L_FINISHED, R_COUNTDOWN, R_LIVE, R_DONE,
  FX_CRASH, FX_LAND_PERFECT, FX_TRICK, FX_BOOSTPAD, FX_KICKER,
  totalXpFor, LEVEL_MAX, kmh, raceClock,
} from './config';
import {
  firebaseEnabled, initAuth, getToken, localToken, accountKind, accountLabel,
  onAuthChange, authDegraded, signInWithGoogle, signInWithPassword,
  signUpWithPassword, sendPasswordReset, isEmailLinkReturn, completeEmailLink,
  signOut,
} from './auth';
import {
  initRenderer, drawScene, riderScreenPos, initCharacterPreviews,
  type Scene, type RenderRider,
} from './render';
import { CHARACTERS } from './characters';
import { setRigProp } from './rig';
import { BIKES, rideStats, pips, STAT_LABELS } from './bikes';
import { COURSES, BIOME_LOOK } from './courses';
import { buildCourse, segmentAt, type Course } from './track';
import {
  charUnlocked, bikeUnlocked, courseUnlocked, lockText, newlyUnlocked,
  CHAR_UNLOCKS, BIKE_UNLOCKS, COURSE_UNLOCKS, ZERO_STATS, type UnlockStats,
} from './unlocks';
import {
  initAudio, resumeAudio, updateRide, playHop, playLand, playCrash,
  playBoost, playTrick, playBeep, playFinish,
} from './audio';
import { getGraphics, setGraphics, applyPreset, presetOf, RESOLUTIONS, FPS_CAPS } from './graphics';
import { initTouch, setTouchVisible, touchDir } from './touch';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
const show = (el: HTMLElement, on: boolean) => el.classList.toggle('hidden', !on);
const canvas = $('game-canvas') as HTMLCanvasElement;
const screens = {
  menu: $('menu'),
  select: $('select'),
  waiting: $('waiting'),
  results: $('results'),
};
type ScreenName = keyof typeof screens | 'race';
let screenName: ScreenName = 'menu';

function goTo(name: ScreenName) {
  screenName = name;
  for (const k of Object.keys(screens) as (keyof typeof screens)[]) {
    show(screens[k], k === name);
  }
  show($('hud'), name === 'race');
  show($('char-canvas'), name === 'select');
  show($('corner-btns'), true);
}

let toastTimer = 0;
function showToast(text: string, color = 'var(--ink)') {
  const t = $('toast');
  t.textContent = text;
  t.style.color = color;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('on'), 2600);
}

function setStatus(text: string) {
  $('connecting').textContent = text;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
let conn: DbConnection;
let myIdentity: Identity | null = null;
let subscribed = false;
let connectFailures = 0;
let reconnecting = false;
let connectGen = 0;
let reconnectTimer = 0;
let connectedDegraded = false;

const myHex = () => myIdentity?.toHexString() ?? '';

const RECONNECT_STEPS = [2000, 4000, 8000];
const retryDelay = () => RECONNECT_STEPS[Math.min(connectFailures, RECONNECT_STEPS.length - 1)];

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    void connect();
  }, retryDelay());
}

/** Tear the socket down and build a new one — used when the identity itself
 *  changes (sign in, sign out), which the player row is keyed to. */
function restartConnection() {
  connectGen++;
  try { conn?.disconnect(); } catch { /* already gone */ }
  void connect();
}

async function connect() {
  const gen = ++connectGen;
  const token = await getToken();
  conn = DbConnection.builder()
    .withUri(SPACETIMEDB_URI)
    .withDatabaseName(DATABASE_NAME)
    .withToken(token)
    .onDisconnect(() => {
      if (gen !== connectGen) return;
      if (!reconnecting) {
        reconnecting = true;
        subscribed = false;
        show($('connecting'), true);
        setStatus('CONNECTION LOST — RECONNECTING…');
      }
      scheduleReconnect();
    })
    .onConnect((_c, identity, tok) => {
      if (gen !== connectGen) return;
      console.log('[db] connected as', identity.toHexString());
      connectFailures = 0;
      reconnecting = false;
      myIdentity = identity;
      connectedDegraded = firebaseEnabled && authDegraded();
      // Without a working Firebase identity this cached token IS the identity.
      if (!firebaseEnabled || connectedDegraded) localToken.set(tok);
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          subscribed = true;
          onSubscribed();
        })
        .onError(e => {
          console.error('[db] subscription error', e);
          setStatus('SUBSCRIPTION ERROR — SERVER/CLIENT VERSION MISMATCH?');
        })
        .subscribe([
          'SELECT * FROM lobby',
          'SELECT * FROM race',
          'SELECT * FROM player',
          'SELECT * FROM chat',
          'SELECT * FROM account',
          // a view: it filters to this caller server-side, so it needs an
          // explicit subscription like any other table
          'SELECT * FROM my_race_log',
        ]);
    })
    .onConnectError((_c, err) => {
      if (gen !== connectGen) return;
      connectFailures++;
      console.error('[db] connect error', err);
      const rejected = /verify token|unauthorized|401/i.test(String((err as any)?.message ?? err));
      if (!firebaseEnabled && (rejected || connectFailures >= 2) && localToken.get()) {
        localToken.clear();
      }
      show($('connecting'), true);
      setStatus(`CONNECTION FAILED — ${reconnecting ? 'RECONNECTING' : 'IS THE SERVER RUNNING?'} RETRYING…`);
      scheduleReconnect();
    })
    .build();

  conn.db.player.onUpdate((_ctx, old, row) => {
    if (row.identity.toHexString() === myHex() && row.kicked && !old.kicked) {
      showToast('THE HOST REMOVED YOU FROM THE ROOM', 'var(--red)');
    }
  });
  conn.db.chat.onInsert((_ctx, row) => pushChat(row));
  conn.db.account.onUpdate((_ctx, old, row) => {
    if (row.identity.toHexString() !== myHex()) return;
    const before = statsOf(old);
    const after = statsOf(row);
    for (const line of newlyUnlocked(before, after)) showToast(`★ ${line}`, 'var(--gold)');
    renderAccountChip();
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
const myAccount = () => (myIdentity ? conn.db.account.identity.find(myIdentity) : undefined);

function statsOf(a: any | undefined): UnlockStats {
  if (!a) return ZERO_STATS;
  return {
    level: a.level, races: a.races, wins: a.wins, podiums: a.podiums,
    botWins: a.botWins, tricks: a.tricks, topSpeed: a.topSpeed,
    cupWins: a.cupWins, courseWins: a.courseWins,
  };
}
const myStats = () => statsOf(myAccount());

const NAME_KEY = 'db_name';
const playerName = () => (localStorage.getItem(NAME_KEY) ?? '').trim();
function setPlayerName(n: string) {
  localStorage.setItem(NAME_KEY, n.trim().slice(0, 16).toUpperCase());
}

/** The account is the source of truth for the nick: pull it down on every
 *  subscribe, and push the local one up when the account has none. */
function adoptAccountName() {
  const acc = myAccount();
  if (!acc) return;
  if (acc.displayName) setPlayerName(acc.displayName);
  else if (playerName()) conn.reducers.setName({ name: playerName() });
}

function renderAccountChip() {
  const acc = myAccount();
  const who = $('account-chip').querySelector('.who') as HTMLElement;
  const kind = accountKind();
  const name = playerName() || 'RIDER';
  if (!acc) {
    who.innerHTML = `<b>${name}</b>`;
    return;
  }
  who.innerHTML = `<b>${name}</b> · LV ${acc.level} · ${acc.mmr} MMR`;
  who.title = kind === 'linked' ? accountLabel() : 'GUEST — sign in to keep your progress';
  renderProfileCard();
}

function renderProfileCard() {
  const acc = myAccount();
  const card = $('profile-card');
  if (!acc) {
    show(card, false);
    return;
  }
  show(card, true);
  const lvl = acc.level;
  const base = totalXpFor(lvl);
  const next = lvl >= LEVEL_MAX ? base : totalXpFor(lvl + 1);
  const pct = next > base ? Math.round(((acc.xp - base) / (next - base)) * 100) : 100;
  const signedIn = accountKind() === 'linked';
  card.innerHTML = `
    <div class="stat-row"><span class="panel-label">LEVEL ${lvl}</span><b>${acc.xp} XP</b></div>
    <div class="xp-bar"><i style="width:${pct}%"></i></div>
    <div class="stat-row"><span>RATING</span><b>${acc.mmr} (PEAK ${acc.peakMmr})</b></div>
    <div class="stat-row"><span>RACES</span><b>${acc.races} · ${acc.wins} WINS · ${acc.podiums} PODIUMS</b></div>
    <div class="stat-row"><span>TOP SPEED</span><b>${acc.topSpeed} KM/H</b></div>
    <div class="stat-row"><span>TRICKS LANDED</span><b>${acc.tricks}</b></div>
    <div class="stat-row"><span>CUPS WON</span><b>${acc.cupWins}</b></div>
    <div class="row" style="margin-top:8px">
      ${firebaseEnabled && !signedIn ? '<button class="primary" id="pc-signin">SIGN IN</button>' : ''}
      ${signedIn ? '<button class="ghost" id="pc-signout">SIGN OUT</button>' : ''}
      <button class="ghost" id="pc-rename">CHANGE NAME</button>
    </div>`;
  card.querySelector('#pc-signin')?.addEventListener('click', () => openSignIn());
  card.querySelector('#pc-signout')?.addEventListener('click', async () => {
    await signOut();
    restartConnection();
  });
  card.querySelector('#pc-rename')?.addEventListener('click', () => openNameModal(null));
}

// ---------------------------------------------------------------------------
// The name gate: the only screen a first-time visitor sees, and a sign-in
// entry point. It hands off to the sign-in modal and waits, so whichever way
// that ends the pending flow resumes.
// ---------------------------------------------------------------------------
let namePending: (() => void) | null = null;
let nameGateWaiting = false;

function openNameModal(then: (() => void) | null) {
  namePending = then;
  const input = $('name-input') as HTMLInputElement;
  input.value = playerName();
  show($('name-modal'), true);
  show($('name-signin'), firebaseEnabled && accountKind() !== 'linked');
  show($('name-or'), firebaseEnabled && accountKind() !== 'linked');
  setTimeout(() => input.focus(), 30);
}

function closeNameModal() {
  show($('name-modal'), false);
  const then = namePending;
  namePending = null;
  then?.();
}

/** Run `fn` once we know who this is. */
function withName(fn: () => void) {
  if (playerName()) {
    fn();
    return;
  }
  openNameModal(fn);
}

$('name-confirm').addEventListener('click', () => {
  const input = $('name-input') as HTMLInputElement;
  const v = input.value.trim().toUpperCase();
  if (!v) {
    input.focus();
    return;
  }
  setPlayerName(v);
  if (subscribed) conn.reducers.setName({ name: playerName() });
  renderAccountChip();
  closeNameModal();
});
$('name-input').addEventListener('keydown', e => {
  if ((e as KeyboardEvent).key === 'Enter') $('name-confirm').click();
});
$('name-signin').addEventListener('click', () => {
  nameGateWaiting = true;
  show($('name-modal'), false);
  openSignIn();
});

// ---------------------------------------------------------------------------
// Sign-in modal
// ---------------------------------------------------------------------------
let signUpMode = false;
function openSignIn() {
  show($('signin-modal'), true);
  ($('si-msg') as HTMLElement).textContent = '';
  show($('si-google'), firebaseEnabled);
  show($('si-or'), firebaseEnabled);
}
function closeSignIn(signedIn: boolean) {
  show($('signin-modal'), false);
  if (nameGateWaiting) {
    nameGateWaiting = false;
    // Whichever way it ended, the flow that opened the gate resumes.
    if (signedIn && playerName()) closeNameModal();
    else openNameModal(namePending);
  }
}
$('si-close').addEventListener('click', () => closeSignIn(false));
$('si-mode').addEventListener('click', () => {
  signUpMode = !signUpMode;
  $('si-title').textContent = signUpMode ? 'CREATE ACCOUNT' : 'SIGN IN';
  $('si-submit').textContent = signUpMode ? 'CREATE' : 'SIGN IN';
  $('si-mode').textContent = signUpMode ? 'I ALREADY HAVE ONE' : 'CREATE ACCOUNT';
});
$('si-submit').addEventListener('click', async () => {
  const email = ($('si-email') as HTMLInputElement).value.trim();
  const pass = ($('si-password') as HTMLInputElement).value;
  const msg = $('si-msg');
  msg.textContent = 'WORKING…';
  const res = signUpMode ? await signUpWithPassword(email, pass) : await signInWithPassword(email, pass);
  if (res.ok) {
    msg.textContent = 'SIGNED IN';
    restartConnection();
    closeSignIn(true);
  } else {
    msg.textContent = res.error.toUpperCase();
  }
});
$('si-forgot').addEventListener('click', async () => {
  const email = ($('si-email') as HTMLInputElement).value.trim();
  const res = await sendPasswordReset(email);
  $('si-msg').textContent = res.ok ? 'RESET EMAIL SENT' : res.error.toUpperCase();
});
$('si-google').addEventListener('click', async () => {
  $('si-msg').textContent = 'WORKING…';
  const res = await signInWithGoogle();
  if (res.ok) {
    restartConnection();
    closeSignIn(true);
  } else {
    $('si-msg').textContent = res.error.toUpperCase();
  }
});

// ---------------------------------------------------------------------------
// Menu → select → room
// ---------------------------------------------------------------------------
type Flow = 'freeride' | 'race' | 'cup';
let flow: Flow = 'freeride';
let selChar = 0;
let selBike = 0;
let selCourse = 0;
let selBots = 3;
let selBotLevel = 1;
let selPublic = true;

const myPlayer = () => (myIdentity ? conn.db.player.identity.find(myIdentity) : undefined);
const myLobby = () => {
  const p = myPlayer();
  return p && p.lobbyId !== 0n ? conn.db.lobby.id.find(p.lobbyId) : undefined;
};
const lobbyPlayers = (lobbyId: bigint) => [...conn.db.player.byLobby.filter(lobbyId)];
const lobbyRaces = (lobbyId: bigint) => [...conn.db.race.byLobby.filter(lobbyId)];
/** The pause between cup legs: the next gate is up but not counting down yet. */
function isCupIntermission(lobby: any, race: any): boolean {
  return (
    !!lobby && lobby.mode === M_CUP && !!race &&
    race.state === R_COUNTDOWN && race.startTicks > TICK_HZ * 4
  );
}
const myRace = () => {
  const p = myPlayer();
  return p && p.raceId !== 0n ? conn.db.race.id.find(p.raceId) : undefined;
};
const isHost = () => {
  const l = myLobby();
  return !!l && l.hostId.toHexString() === myHex();
};

$('btn-freeride').addEventListener('click', () => withName(() => openSelect('freeride')));
$('btn-race').addEventListener('click', () => withName(() => openSelect('race')));
$('btn-cup').addEventListener('click', () => withName(() => openSelect('cup')));
$('btn-join').addEventListener('click', () => {
  const code = prompt('ROOM CODE')?.trim().toUpperCase();
  if (!code) return;
  withName(() => joinByCode(code));
});

function joinByCode(code: string) {
  conn.reducers.setName({ name: playerName() });
  conn.reducers.setCharacter({ characterId: selChar, bikeId: selBike });
  conn.reducers.joinLobby({ code });
  goTo('waiting');
}

function openSelect(f: Flow) {
  flow = f;
  $('select-title').textContent =
    f === 'freeride' ? 'FREE RIDE' : f === 'race' ? 'QUICK RACE' : 'CUP — THREE HILLS';
  show($('course-divider'), true);
  renderSelect();
  goTo('select');
}

// --- the grids ------------------------------------------------------------
let previewsReady = false;

/** The rider cards, with their live 3D previews. Built once: the preview
 *  slots keep references to these elements. */
function buildCharGrid(st: UnlockStats) {
  if (previewsReady) {
    // Only the lock captions can change while the screen is open.
    [...$('char-grid').children].forEach((el, i) => {
      const open = charUnlocked(st, i);
      el.classList.toggle('locked', !open);
      const cap = el.querySelector('.lockmsg') as HTMLElement | null;
      if (cap) cap.textContent = open ? '' : lockText(st, CHAR_UNLOCKS[i]!);
    });
    return;
  }
  previewsReady = true;
  const charGrid = $('char-grid');
  charGrid.innerHTML = '';
  const slots: { char: (typeof CHARACTERS)[number]; el: HTMLElement }[] = [];
  CHARACTERS.forEach((c, i) => {
    const el = document.createElement('div');
    const open = charUnlocked(st, i);
    el.className = `sel-card${open ? '' : ' locked'}`;
    el.innerHTML = `
      <div class="preview"></div>
      <div class="nm">${c.name}</div>
      <div class="sub">${c.flag} ${c.style}</div>
      <div class="lockmsg">${open ? '' : lockText(st, CHAR_UNLOCKS[i]!)}</div>`;
    el.addEventListener('click', () => {
      if (!charUnlocked(myStats(), i)) {
        showToast(lockText(myStats(), CHAR_UNLOCKS[i]!), 'var(--gold)');
        return;
      }
      selChar = i;
      renderSelect();
    });
    charGrid.appendChild(el);
    slots.push({ char: c, el: el.querySelector('.preview') as HTMLElement });
  });
  initCharacterPreviews($('char-canvas') as HTMLCanvasElement, slots, charGrid);
}

function pipRow(label: string, mul: number): string {
  const n = pips(mul);
  let dots = '';
  for (let i = 0; i < 5; i++) dots += `<i class="${i < n ? 'on' : ''}"></i>`;
  return `<div class="pip-row"><span>${label}</span><span class="pip-dots">${dots}</span></div>`;
}

function renderSelect() {
  const st = myStats();
  buildCharGrid(st);
  // Selection is a class flip: the cards themselves are permanent.
  [...$('char-grid').children].forEach((el, i) => {
    el.classList.toggle('on', i === selChar);
  });
  // --- bikes -------------------------------------------------------------
  const bikeGrid = $('bike-grid');
  bikeGrid.innerHTML = '';
  BIKES.forEach((b, i) => {
    const open = bikeUnlocked(st, i);
    const el = document.createElement('div');
    el.className = `sel-card${i === selBike ? ' on' : ''}${open ? '' : ' locked'}`;
    const combo = rideStats(selChar, i);
    el.innerHTML = `
      <div class="nm" style="color:${b.css}">${b.name}</div>
      <div class="sub">${b.desc}</div>
      <div class="pips">${STAT_LABELS.map(([k, l]) => pipRow(l, combo[k])).join('')}</div>
      ${open ? '' : `<div class="lockmsg">${lockText(st, BIKE_UNLOCKS[i]!)}</div>`}`;
    el.addEventListener('click', () => {
      if (!open) {
        showToast(lockText(st, BIKE_UNLOCKS[i]!), 'var(--gold)');
        return;
      }
      selBike = i;
      renderSelect();
    });
    bikeGrid.appendChild(el);
  });

  // --- hills -------------------------------------------------------------
  const courseGrid = $('course-grid');
  courseGrid.innerHTML = '';
  COURSES.forEach((c, i) => {
    const open = courseUnlocked(st, i);
    const el = document.createElement('div');
    el.className = `sel-card${i === selCourse ? ' on' : ''}${open ? '' : ' locked'}`;
    el.style.width = '150px';
    el.innerHTML = `
      <div class="nm" style="color:${c.css}">${c.name}</div>
      <div class="sub">${c.where}</div>
      <div class="sub" style="margin-top:5px">${c.desc}</div>
      <div class="sub" style="color:var(--gold);margin-top:4px">${c.km} · ${'★'.repeat(c.difficulty + 1)}</div>
      ${open ? '' : `<div class="lockmsg">${lockText(st, COURSE_UNLOCKS[i]!)}</div>`}`;
    el.addEventListener('click', () => {
      if (!open) {
        showToast(lockText(st, COURSE_UNLOCKS[i]!), 'var(--gold)');
        return;
      }
      selCourse = i;
      renderSelect();
    });
    courseGrid.appendChild(el);
  });
}

$('select-back').addEventListener('click', () => goTo('menu'));
$('select-go').addEventListener('click', () => {
  conn.reducers.setName({ name: playerName() });
  conn.reducers.setCharacter({ characterId: selChar, bikeId: selBike });
  if (flow === 'freeride') {
    conn.reducers.createPractice({ courseId: selCourse, botLevel: selBotLevel, bots: selBots });
    goTo('race');
  } else {
    conn.reducers.createLobby({
      mode: flow === 'cup' ? M_CUP : M_RACE,
      courseId: selCourse,
      isPublic: selPublic,
      botFill: true,
      botLevel: selBotLevel,
      stages: flow === 'cup' ? 3 : 1,
      gravityMul: 1, gripMul: 1, speedMul: 1, airMul: 1,
    });
    goTo('waiting');
  }
  initAudio();
  resumeAudio();
});

// --- public room browser ---------------------------------------------------
function renderLobbyList() {
  const list = $('lobby-list');
  const rows = [...conn.db.lobby.iter()].filter(l => l.isPublic && l.status === L_OPEN);
  if (rows.length === 0) {
    list.innerHTML = '<div class="lobby-row" style="justify-content:center;color:var(--dim-2)">NO PUBLIC ROOMS RIGHT NOW</div>';
    return;
  }
  list.innerHTML = '';
  for (const l of rows) {
    const riders = lobbyPlayers(l.id).filter(p => !p.spectator);
    const host = riders.find(p => p.identity.toHexString() === l.hostId.toHexString());
    const el = document.createElement('div');
    el.className = 'lobby-row';
    el.innerHTML = `
      <b>${l.code}</b>
      <span>${l.mode === M_CUP ? '🏆 CUP' : '🏁 RACE'}</span>
      <span style="color:var(--dim)">${COURSES[l.courseId]?.name ?? '—'}</span>
      <span class="sp">${host?.name ?? '—'} · ${riders.length}/${MAX_RIDERS}</span>`;
    const join = document.createElement('button');
    join.className = 'ghost';
    join.textContent = 'JOIN';
    join.addEventListener('click', () => withName(() => joinByCode(l.code)));
    el.appendChild(join);
    list.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// The room (waiting overlay)
// ---------------------------------------------------------------------------
function renderWaiting() {
  const lobby = myLobby();
  if (!lobby) return;
  const riders = lobbyPlayers(lobby.id).filter(p => !p.spectator);
  const humans = riders.filter(p => !p.isBot);
  const unready = humans.filter(p => !p.ready).length;
  $('waiting-title').textContent =
    lobby.mode === M_CUP ? `CUP · ${lobby.stages} HILLS` : 'QUICK RACE';
  $('waiting-code').textContent = lobby.code;
  const link = `${location.origin}/?lobby=${lobby.code}`;
  $('waiting-link').textContent = link;
  $('waiting-info').innerHTML = `
    <span class="info-pill">HILL <span class="v">${COURSES[lobby.courseId]?.name ?? '—'}</span></span>
    <span class="info-pill">BOTS <span class="v">${lobby.botFill ? ['EASY', 'NORMAL', 'HARD'][lobby.botLevel] : 'OFF'}</span></span>
    <span class="info-pill">${lobby.isPublic ? 'PUBLIC' : 'PRIVATE'}</span>`;

  const box = $('waiting-players');
  box.innerHTML = '';
  for (const p of riders) {
    const el = document.createElement('div');
    const me = p.identity.toHexString() === myHex();
    el.className = `player-chip${p.identity.toHexString() === lobby.hostId.toHexString() ? ' host' : ''}${me ? ' me' : ''}`;
    const ch = CHARACTERS[p.characterId];
    el.innerHTML = `
      <span class="chip-name">${p.name || 'RIDER'}</span>
      <span class="chip-char">${ch?.name ?? ''} · ${BIKES[p.bikeId]?.name ?? ''}</span>
      ${p.ready || p.isBot ? '<span class="ready-tag">READY</span>' : ''}`;
    if (isHost() && !me) {
      const kick = document.createElement('button');
      kick.className = 'chip-kick';
      kick.textContent = '✕';
      kick.addEventListener('click', () => conn.reducers.kickPlayer({ target: p.identity }));
      el.appendChild(kick);
    }
    box.appendChild(el);
  }
  const mine = myPlayer();
  $('waiting-ready').textContent = mine?.ready ? 'NOT READY' : 'READY UP';
  show($('waiting-start'), isHost());
  $('waiting-start').textContent = unready > 0 ? `START ANYWAY (${unready} NOT READY)` : 'START';
  show($('waiting-settings'), isHost());
}

$('waiting-ready').addEventListener('click', () => {
  const mine = myPlayer();
  conn.reducers.setReady({ ready: !mine?.ready });
});
$('waiting-start').addEventListener('click', () => {
  try {
    conn.reducers.startMatch({});
  } catch (e) {
    showToast(String(e));
  }
});
$('waiting-leave').addEventListener('click', () => {
  conn.reducers.leaveLobby({});
  goTo('menu');
});
$('copy-link').addEventListener('click', () => {
  const lobby = myLobby();
  if (!lobby) return;
  void navigator.clipboard?.writeText(`${location.origin}/?lobby=${lobby.code}`);
  showToast('LINK COPIED');
});

// --- room settings ---------------------------------------------------------
$('waiting-settings').addEventListener('click', () => {
  const lobby = myLobby();
  if (!lobby) return;
  const body = $('rules-body');
  body.innerHTML = `
    <div class="stat-row"><span>HILL</span><select id="rs-course"></select></div>
    <div class="stat-row"><span>BOT DIFFICULTY</span><select id="rs-bots"></select></div>
    <div class="stat-row"><span>FILL THE GRID WITH BOTS</span><input type="checkbox" id="rs-fill" ${lobby.botFill ? 'checked' : ''} /></div>
    <div class="stat-row"><span>PUBLIC ROOM</span><input type="checkbox" id="rs-public" ${lobby.isPublic ? 'checked' : ''} /></div>
    <div class="divider" style="margin-top:6px">CUSTOM PHYSICS</div>
    ${sliderRow('GRAVITY', 'rs-grav', lobby.gravityMul)}
    ${sliderRow('GRIP', 'rs-grip', lobby.gripMul)}
    ${sliderRow('SPEED', 'rs-speed', lobby.speedMul)}
    ${sliderRow('AIR', 'rs-air', lobby.airMul)}`;
  const cs = body.querySelector('#rs-course') as HTMLSelectElement;
  const st = myStats();
  COURSES.forEach((c, i) => {
    if (!courseUnlocked(st, i)) return;
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = c.name;
    if (i === lobby.courseId) o.selected = true;
    cs.appendChild(o);
  });
  const bs = body.querySelector('#rs-bots') as HTMLSelectElement;
  ['EASY', 'NORMAL', 'HARD'].forEach((n, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = n;
    if (i === lobby.botLevel) o.selected = true;
    bs.appendChild(o);
  });
  show($('rules-modal'), true);
});
function sliderRow(label: string, id: string, val: number): string {
  return `<div class="stat-row"><span>${label}</span><input type="range" id="${id}" min="0.5" max="2" step="0.05" value="${val}" /></div>`;
}
$('rules-close').addEventListener('click', () => {
  const num = (id: string, def: number) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    return el ? Number(el.value) : def;
  };
  const chk = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
  try {
    conn.reducers.setLobbySettings({
      courseId: num('rs-course', selCourse),
      botLevel: num('rs-bots', selBotLevel),
      botFill: chk('rs-fill'),
      stages: 3,
      isPublic: chk('rs-public'),
      gravityMul: num('rs-grav', 1),
      gripMul: num('rs-grip', 1),
      speedMul: num('rs-speed', 1),
      airMul: num('rs-air', 1),
    });
  } catch (e) {
    showToast(String(e), 'var(--red)');
  }
  show($('rules-modal'), false);
});

// ---------------------------------------------------------------------------
// Input. The client sends held direction + a button bitmask; nothing else.
// ---------------------------------------------------------------------------
const keys = new Set<string>();
let lastDirX = 0;
let lastDirY = 0;
let lastBtn = 0;
let chatOpen = false;

const KEY_LEFT = ['a', 'arrowleft'];
const KEY_RIGHT = ['d', 'arrowright'];
const KEY_UP = ['w', 'arrowup'];
const KEY_DOWN = ['s', 'arrowdown'];
const has = (list: string[]) => list.some(k => keys.has(k));

function readInput(): { x: number; y: number; btn: number } {
  let x = 0;
  let y = 0;
  let btn = 0;
  if (!chatOpen) {
    if (has(KEY_LEFT)) x -= 1;
    if (has(KEY_RIGHT)) x += 1;
    if (has(KEY_UP)) y += 1;
    if (has(KEY_DOWN)) y -= 1;
    if (keys.has(' ') || keys.has('j')) btn |= BTN_HOP;
    if (keys.has('k') || keys.has('shift')) btn |= BTN_TRICK;
    if (keys.has('l') || keys.has('control')) btn |= BTN_BOOST;
  }
  // Touch stick overrides when it is being held.
  const [tx, ty] = touchDir();
  if (tx !== 0 || ty !== 0) {
    x = tx;
    y = ty;
  }
  btn |= touchButtons;
  // Gamepad: left stick + face buttons.
  const pad = navigator.getGamepads?.().find(p => p && p.connected);
  if (pad) {
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    if (Math.abs(ax) > 0.35) x = Math.sign(ax);
    if (Math.abs(ay) > 0.35) y = -Math.sign(ay);
    if (pad.buttons[0]?.pressed) btn |= BTN_HOP;
    if (pad.buttons[1]?.pressed) btn |= BTN_TRICK;
    if (pad.buttons[2]?.pressed || pad.buttons[7]?.pressed) btn |= BTN_BOOST;
  }
  return { x, y, btn };
}

let touchButtons = 0;
initTouch({
  button: (mask, down) => {
    touchButtons = down ? touchButtons | mask : touchButtons & ~mask;
  },
});

function sendInput() {
  if (!subscribed) return;
  const { x, y, btn } = readInput();
  if (x === lastDirX && y === lastDirY && btn === lastBtn) return;
  lastDirX = x;
  lastDirY = y;
  lastBtn = btn;
  conn.reducers.setInput({ dirX: x, dirY: y, btn });
}

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (chatOpen) {
    if (k === 'escape') closeChat();
    return;
  }
  if (k === 'enter' || k === 't') {
    if (myLobby()) {
      openChat();
      e.preventDefault();
      return;
    }
  }
  if (k === 'escape' && screenName === 'race') {
    togglePause();
    return;
  }
  if (k === 'g') toggleGraphics();
  if (k === 'f') toggleFullscreen();
  if (k >= '1' && k <= '8' && myLobby()) {
    conn.reducers.sendEmote({ index: Number(k) - 1 });
  }
  keys.add(k);
  if ([...KEY_UP, ...KEY_DOWN, ...KEY_LEFT, ...KEY_RIGHT, ' '].includes(k)) e.preventDefault();
  resumeAudio();
});
window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

// ---------------------------------------------------------------------------
// Chat + emotes
// ---------------------------------------------------------------------------
const chatLines: { name: string; text: string; at: number; emote: boolean }[] = [];
function pushChat(row: any) {
  const mine = myLobby();
  if (!mine || row.lobbyId !== mine.id) return;
  chatLines.push({ name: row.senderName, text: row.text, at: performance.now(), emote: row.emote });
  while (chatLines.length > 8) chatLines.shift();
  renderChat();
}
function renderChat() {
  const feed = $('chat-feed');
  const now = performance.now();
  const live = chatLines.filter(l => now - l.at < 9000);
  feed.innerHTML = live
    .map(l => `<div class="line"><b>${l.name}:</b> ${l.emote ? `<span style="font-size:18px">${l.text}</span>` : escapeHtml(l.text)}</div>`)
    .join('');
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function openChat() {
  chatOpen = true;
  $('chat-input').classList.add('on');
  ($('chat-input') as HTMLInputElement).focus();
}
function closeChat() {
  chatOpen = false;
  $('chat-input').classList.remove('on');
  ($('chat-input') as HTMLInputElement).value = '';
}
$('chat-input').addEventListener('keydown', e => {
  const ev = e as KeyboardEvent;
  if (ev.key !== 'Enter') return;
  const input = $('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (text) {
    try {
      conn.reducers.sendChat({ text });
    } catch { /* rate limited — the server said no */ }
  }
  closeChat();
});

// ---------------------------------------------------------------------------
// Pause menu
// ---------------------------------------------------------------------------
function togglePause() {
  const open = !$('pause-modal').classList.contains('hidden');
  show($('pause-modal'), !open);
  if (!open) renderPauseRoom();
}
function renderPauseRoom() {
  const lobby = myLobby();
  const box = $('pause-room');
  box.innerHTML = '';
  if (!lobby) return;
  for (const p of lobbyPlayers(lobby.id).filter(p => !p.spectator)) {
    const me = p.identity.toHexString() === myHex();
    const el = document.createElement('div');
    el.className = `player-chip${me ? ' me' : ''}`;
    el.innerHTML = `<span class="chip-name">${p.name}</span><span class="chip-char">${CHARACTERS[p.characterId]?.name ?? ''}</span>`;
    if (isHost() && !me) {
      const kick = document.createElement('button');
      kick.className = 'chip-kick';
      kick.textContent = '✕';
      kick.addEventListener('click', () => {
        conn.reducers.kickPlayer({ target: p.identity });
        renderPauseRoom();
      });
      el.appendChild(kick);
    }
    box.appendChild(el);
  }
}
$('pause-resume').addEventListener('click', () => togglePause());
$('pause-gfx').addEventListener('click', () => {
  togglePause();
  toggleGraphics();
});
$('pause-quit').addEventListener('click', () => {
  conn.reducers.forfeit({});
  show($('pause-modal'), false);
  goTo('menu');
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
let resultsShownFor = 0n;

function renderResults(race: any) {
  const lobby = myLobby();
  const riders = [...conn.db.player.byRace.filter(race.id)]
    .filter(p => !p.spectator)
    .sort((a, b) => (a.place || 99) - (b.place || 99));
  const cup = lobby?.mode === M_CUP;
  const done = !lobby || lobby.status === L_FINISHED;
  $('results-title').textContent = cup
    ? done ? `CUP CHAMPION — ${lobby?.championName ?? ''}` : `HILL ${(lobby!.stage ?? 0) + 1} OF ${lobby!.stages}`
    : 'RESULTS';

  const board = $('results-board');
  board.innerHTML = '';
  const winnerTicks = riders[0]?.finishTicks || race.elapsed;
  for (const p of riders) {
    const me = p.identity.toHexString() === myHex();
    const el = document.createElement('div');
    el.className = `res-row${p.place === 1 ? ' p1' : ''}${me ? ' me' : ''}`;
    const time = p.finishTicks
      ? p.place === 1
        ? raceClock(p.finishTicks)
        : `+${raceClock(p.finishTicks - winnerTicks).replace('0:', '')}`
      : 'DNF';
    el.innerHTML = `
      <span class="pl">${p.place || '—'}</span>
      <span>${p.name}</span>
      <span class="chip-char">${CHARACTERS[p.characterId]?.name ?? ''} · ${BIKES[p.bikeId]?.name ?? ''}</span>
      ${cup ? `<span class="pts">${p.cupPoints} PTS</span>` : ''}
      <span class="tm">${time}</span>`;
    board.appendChild(el);
  }

  // What this race did to the profile — read from my own newest log row.
  const logs = [...conn.db.myRaceLog.iter()].sort((a, b) => (a.id < b.id ? 1 : -1));
  const mine = logs.find(l => l.raceId === race.id);
  const reveal = $('reveal');
  reveal.innerHTML = mine
    ? `<span class="info-pill">+<span class="v">${mine.xpGained} XP</span></span>
       <span class="info-pill">LEVEL <span class="v">${mine.levelAfter}</span></span>
       <span class="info-pill">${mine.ranked ? `MMR <span class="v">${mine.mmrBefore} → ${mine.mmrAfter}</span>` : 'CASUAL — RATING UNCHANGED'}</span>
       <span class="info-pill">TOP <span class="v">${mine.topSpeed} KM/H</span></span>
       <span class="info-pill">TRICKS <span class="v">${mine.tricks}</span></span>`
    : '';

  show($('results-again'), isHost() && done);
  $('results-again').textContent = cup ? 'RUN THE CUP AGAIN' : 'RIDE AGAIN';
}

$('results-leave').addEventListener('click', () => {
  conn.reducers.leaveLobby({});
  goTo('menu');
});
$('results-again').addEventListener('click', () => {
  conn.reducers.rematch({});
  goTo('race');
});

// ---------------------------------------------------------------------------
// Graphics panel + fullscreen
// ---------------------------------------------------------------------------
function toggleGraphics() {
  const panel = $('graphics');
  const opening = panel.classList.contains('hidden');
  show(panel, opening);
  if (opening) renderGraphics();
}
$('btn-gfx').addEventListener('click', toggleGraphics);
$('gfx-close').addEventListener('click', () => show($('graphics'), false));
for (const b of document.querySelectorAll('#graphics [data-preset]')) {
  b.addEventListener('click', () => {
    applyPreset((b as HTMLElement).dataset.preset as any);
    renderGraphics();
  });
}

function renderGraphics() {
  const g = getGraphics();
  const rows = $('gfx-rows');
  const seg = (label: string, opts: [string, () => void, boolean][]) =>
    `<div class="gfx-row"><span>${label}</span><span class="seg">${opts
      .map((o, i) => `<button data-k="${label}" data-i="${i}" class="${o[2] ? 'on' : ''}">${o[0]}</button>`)
      .join('')}</span></div>`;
  const handlers: Record<string, (() => void)[]> = {};
  const build = (label: string, opts: [string, () => void, boolean][]) => {
    handlers[label] = opts.map(o => o[1]);
    return seg(label, opts);
  };
  rows.innerHTML = [
    build('RESOLUTION', RESOLUTIONS.map(r => [`${Math.round(r * 100)}%`, () => setGraphics({ resolution: r }), g.resolution === r] as [string, () => void, boolean])),
    build('SHADOWS', [['OFF', () => setGraphics({ shadows: 0 }), g.shadows === 0], ['LOW', () => setGraphics({ shadows: 1 }), g.shadows === 1], ['HIGH', () => setGraphics({ shadows: 2 }), g.shadows === 2]]),
    build('ANTI-ALIAS', [['OFF', () => setGraphics({ antialias: false }), !g.antialias], ['ON', () => setGraphics({ antialias: true }), g.antialias]]),
    build('PARTICLES', [['OFF', () => setGraphics({ particles: false }), !g.particles], ['ON', () => setGraphics({ particles: true }), g.particles]]),
    build('BOOST TRAIL', [['OFF', () => setGraphics({ trail: false }), !g.trail], ['ON', () => setGraphics({ trail: true }), g.trail]]),
    build('SCENERY', [['OFF', () => setGraphics({ detail: false }), !g.detail], ['ON', () => setGraphics({ detail: true }), g.detail]]),
    build('FILM GRADE', [['OFF', () => setGraphics({ grade: false }), !g.grade], ['ON', () => setGraphics({ grade: true }), g.grade]]),
    build('FPS LIMIT', FPS_CAPS.map(c => [c === 0 ? 'MAX' : String(c), () => setGraphics({ fpsCap: c }), g.fpsCap === c] as [string, () => void, boolean])),
  ].join('');
  for (const b of rows.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const label = (b as HTMLElement).dataset.k!;
      const i = Number((b as HTMLElement).dataset.i);
      handlers[label][i]();
      renderGraphics();
    });
  }
  const preset = presetOf();
  for (const b of document.querySelectorAll('#graphics [data-preset]')) {
    b.classList.toggle('on', (b as HTMLElement).dataset.preset === preset);
  }
}

function toggleFullscreen() {
  const app = $('app');
  if (document.fullscreenElement) void document.exitFullscreen();
  else void app.requestFullscreen?.();
}
$('btn-full').addEventListener('click', toggleFullscreen);

// ---------------------------------------------------------------------------
// The frame loop
// ---------------------------------------------------------------------------
let lastCountdownBeep = -1;
let lastBiome = -1;
let biomeTimer = 0;
let trickTimer = 0;
let lastFx = 0;
let fpsSamples: number[] = [];
let lastFrameAt = 0;

function riderRows(raceId: bigint) {
  return [...conn.db.player.byRace.filter(raceId)].filter(p => !p.spectator);
}

function toRenderRider(p: any): RenderRider {
  return {
    key: p.identity.toHexString(),
    name: p.name || 'RIDER',
    characterId: p.characterId,
    bikeId: p.bikeId,
    s: p.s, n: p.n, v: p.v, yaw: p.yaw, z: p.z,
    pitch: p.pitch, lean: p.lean, slip: p.slip,
    airTicks: p.airTicks, crashTicks: p.crashTicks,
    trickKind: p.trickKind, trickSpin: p.trickSpin,
    boosting: p.boosting,
    place: p.place,
    isLocal: p.identity.toHexString() === myHex(),
    fxKind: p.fxKind,
  };
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const cap = getGraphics().fpsCap;
  if (cap > 0 && now - lastFrameAt < 1000 / cap - 1) return;
  if (lastFrameAt > 0) {
    fpsSamples.push(1000 / Math.max(1, now - lastFrameAt));
    if (fpsSamples.length > 30) fpsSamples.shift();
  }
  lastFrameAt = now;

  if (!subscribed) return;
  sendInput();

  const lobby = myLobby();
  const race = myRace();
  const me = myPlayer();

  // --- screen routing ------------------------------------------------------
  if (!lobby) {
    if (screenName !== 'menu' && screenName !== 'select') goTo('menu');
  } else if (race && race.state !== R_DONE) {
    if (screenName !== 'race') goTo('race');
  } else if (race && race.state === R_DONE) {
    if (resultsShownFor !== race.id) {
      resultsShownFor = race.id;
      playFinish();
    }
    if (screenName !== 'results') {
      renderResults(race);
      goTo('results');
    }
  } else if (isCupIntermission(lobby, race)) {
    // A cup leg that ends rolls straight into the next gate. Hold the
    // standings up for the intermission rather than blinking past them.
    const prev = lobbyRaces(lobby.id)
      .filter(r => r.state === R_DONE)
      .sort((a, b) => Number(b.id - a.id))[0];
    if (prev) {
      if (resultsShownFor !== prev.id) {
        resultsShownFor = prev.id;
        playFinish();
        renderResults(prev);
      }
      if (screenName !== 'results') goTo('results');
    }
  } else if (lobby.status === L_OPEN && screenName !== 'waiting') {
    goTo('waiting');
  }
  if (screenName === 'waiting') renderWaiting();
  if (screenName === 'menu') renderLobbyList();
  setTouchVisible(screenName === 'race');

  if (!race || !me) return;

  // --- the world -----------------------------------------------------------
  const riders = riderRows(race.id).map(toRenderRider);
  const scene: Scene = {
    courseId: race.courseId,
    seed: race.seed,
    riders,
    localKey: myHex(),
    chase: race.state === R_LIVE,
    freeCam: 0,
    now,
  };
  drawScene(scene);
  renderNameplates(riders);
  renderHud(race, me, riders);
  renderChat();

  const local = riders.find(r => r.isLocal);
  if (local) {
    const sg = courseFor(race).segs[Math.min(courseFor(race).segs.length - 1, Math.floor(local.s / 40))];
    updateRide(local.v, local.airTicks > 0, local.slip, sg ? 1 : 1);
    // One-shot sounds, driven off the server's fx flag.
    if (me.fxKind !== lastFx) {
      lastFx = me.fxKind;
      if (me.fxKind === FX_CRASH) {
        playCrash();
        $('crash-flash').classList.add('on');
        setTimeout(() => $('crash-flash').classList.remove('on'), 220);
      } else if (me.fxKind === FX_LAND_PERFECT) playLand(true);
      else if (me.fxKind === FX_KICKER) playHop();
      else if (me.fxKind === FX_BOOSTPAD) playBoost();
      else if (me.fxKind === FX_TRICK) {
        playTrick();
        flashTrick(`${TRICK_NAMES[me.trickKind] || 'TRICK'}!`);
      }
    }
  }
}

let courseCacheKey = '';
let courseCache: Course | null = null;
function courseFor(race: any): Course {
  const key = `${race.courseId}:${race.seed}`;
  if (key !== courseCacheKey || !courseCache) {
    courseCacheKey = key;
    courseCache = buildCourse(race.courseId, race.seed);
  }
  return courseCache;
}

function flashTrick(text: string) {
  const el = $('trick-text');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(trickTimer);
  trickTimer = window.setTimeout(() => el.classList.remove('show'), 1200);
}

function renderNameplates(riders: RenderRider[]) {
  const host = $('nameplates');
  const wanted = new Map(riders.filter(r => !r.isLocal).map(r => [r.key, r]));
  for (const el of [...host.children]) {
    if (!wanted.has((el as HTMLElement).dataset.k!)) el.remove();
  }
  for (const [key, r] of wanted) {
    let el = host.querySelector(`[data-k="${key}"]`) as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.className = 'nameplate';
      el.dataset.k = key;
      host.appendChild(el);
    }
    const p = riderScreenPos(key);
    if (!p) {
      el.style.display = 'none';
      continue;
    }
    el.style.display = 'block';
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.textContent = r.name;
  }
}

function renderHud(race: any, me: any, riders: RenderRider[]) {
  const order = [...riders].sort((a, b) => (b.place ? 1e9 - b.place : b.s) - (a.place ? 1e9 - a.place : a.s));
  const myIdx = order.findIndex(r => r.isLocal);
  const place = me.place || (myIdx >= 0 ? myIdx + 1 : 1);
  ($('pos-plate').querySelector('.p') as HTMLElement).textContent = String(place);
  ($('pos-plate').querySelector('.of') as HTMLElement).textContent = `/ ${riders.length}`;

  ($('clock-plate').querySelector('.t') as HTMLElement).textContent = raceClock(
    me.finishTicks || race.elapsed
  );
  const ahead = myIdx > 0 ? order[myIdx - 1] : null;
  const mine = order[myIdx];
  ($('clock-plate').querySelector('.gap') as HTMLElement).textContent = ahead && mine
    ? `${(ahead.s - mine.s).toFixed(0)} M TO ${ahead.name}`
    : myIdx === 0
      ? 'LEADING'
      : '';

  ($('speed-plate').querySelector('.v') as HTMLElement).textContent = String(kmh(me.v));
  const boostPct = (me.boost / BOOST_MAX) * 100;
  ($('boost-bar').firstElementChild as HTMLElement).style.width = `${boostPct}%`;
  $('boost-wrap').classList.toggle('full', me.boost >= BOOST_MAX * 0.98);

  // Standings tower
  const st = $('standings');
  st.innerHTML = order
    .slice(0, 8)
    .map((r, i) => {
      const gap = mine ? r.s - mine.s : 0;
      return `<div class="st-row${r.isLocal ? ' me' : ''}">
        <span class="n">${i + 1}</span><span>${r.name}</span>
        <span class="g">${r.place ? 'FIN' : `${gap >= 0 ? '+' : ''}${gap.toFixed(0)}m`}</span></div>`;
    })
    .join('');

  // Biome banner: announce the next environment as you drop into it.
  const c = courseFor(race);
  const seg = segmentAt(c, me.s);
  if (seg.biome !== lastBiome) {
    lastBiome = seg.biome;
    const b = $('biome-banner');
    b.textContent = BIOME_LOOK[seg.biome].name;
    b.classList.add('show');
    clearTimeout(biomeTimer);
    biomeTimer = window.setTimeout(() => b.classList.remove('show'), 2600);
  }

  // Countdown
  const cd = $('countdown');
  if (race.state === R_COUNTDOWN) {
    const secs = Math.ceil(race.startTicks / TICK_HZ);
    show(cd, true);
    cd.textContent = secs > 4 ? `NEXT HILL · ${secs - 3}` : secs > 0 ? String(secs) : 'GO!';
    if (secs !== lastCountdownBeep && secs <= 3) {
      lastCountdownBeep = secs;
      playBeep(secs === 0);
    }
  } else {
    show(cd, false);
    lastCountdownBeep = -1;
  }

  const fps = fpsSamples.length ? fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length : 0;
  $('gfx-fps').textContent = fps ? String(Math.round(fps)) : '—';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function onSubscribed() {
  show($('connecting'), false);
  adoptAccountName();
  renderAccountChip();
  renderSelect();
  const p = myPlayer();
  if (p && p.lobbyId !== 0n) {
    goTo(p.raceId !== 0n ? 'race' : 'waiting');
  } else if (pendingJoin) {
    const code = pendingJoin;
    pendingJoin = '';
    withName(() => joinByCode(code));
  } else if (!playerName()) {
    openNameModal(null);
  }
}

let pendingJoin = new URLSearchParams(location.search).get('lobby')?.toUpperCase() ?? '';

async function boot() {
  setRigProp(false); // the shared rig is a tennis rig: put the racket away
  initRenderer(canvas);
  requestAnimationFrame(frame);
  if (firebaseEnabled) {
    await initAuth();
    if (isEmailLinkReturn()) {
      await completeEmailLink(async () => prompt("CONFIRM YOUR EMAIL ADDRESS"));
    }
    onAuthChange(() => {
      renderAccountChip();
    });
  }
  await connect();
}
void boot();

// Touch devices need a gesture before audio is allowed to make a sound.
window.addEventListener('pointerdown', () => {
  initAudio();
  resumeAudio();
}, { once: true });
