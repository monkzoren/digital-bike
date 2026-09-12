// Default SpacetimeDB address:
// - Vite dev server (any port): SpacetimeDB runs separately on :3000.
// - Anything else (the nginx container, any deployment): SAME ORIGIN —
//   nginx proxies /v1 to SpacetimeDB, so one domain/port serves everything
//   and wss works automatically behind any TLS proxy.
const defaultUri = (import.meta as any).env?.DEV
  ? `ws://${location.hostname}:3000`
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
// A localhost URI can never work for remote visitors (it points at THEIR
// machine). If the page isn't served from localhost, ignore such a value.
const envUri: string | undefined = (import.meta as any).env?.VITE_SPACETIMEDB_URI;
const pageIsLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const envPointsLocal = !!envUri && /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(envUri);
const usableEnvUri = envUri && !(envPointsLocal && !pageIsLocal) ? envUri : undefined;
if (envUri && !usableEnvUri) {
  console.warn(
    `[db] Ignoring VITE_SPACETIMEDB_URI="${envUri}" (localhost is unreachable for remote players); using same-origin instead.`
  );
}
export const SPACETIMEDB_URI = usableEnvUri ?? defaultUri;
export const DATABASE_NAME =
  (import.meta as any).env?.VITE_DATABASE_NAME ?? 'digital-bike';

// Simulation tick rate — must mirror TICK_HZ in spacetimedb/src/index.ts.
export const TICK_HZ = 30;

// ---------------------------------------------------------------------------
// Physics constants the CLIENT needs: extrapolation between ticks, the HUD,
// and the shape of the boost meter. The authority is the module — mirror any
// change (see the block of the same name in spacetimedb/src/index.ts).
// ---------------------------------------------------------------------------
export const G = 22;
export const BASE_TOP = 40; // m/s before stats
export const BOOST_MAX = 1000;
export const BOOST_TOP = 9;
export const CRASH_TICKS = Math.round(1.4 * TICK_HZ);
export const MAX_RIDERS = 8;
export const CUP_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

// Buttons — the bitmask set_input takes.
export const BTN_HOP = 1;
export const BTN_TRICK = 2;
export const BTN_BOOST = 4;

// One-shot visual cues (player.fxKind).
export const FX_NONE = 0;
export const FX_CRASH = 1;
export const FX_LAND_PERFECT = 2;
export const FX_LAND_OK = 3;
export const FX_TRICK = 4;
export const FX_BOOSTPAD = 5;
export const FX_KICKER = 6;

export const TRICK_NAMES = ['', 'WHIP', 'FLIP', 'SUPERMAN', 'TAILWHIP'];

// Room modes / states — mirror the module.
export const M_RACE = 0;
export const M_CUP = 1;
export const L_OPEN = 0;
export const L_RUNNING = 1;
export const L_FINISHED = 2;
export const R_COUNTDOWN = 0;
export const R_LIVE = 1;
export const R_DONE = 2;

// ---------------------------------------------------------------------------
// Progression — must mirror spacetimedb/src/index.ts.
// ---------------------------------------------------------------------------
export const MMR_START = 1000;
const LEVEL_BASE = 200;
const LEVEL_STEP = 100;
export const LEVEL_MAX = 99;
export const totalXpFor = (level: number) =>
  ((level - 1) * (2 * LEVEL_BASE + LEVEL_STEP * (level - 2))) / 2;
export const levelFor = (xp: number) => {
  let lvl = 1;
  while (lvl < LEVEL_MAX && totalXpFor(lvl + 1) <= xp) lvl++;
  return lvl;
};

// Race end reasons (race_log.endedBy)
export const END_FINISHED = 0;
export const END_DNF = 1;
export const END_QUIT = 2;

export const kmh = (v: number) => Math.round(v * 3.6);
export const raceClock = (ticks: number) => {
  const total = ticks / TICK_HZ;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};
