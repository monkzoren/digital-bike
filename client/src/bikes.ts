// Bikes and per-character riding stats. The authoritative multipliers live in
// spacetimedb/src/index.ts (BIKES / CHAR_RIDE, same order) — this is the
// presentation copy plus the pip display. Keep the two in sync.
//
// NOTE: client/src/characters.ts is a VERBATIM copy of the Digital Tennis
// roster file and must stay that way (the same person has to look the same in
// every Digital game), which is why the bike numbers live here instead.
export interface RideStats {
  top: number;
  accel: number;
  grip: number;
  air: number;
  weight: number;
}

export const STAT_LABELS: [keyof RideStats, string][] = [
  ['top', 'TOP'],
  ['accel', 'ACC'],
  ['grip', 'GRIP'],
  ['air', 'AIR'],
  ['weight', 'WGT'],
];

// Same order/ids as CHARACTERS in characters.ts.
export const CHAR_RIDE: RideStats[] = [
  { top: 1.06, accel: 1.04, grip: 0.94, air: 0.96, weight: 1.06 }, // BLAZE
  { top: 0.98, accel: 0.98, grip: 1.08, air: 1.02, weight: 0.98 }, // VOLT
  { top: 1.02, accel: 1.10, grip: 1.02, air: 1.04, weight: 0.92 }, // KAI
  { top: 1.00, accel: 0.98, grip: 1.10, air: 0.96, weight: 1.00 }, // ROSA
  { top: 1.00, accel: 1.00, grip: 1.00, air: 1.00, weight: 1.00 }, // VIPER
  { top: 0.96, accel: 1.00, grip: 0.98, air: 1.12, weight: 0.94 }, // LUNA
  { top: 0.94, accel: 1.02, grip: 0.88, air: 1.10, weight: 0.88 }, // PEELS
  { top: 1.00, accel: 1.10, grip: 1.06, air: 0.92, weight: 0.86 }, // BISCUIT
  { top: 1.08, accel: 0.94, grip: 1.00, air: 0.94, weight: 1.14 }, // SERVO
  { top: 0.98, accel: 1.02, grip: 1.04, air: 1.06, weight: 0.90 }, // ZORP
  { top: 1.06, accel: 1.00, grip: 0.96, air: 1.02, weight: 1.04 }, // SMASHULA
  { top: 1.10, accel: 0.92, grip: 0.94, air: 0.92, weight: 1.18 }, // PLANK
  { top: 1.04, accel: 0.90, grip: 1.02, air: 0.90, weight: 1.24 }, // YETI
  { top: 0.92, accel: 0.96, grip: 1.12, air: 0.90, weight: 0.94 }, // GRANNY
  { top: 1.00, accel: 1.06, grip: 1.00, air: 1.08, weight: 0.96 }, // DISCO
  { top: 0.96, accel: 1.00, grip: 1.10, air: 1.00, weight: 0.98 }, // INKY
  { top: 0.98, accel: 0.98, grip: 1.06, air: 0.98, weight: 1.02 }, // PRICKLES
  { top: 0.96, accel: 1.04, grip: 0.98, air: 1.10, weight: 0.92 }, // MYSTO
];

export interface Bike {
  id: number;
  name: string;
  desc: string;
  css: string; // frame colour
  accent: string;
  knobby: boolean; // fat off-road tyres
  stats: RideStats;
}

export const BIKES: Bike[] = [
  { id: 0, name: 'TRAIL', desc: 'DOES EVERYTHING WELL', css: '#3aa7d8', accent: '#12303f', knobby: true,
    stats: { top: 1.00, accel: 1.00, grip: 1.00, air: 1.00, weight: 1.00 } },
  { id: 1, name: 'DOWNHILL', desc: 'FAST, HEAVY, PLANTED', css: '#d8452e', accent: '#2a0f0a', knobby: true,
    stats: { top: 1.12, accel: 0.90, grip: 1.06, air: 0.94, weight: 1.16 } },
  { id: 2, name: 'DIRT', desc: 'SNAPPY OFF THE LIP', css: '#e8a220', accent: '#3a2506', knobby: true,
    stats: { top: 1.02, accel: 1.10, grip: 0.96, air: 1.10, weight: 0.96 } },
  { id: 3, name: 'BMX', desc: 'TRICK MACHINE, LOW TOP END', css: '#b44bd8', accent: '#2c0f36', knobby: false,
    stats: { top: 0.88, accel: 1.14, grip: 0.94, air: 1.22, weight: 0.82 } },
  { id: 4, name: 'FAT', desc: 'GRIP ANYWHERE, SLOW TO SPIN UP', css: '#4ec06a', accent: '#10301a', knobby: true,
    stats: { top: 0.92, accel: 0.96, grip: 1.18, air: 0.90, weight: 1.20 } },
  { id: 5, name: 'RALLY', desc: 'BUILT TO SLIDE', css: '#f0f0f0', accent: '#1c1c22', knobby: true,
    stats: { top: 1.06, accel: 1.02, grip: 0.86, air: 1.00, weight: 1.02 } },
];

const NEUTRAL: RideStats = { top: 1, accel: 1, grip: 1, air: 1, weight: 1 };

// Final rider = character × bike. Mirrors rideStats() in the module.
export function rideStats(characterId: number, bikeId: number): RideStats {
  const c = CHAR_RIDE[characterId] ?? NEUTRAL;
  const b = BIKES[bikeId]?.stats ?? NEUTRAL;
  return {
    top: c.top * b.top,
    accel: c.accel * b.accel,
    grip: c.grip * b.grip,
    air: c.air * b.air,
    weight: c.weight * b.weight,
  };
}

// 1..5 pips for the select screens: a multiplier of 1.0 is three pips.
export function pips(mul: number): number {
  if (mul >= 1.12) return 5;
  if (mul >= 1.04) return 4;
  if (mul >= 0.97) return 3;
  if (mul >= 0.9) return 2;
  return 1;
}
