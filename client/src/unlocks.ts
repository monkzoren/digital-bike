// Unlock tables — a MIRROR of CHAR_UNLOCKS / BIKE_UNLOCKS / COURSE_UNLOCKS in
// spacetimedb/src/index.ts. Keep in sync: the server enforces, this only
// explains. Unlocked-ness is DERIVED from account counters and never stored.
import { CHARACTERS } from './characters';
import { BIKES } from './bikes';
import { COURSES } from './courses';

export const U_LEVEL = 0;
export const U_RACES = 1;
export const U_WINS = 2;
export const U_PODIUMS = 3;
export const U_BOT_WINS = 4;
export const U_TRICKS = 5;
export const U_TOPSPEED = 6;
export const U_CUP_WINS = 7;
export const U_COURSE_WIN = 8;

export interface UnlockCond { kind: number; n: number }

export const CHAR_UNLOCKS: (UnlockCond | null)[] = [
  null, null, null, null, null, null,
  { kind: U_RACES, n: 5 },
  { kind: U_BOT_WINS, n: 3 },
  { kind: U_LEVEL, n: 4 },
  { kind: U_PODIUMS, n: 6 },
  { kind: U_TRICKS, n: 25 },
  { kind: U_WINS, n: 5 },
  { kind: U_TOPSPEED, n: 150 },
  { kind: U_RACES, n: 25 },
  { kind: U_TRICKS, n: 60 },
  { kind: U_LEVEL, n: 10 },
  { kind: U_COURSE_WIN, n: 3 },
  { kind: U_CUP_WINS, n: 1 },
];
export const BIKE_UNLOCKS: (UnlockCond | null)[] = [
  null,
  { kind: U_RACES, n: 3 },
  { kind: U_PODIUMS, n: 3 },
  { kind: U_TRICKS, n: 15 },
  { kind: U_LEVEL, n: 6 },
  { kind: U_WINS, n: 8 },
];
export const COURSE_UNLOCKS: (UnlockCond | null)[] = [
  null,
  { kind: U_RACES, n: 2 },
  { kind: U_WINS, n: 3 },
  { kind: U_PODIUMS, n: 8 },
  { kind: U_CUP_WINS, n: 1 },
];

// The account fields the conditions read. Anything missing counts as zero, so
// a signed-out visitor simply sees everything locked but browsable.
export interface UnlockStats {
  level: number;
  races: number;
  wins: number;
  podiums: number;
  botWins: number;
  tricks: number;
  topSpeed: number;
  cupWins: number;
  courseWins: number;
}
export const ZERO_STATS: UnlockStats = {
  level: 1, races: 0, wins: 0, podiums: 0, botWins: 0,
  tricks: 0, topSpeed: 0, cupWins: 0, courseWins: 0,
};

function progress(s: UnlockStats, c: UnlockCond): { have: number; need: number } {
  switch (c.kind) {
    case U_LEVEL: return { have: s.level, need: c.n };
    case U_RACES: return { have: s.races, need: c.n };
    case U_WINS: return { have: s.wins, need: c.n };
    case U_PODIUMS: return { have: s.podiums, need: c.n };
    case U_BOT_WINS: return { have: s.botWins, need: c.n };
    case U_TRICKS: return { have: s.tricks, need: c.n };
    case U_TOPSPEED: return { have: s.topSpeed, need: c.n };
    case U_CUP_WINS: return { have: s.cupWins, need: c.n };
    case U_COURSE_WIN: return { have: (s.courseWins & (1 << c.n)) !== 0 ? 1 : 0, need: 1 };
    default: return { have: 0, need: 1 };
  }
}

export function condMet(s: UnlockStats, c: UnlockCond): boolean {
  const p = progress(s, c);
  return p.have >= p.need;
}

export function condLabel(c: UnlockCond): string {
  switch (c.kind) {
    case U_LEVEL: return `REACH LEVEL ${c.n}`;
    case U_RACES: return `FINISH ${c.n} RACES`;
    case U_WINS: return `WIN ${c.n} RACES`;
    case U_PODIUMS: return `${c.n} PODIUMS`;
    case U_BOT_WINS: return `BEAT THE BOTS ${c.n}×`;
    case U_TRICKS: return `LAND ${c.n} TRICKS`;
    case U_TOPSPEED: return `HIT ${c.n} KM/H`;
    case U_CUP_WINS: return `WIN A CUP`;
    case U_COURSE_WIN: return `WIN ON ${COURSES[c.n]?.name ?? 'A HILL'}`;
    default: return 'LOCKED';
  }
}

export function lockText(s: UnlockStats, c: UnlockCond): string {
  const p = progress(s, c);
  if (c.kind === U_COURSE_WIN || c.kind === U_CUP_WINS) return condLabel(c);
  return `${condLabel(c)} (${Math.min(p.have, p.need)}/${p.need})`;
}

const open = (gates: (UnlockCond | null)[], id: number, s: UnlockStats) => {
  const c = gates[id];
  return c === null || (c !== undefined && condMet(s, c));
};
export const charUnlocked = (s: UnlockStats, id: number) => open(CHAR_UNLOCKS, id, s);
export const bikeUnlocked = (s: UnlockStats, id: number) => open(BIKE_UNLOCKS, id, s);
export const courseUnlocked = (s: UnlockStats, id: number) => open(COURSE_UNLOCKS, id, s);

// Everything that just came open, for the unlock toast.
export function newlyUnlocked(before: UnlockStats, after: UnlockStats): string[] {
  const out: string[] = [];
  CHARACTERS.forEach((c, i) => {
    if (!charUnlocked(before, i) && charUnlocked(after, i)) out.push(`${c.name} UNLOCKED`);
  });
  BIKES.forEach((b, i) => {
    if (!bikeUnlocked(before, i) && bikeUnlocked(after, i)) out.push(`${b.name} BIKE UNLOCKED`);
  });
  COURSES.forEach((c, i) => {
    if (!courseUnlocked(before, i) && courseUnlocked(after, i)) out.push(`${c.name} UNLOCKED`);
  });
  return out;
}
