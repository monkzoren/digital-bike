// The named hills. Ids and segment plans mirror COURSES in
// spacetimedb/src/index.ts — keep in sync. Names, blurbs and colours are
// presentation only and live here.
import { BIO_ALPINE, BIO_FOREST, BIO_CANYON, BIO_MUD, BIO_DUNES, BIO_VILLAGE } from './track';

export interface CourseInfo {
  id: number;
  name: string;
  where: string;
  desc: string;
  km: string;
  difficulty: number; // 0..2
  css: string;
}

export const COURSES: CourseInfo[] = [
  { id: 0, name: 'FIRST LIGHT', where: 'ALPINE · PINES', desc: 'WIDE SNOWFIELDS INTO THE TREES', km: '4.3 KM', difficulty: 0, css: '#9fd6ff' },
  { id: 1, name: 'RED SHALE', where: 'CANYON · MUD', desc: 'RALLY SWEEPERS, THEN THE WET', km: '4.8 KM', difficulty: 1, css: '#d2743c' },
  { id: 2, name: 'THE LONG WET', where: 'ALPINE · MUD · PINES', desc: 'SWITCHBACKS WITH NO GRIP LEFT', km: '5.3 KM', difficulty: 2, css: '#6f7f5a' },
  { id: 3, name: 'DUST DEVIL', where: 'CANYON · DUNES', desc: 'ROLLERS, WHOOPS AND OPEN SAND', km: '5.0 KM', difficulty: 1, css: '#e0b457' },
  { id: 4, name: 'SUMMIT TO SEA', where: 'THE WHOLE MOUNTAIN', desc: 'EVERY BIOME, TOP TO BOTTOM', km: '6.0 KM', difficulty: 2, css: '#b58cf0' },
];

// Biome presentation: names for the HUD banner, and the palette the renderer
// dresses each stretch of hill with.
export interface BiomeLook {
  name: string;
  /** The packed, rideable line. Distinct from the hillside on purpose: in
   *  snow especially, a corridor the same colour as its surroundings is
   *  invisible at 130 km/h. */
  track: number;
  track2: number;
  ground: number;
  ground2: number;
  rock: number;
  fog: number;
  sky: number;
  props: 'pine' | 'rock' | 'cactus' | 'none' | 'house' | 'boulder';
  propColor: number;
}

export const BIOME_LOOK: Record<number, BiomeLook> = {
  [BIO_ALPINE]: { name: 'ALPINE', track: 0xb9c9df, track2: 0xa8bbd6, ground: 0xeef4fb, ground2: 0xe2ebf6, rock: 0x8b97a8, fog: 0xdfeaf6, sky: 0x9cc6ee, props: 'rock', propColor: 0x8b97a8 },
  [BIO_FOREST]: { name: 'PINE FOREST', track: 0x8a6a44, track2: 0x7a5c3a, ground: 0x4d7a3a, ground2: 0x3d6430, rock: 0x6b6257, fog: 0xbfd2b0, sky: 0x86b8e0, props: 'pine', propColor: 0x1f4526 },
  [BIO_CANYON]: { name: 'RED CANYON', track: 0xd98f5c, track2: 0xc87e4c, ground: 0xa9552c, ground2: 0x97482a, rock: 0x8a4326, fog: 0xe7c3a0, sky: 0xf0b98a, props: 'boulder', propColor: 0x8a4326 },
  [BIO_MUD]: { name: 'THE WET', track: 0x4a3a28, track2: 0x3d2f1f, ground: 0x5a6a42, ground2: 0x4c5a38, rock: 0x4a4238, fog: 0x94968c, sky: 0x7b8390, props: 'pine', propColor: 0x2c3a26 },
  [BIO_DUNES]: { name: 'DUNES', track: 0xd9b163, track2: 0xcaa254, ground: 0xe8cd88, ground2: 0xdfc079, rock: 0xb08b49, fog: 0xf0dcae, sky: 0xf3cf93, props: 'cactus', propColor: 0x4f7a45 },
  [BIO_VILLAGE]: { name: 'THE VILLAGE', track: 0x5d5a57, track2: 0x66635f, ground: 0x8d8a86, ground2: 0x77736f, rock: 0x6a655f, fog: 0xd8d6d0, sky: 0x9ec8e8, props: 'house', propColor: 0xb8674a },
};
