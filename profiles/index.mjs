// ---------------------------------------------------------------------------
// Digital Bike profile service.
//
// SpacetimeDB is the GAME ENGINE and is expected to be wiped — a breaking
// schema change, a fresh deploy, a deliberate reset. Player progression must
// not die with it. This service keeps a SQLite copy of the `account` table and
// seeds it back afterwards.
//
// Direction is decided per row by `rev`, a counter the module bumps on every
// change worth keeping:
//   stdb.rev > sqlite.rev  ->  a match was played; store it
//   sqlite.rev > stdb.rev  ->  this database was wiped or is behind; restore it
// Ties do nothing, so a steady state is silent.
//
// SpacetimeDB stays the authority that COMPUTES progression — awardProgression
// runs inside a reducer where no client can reach it. This service never
// invents a rating, it only moves rows. And it only works at all because a
// Firebase identity is stable across a wipe: the restore is keyed on it.
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs';
import { mintToken } from './mint-token.mjs';
import { Stdb } from './stdb.mjs';
import { Store, COLUMNS } from './store.mjs';

const URL_ = process.env.SPACETIMEDB_URL ?? 'http://spacetimedb:3000';
const DB_NAME = process.env.DATABASE_NAME ?? 'digital-bike';
const DB_PATH = process.env.PROFILES_DB ?? '/data/profiles.db';
const SERVER_KEY = process.env.SERVER_KEY ?? '/stdb/keys/id_ecdsa';
const POLL_MS = Number(process.env.POLL_MS ?? 5000);
// Must match PROFILE_SERVICE_ISSUER in spacetimedb/src/index.ts.
const ISSUER = 'digital-bike-profiles';

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function waitForServer() {
  for (;;) {
    try {
      const res = await fetch(`${URL_}/v1/ping`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(2000);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForKey() {
  for (let i = 0; !existsSync(SERVER_KEY) && i < 30; i++) await sleep(1000);
  if (!existsSync(SERVER_KEY)) {
    throw new Error(
      `server signing key not found at ${SERVER_KEY} — the spacetimedb service ` +
        `needs --jwt-priv-key-path pointing into the shared volume (see docker-compose.yml)`
    );
  }
}

/** One pass: store what is newer in the engine, restore what is newer on file. */
function syncOnce(store, live) {
  const stored = new Map(store.all().map(r => [r.identity, r]));
  const pushes = [];
  const seen = new Set();
  let saved = 0;

  for (const row of live) {
    const id = row.identity;
    seen.add(id);
    const mine = stored.get(id);
    const rev = row.rev ?? 0;
    if (!mine || rev > mine.rev) {
      store.put({ identity: id, ...pick(row) });
      saved++;
    } else if (mine.rev > rev) {
      pushes.push(mine); // engine is behind — usually a wipe it has partly refilled
    }
  }
  // On file but absent from the engine entirely: a wipe, or a player who has
  // not reconnected since one. Seed them so their profile is already there
  // when they do.
  for (const [id, mine] of stored) if (!seen.has(id)) pushes.push(mine);
  return { saved, pushes };
}

const pick = row => Object.fromEntries(COLUMNS.map(c => [c, row[c] ?? 0]));

async function main() {
  log(`profile service starting — db=${DB_NAME} at ${URL_}, store=${DB_PATH}`);
  await waitForServer();
  await waitForKey();
  const token = mintToken(SERVER_KEY, ISSUER, DB_NAME);
  const stdb = new Stdb({ url: URL_, dbName: DB_NAME, token });
  const store = new Store(DB_PATH);
  log(`ready — ${store.count()} profile(s) on file`);

  let lastError = '';
  for (;;) {
    try {
      const live = await stdb.sql('SELECT * FROM account');
      const { saved, pushes } = syncOnce(store, live);
      let restored = 0;
      for (const p of pushes) {
        try {
          await stdb.call('restore_account', {
            // t.identity() over the JSON API is the product form, not a bare
            // hex string — a bare string is rejected as "invalid type".
            identity: { __identity__: p.identity },
            ...pick(p),
          });
          restored++;
        } catch (err) {
          log(`restore failed for ${p.identity.slice(0, 12)}…:`, String(err).slice(0, 200));
        }
      }
      if (saved || restored) log(`stored ${saved}, restored ${restored}`);
      lastError = '';
    } catch (err) {
      // Don't spam an unreachable database; log a repeat only when it changes.
      const msg = String(err).slice(0, 300);
      if (msg !== lastError) { log('sync error:', msg); lastError = msg; }
    }
    await sleep(POLL_MS);
  }
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
